"""Comfy Router client for the Studio test console. Standard library only.

The API key is read on the server (COMFY_API_KEY in the environment or in a
.env file next to this script) and is never sent to the browser.
Requests use queued delivery: submit, follow the status route, collect.
"""
import json
import os
import re
import secrets
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


# ---------- Queued delivery lifecycle ----------

def submit_request(model, payload, idempotency_key, log):
    """Queue one generation and return where to follow it."""
    body = submit(model, payload, idempotency_key, log)
    request_id = body.get('request_id') or body.get('id')
    if not request_id:
        raise RouterError(0, body, 'Router accepted the request but returned no request_id.')
    base = f'{BASE}/v2/models/{model}/requests/{request_id}'
    return {
        'request_id': request_id,
        'status': body.get('status') or 'IN_QUEUE',
        'status_url': find_url(body, 'status') or base + '/status',
        'response_url': find_url(body, 'response', 'result') or base,
    }


def failure(body):
    return f'{body["error_type"]}: {body.get("error") or body.get("message") or "the model did not finish."}'


def follow(status_url, on_status, log, limit=30 * 60):
    """Poll the status route until COMPLETED, honouring Retry-After.
    COMPLETED is the only terminal status; error_type says whether it failed."""
    deadline = time.time() + limit
    last = None
    while time.time() < deadline:
        status, headers, body = request('GET', status_url)
        if status != 200 or not isinstance(body, dict):
            log('status', status, body)
            if status in RETRYABLE or status >= 500:
                time.sleep(retry_after(headers, 5))
                continue
            raise RouterError(status, body)
        if body.get('status') != last:
            last = body.get('status')
            log('status', status, body)
            on_status(last)
        if last == 'COMPLETED':
            if body.get('error_type'):
                raise RouterError(status, body, failure(body))
            return body
        time.sleep(retry_after(headers, 3))
    raise RouterError(0, None, 'Stopped following after 30 minutes. The request may still finish on Router.')


def collect(response_url, log):
    """Fetch the finished output: 200 with the output, 202 while it is still running."""
    while True:
        status, headers, body = request('GET', response_url)
        log('collect', status, body)
        if status == 202:
            time.sleep(retry_after(headers, 3))
            continue
        if status != 200:
            raise RouterError(status, body)
        if isinstance(body, dict) and body.get('error_type'):
            raise RouterError(status, body, failure(body))
        return body


# ---------- Mapping the Studio's inputs onto a model schema ----------

def resolve(doc, node, depth=0):
    """Resolve $ref, allOf and anyOf/oneOf (first non-null option) in an OpenAPI schema."""
    if not isinstance(node, dict) or depth > 12:
        return node or {}
    if '$ref' in node:
        target = doc
        for part in node['$ref'].lstrip('#/').split('/'):
            target = target.get(part.replace('~1', '/').replace('~0', '~'), {})
        extra = {k: v for k, v in node.items() if k != '$ref'}
        return resolve(doc, {**target, **extra}, depth + 1)
    if 'allOf' in node:
        merged = {k: v for k, v in node.items() if k != 'allOf'}
        merged.setdefault('properties', {})
        merged.setdefault('required', [])
        for part in (resolve(doc, p, depth + 1) for p in node['allOf']):
            merged['properties'].update(part.get('properties', {}))
            merged['required'] += part.get('required', [])
            for key in ('type', 'description'):
                merged.setdefault(key, part.get(key))
        return merged
    for key in ('anyOf', 'oneOf'):
        if key in node:
            options = [resolve(doc, v, depth + 1) for v in node[key]]
            options = [v for v in options if v.get('type') != 'null'] or options
            rest = {k: v for k, v in node.items() if k != key}
            return {**(options[0] if options else {}), **rest}
    return node


def type_of(prop):
    kind = prop.get('type')
    if isinstance(kind, list):
        kind = next((k for k in kind if k != 'null'), 'string')
    return kind or ('object' if 'properties' in prop else 'string')


def request_properties(doc):
    operations = [(path, item['post']) for path, item in doc.get('paths', {}).items()
                  if isinstance(item, dict) and item.get('post', {}).get('requestBody')]
    if not operations:
        raise ValueError('The model schema has no POST request body.')
    _, operation = next((op for op in operations if not op[0].endswith('/requests')), operations[0])
    content = resolve(doc, operation['requestBody']).get('content', {})
    media = content.get('application/json') or next(iter(content.values()), {})
    schema = resolve(doc, media.get('schema', {}))
    props = {name: resolve(doc, prop) for name, prop in schema.get('properties', {}).items()}
    return props, schema.get('required', [])


def dimensions(text):
    match = re.match(r'^\s*(\d+)\s*[x*×:]\s*(\d+)\s*$', str(text))
    return (int(match.group(1)), int(match.group(2))) if match else None


def closest(options, width, height):
    """The option whose shape is nearest the target ratio, then nearest in area."""
    target = width / height
    sized = [(option, dimensions(option)) for option in options]
    sized = [(option, size) for option, size in sized if size and size[1]]
    if not sized:
        return None
    return min(sized, key=lambda item: (abs(item[1][0] / item[1][1] - target), abs(item[1][0] * item[1][1] - width * height)))[0]


def studio_plan(doc):
    """Decide where the Studio's prompt, photo, size and seed go in this model's inputs.
    Raises ValueError naming what could not be matched, so nothing is sent blind."""
    props, required = request_properties(doc)
    strings = [n for n, p in props.items() if type_of(p) == 'string']
    plan = {'prompt': None, 'negative': None, 'image': None, 'image_list': False,
            'width': None, 'height': None, 'size': None, 'aspect': None, 'seed': None}

    plan['prompt'] = 'prompt' if 'prompt' in strings else next(
        (n for n in strings if 'prompt' in n.lower() and 'negative' not in n.lower()), None)
    plan['negative'] = next((n for n in strings if 'negative' in n.lower()), None)

    for name, prop in props.items():
        if not re.search(r'image|photo|reference', name, re.I) or re.search(r'size|format|count|num', name, re.I):
            continue
        if type_of(prop) == 'string':
            plan['image'] = name
            break
        if type_of(prop) == 'array' and type_of(resolve(doc, prop.get('items', {}))) == 'string':
            plan['image'], plan['image_list'] = name, True
            break

    if type_of(props.get('width', {'type': 'x'})) == 'integer' and type_of(props.get('height', {'type': 'x'})) == 'integer':
        plan['width'], plan['height'] = 'width', 'height'
    else:
        for name, prop in props.items():
            options = prop.get('enum') or []
            if re.search(r'aspect', name, re.I) and any(dimensions(o) for o in options):
                plan['aspect'] = name
            elif re.search(r'size|resolution|dimension', name, re.I) and any(dimensions(o) for o in options):
                plan['size'] = name
    plan['seed'] = 'seed' if type_of(props.get('seed', {})) == 'integer' and 'seed' in props else None

    problems = []
    if not plan['prompt']:
        problems.append('no text prompt input')
    if not plan['image']:
        problems.append('no reference image input that takes a URL or data URI')
    used = {plan[k] for k in ('prompt', 'negative', 'image', 'width', 'height', 'size', 'aspect', 'seed') if plan[k]}
    missing = [n for n in required if n not in used and 'default' not in props[n]] if required else []
    if missing:
        problems.append('required inputs the studio does not fill: ' + ', '.join(missing))
    if problems:
        raise ValueError('This model does not fit the studio: ' + '; '.join(problems) +
                         '. Try it in the Router test console to see its inputs.')
    plan['props'] = props
    return plan


def studio_payload(plan, prompt, negative, photo_uri, width, height):
    props = plan['props']
    payload = {plan['prompt']: prompt}
    if plan['negative'] and negative:
        payload[plan['negative']] = negative
    payload[plan['image']] = [photo_uri] if plan['image_list'] else photo_uri
    if plan['width']:
        for key, value in ((plan['width'], width), (plan['height'], height)):
            prop = props[key]
            payload[key] = max(prop.get('minimum', value), min(prop.get('maximum', value), value))
    elif plan['size'] or plan['aspect']:
        key = plan['size'] or plan['aspect']
        choice = closest(props[key]['enum'], width, height)
        if choice is not None:
            payload[key] = choice
    if plan['seed']:
        prop = props[plan['seed']]
        low, high = int(prop.get('minimum', 0)), int(min(prop.get('maximum', 2 ** 31 - 1), 2 ** 31 - 1))
        payload[plan['seed']] = low + secrets.randbelow(max(1, high - low))
    return payload


def describe_plan(plan):
    parts = [f'prompt → {plan["prompt"]}', f'photo → {plan["image"]}' + ('[0]' if plan['image_list'] else '')]
    if plan['negative']:
        parts.append(f'negative → {plan["negative"]}')
    if plan['width']:
        parts.append('size → width/height')
    elif plan['size'] or plan['aspect']:
        parts.append(f'size → nearest {plan["size"] or plan["aspect"]} option')
    else:
        parts.append('size → chosen by the model')
    if plan['seed']:
        parts.append('seed → random')
    return ', '.join(parts)
