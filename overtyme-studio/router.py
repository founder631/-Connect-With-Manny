"""Comfy Router client for the Studio test console. Standard library only.

The API key is read on the server (COMFY_API_KEY in the environment or in a
.env file next to this script) and is never sent to the browser.
Requests use queued delivery: submit, follow the status route, collect.
"""
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASE = 'https://api.comfy.org'
MODEL_ID = re.compile(r'^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$')
RETRYABLE = {409, 429, 504}
MAX_RETRIES = 5


class RouterError(Exception):
    def __init__(self, status, body, message=None):
        self.status, self.body = status, body
        super().__init__(message or describe_error(status, body))


def api_key():
    key = os.environ.get('COMFY_API_KEY', '').strip()
    env = ROOT / '.env'
    if not key and env.exists():
        for line in env.read_text().splitlines():
            name, _, value = line.partition('=')
            if name.strip() == 'COMFY_API_KEY':
                key = value.strip().strip('"\'')
    return key


def describe_error(status, body):
    if isinstance(body, dict):
        if isinstance(body.get('detail'), list):
            parts = []
            for item in body['detail']:
                where = '.'.join(str(p) for p in item.get('loc', []) if p != 'body')
                parts.append((where + ': ' if where else '') + str(item.get('msg', item)))
            return 'Router rejected the input (422): ' + '; '.join(parts)
        for key in ('message', 'error', 'detail', 'error_type'):
            if isinstance(body.get(key), str):
                return f'Router answered {status}: {body[key]}'
    return f'Router answered {status}.'


def check_model(model):
    if not MODEL_ID.match(model or ''):
        raise ValueError('Model must look like provider/model, for example qwen/qwen-image-3.0-pro.')
    return model


def request(method, url, body=None, idempotency_key=None):
    """One HTTP call. Returns (status, headers, parsed body or raw bytes)."""
    if not url.startswith(BASE + '/'):
        raise ValueError('Refusing to send the API key outside ' + BASE)
    key = api_key()
    if not key:
        raise RouterError(0, None, 'COMFY_API_KEY is not set. Add it to overtyme-studio/.env.')
    headers = {'X-API-Key': key, 'Accept': 'application/json'}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    if idempotency_key:
        headers['Idempotency-Key'] = idempotency_key
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            status, resp_headers, raw = response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        status, resp_headers, raw = error.code, dict(error.headers), error.read()
    try:
        parsed = json.loads(raw) if raw else None
    except ValueError:
        parsed = raw.decode('utf-8', 'replace')[:2000]
    return status, resp_headers, parsed


def retry_after(headers, default=2.0):
    value = (headers or {}).get('Retry-After')
    try:
        return max(0.5, min(float(value), 60.0))
    except (TypeError, ValueError):
        return default


def schema(model):
    status, _, body = request('GET', f'{BASE}/v2/models/{check_model(model)}/openapi.json')
    if status != 200 or not isinstance(body, dict):
        raise RouterError(status, body)
    return body


def submit(model, payload, idempotency_key, log):
    """Queue one generation. Retries 409/429/504 with the SAME Idempotency-Key."""
    url = f'{BASE}/v2/models/{check_model(model)}/requests'
    for attempt in range(MAX_RETRIES + 1):
        status, headers, body = request('POST', url, payload, idempotency_key)
        log('submit', status, body)
        if status in (200, 201, 202) and isinstance(body, dict):
            return body
        if status in RETRYABLE and attempt < MAX_RETRIES:
            wait = retry_after(headers)
            log('retry', status, {'wait_seconds': wait, 'idempotency_key': 'reused'})
            time.sleep(wait)
            continue
        raise RouterError(status, body)


def find_url(body, *words):
    """Pick a follow-up URL from the submit response (e.g. status_url / response_url)."""
    if not isinstance(body, dict):
        return None
    for key, value in body.items():
        if isinstance(value, str) and value.startswith(('http', '/')) and any(w in key.lower() for w in words):
            return value if value.startswith('http') else BASE + value
    for value in body.values():
        if isinstance(value, dict):
            found = find_url(value, *words)
            if found:
                return found
    return None


def asset_urls(value, found=None):
    """Every http(s) URL in a model output, in order."""
    found = [] if found is None else found
    if isinstance(value, str) and re.match(r'^https?://', value):
        found.append(value)
    elif isinstance(value, dict):
        for item in value.values():
            asset_urls(item, found)
    elif isinstance(value, list):
        for item in value:
            asset_urls(item, found)
    return found


def download(url):
    """Fetch a result asset. Asset URLs expire, so this runs as soon as a job completes.
    Assets are usually served from a CDN, so the API key is not sent with them."""
    req = urllib.request.Request(url, headers={'User-Agent': 'OverTymeStudio/1.0'})
    with urllib.request.urlopen(req, timeout=120) as response:
        return response.read(), response.headers.get('Content-Type', '')


def new_idempotency_key():
    return 'overtyme-' + uuid.uuid4().hex
