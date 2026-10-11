#!/usr/bin/env python3
"""OverTyme Studio - a browser front end for the One Image Packs.

Runs a small web server next to your local ComfyUI (http://127.0.0.1:8188).
The client opens the page, picks a photo, a pack and a scene, presses
Generate, and watches the finished image appear. Nothing goes to the cloud.

Usage:
    python3 studio.py                # open the studio at http://127.0.0.1:8790
    python3 studio.py --share        # also let phones/laptops on your Wi-Fi open it
    python3 studio.py --comfy http://127.0.0.1:8188

Only the Python standard library is used - nothing to install.
"""

import argparse
import base64
import json
import mimetypes
import re
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import router
import studio_runtime as comfy

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / 'static'
RESULTS = ROOT / 'Results'
JOBS_FILE = RESULTS / 'jobs.json'
CATALOG = json.loads((ROOT / 'catalog.json').read_text())
SCENES = {entry['id']: entry for entry in CATALOG}
BOILERPLATE = re.compile(
    r"^Keep the subject's face, hair, gender and natural features exactly as in the photo\.\s*"
    r"|\s*Ultra detailed, sharp focus.*$")
MAX_BODY = 15 * 1024 * 1024

jobs = {}
jobs_lock = threading.Lock()
submit_lock = threading.Lock()
checked_workflows = set()


def default_photo():
    for name in ('reference.png', 'reference.jpg', 'reference.jpeg', 'reference.webp'):
        if (ROOT / name).is_file():
            return ROOT / name
    return None


def load_jobs():
    if JOBS_FILE.exists():
        try:
            jobs.update({job['id']: job for job in json.loads(JOBS_FILE.read_text())})
        except (ValueError, KeyError):
            pass


def save_jobs():
    RESULTS.mkdir(parents=True, exist_ok=True)
    temp = RESULTS / 'jobs.tmp'
    temp.write_text(json.dumps(sorted(jobs.values(), key=lambda job: job['created']), indent=2))
    temp.replace(JOBS_FILE)


def public_job(job):
    return {key: job.get(key) for key in (
        'id', 'scene', 'pack', 'title', 'format', 'status', 'message', 'created',
        'finished', 'result', 'reference', 'position')}


def catalog_payload():
    packs = {}
    for entry in CATALOG:
        pack = packs.setdefault(entry['packId'], {'id': entry['packId'], 'name': entry['pack'], 'scenes': []})
        pack['scenes'].append({
            'id': entry['id'],
            'title': entry['title'],
            'number': entry['id'].rsplit('-', 1)[-1],
            'description': BOILERPLATE.sub('', entry['description']).strip(),
        })
    formats = {name: {'width': w, 'height': h} for name, (w, h) in comfy.FORMATS.items()}
    return {'packs': list(packs.values()), 'formats': formats, 'defaultPhoto': bool(default_photo()),
            'engine': {'name': engine['name'], 'model': engine['model']}}


def engine_status():
    if engine['name'] == 'router':
        with jobs_lock:
            active = sum(job['status'] in ('queued', 'running') for job in jobs.values())
        return {'name': 'router', 'model': engine['model'], 'online': bool(router.api_key()), 'running': active, 'pending': 0}
    try:
        queue = comfy.api('/queue')
    except (OSError, ValueError):
        return {'online': False}
    return {'online': True, 'running': len(queue.get('queue_running', [])), 'pending': len(queue.get('queue_pending', []))}


def submit(scene_id, format_name, photo, owner=None):
    entry = SCENES.get(scene_id)
    if not entry:
        raise ValueError('Choose one of the scenes.')
    if format_name not in comfy.FORMATS:
        raise ValueError('Choose portrait or widescreen.')
    _, extension = comfy.photo_type(photo)
    if engine['name'] == 'router':
        with submit_lock:
            with jobs_lock:
                if any(job['status'] in ('queued', 'running') for job in jobs.values()):
                    raise RuntimeError('A photo is already being made. Wait for it to finish, then try again.')
            return submit_router(entry, format_name, photo, extension, owner)
    graph = json.loads((ROOT / entry['file']).read_text())
    with submit_lock:
        if entry['file'] not in checked_workflows:
            comfy.preflight(graph)
            checked_workflows.add(entry['file'])
        with jobs_lock:
            if any(job['status'] in ('queued', 'running') for job in jobs.values()):
                raise RuntimeError('A photo is already being made. Wait for it to finish, then try again.')
        queue = comfy.api('/queue')
        if queue.get('queue_running') or queue.get('queue_pending'):
            raise RuntimeError('ComfyUI is busy with another job. Let it finish or cancel it in ComfyUI first.')

        job_id = uuid.uuid4().hex[:12]
        folder = RESULTS / job_id
        folder.mkdir(parents=True, exist_ok=True)
        (folder / ('reference.' + extension)).write_bytes(photo)
        seed = secrets.randbits(32)
        width, height = comfy.FORMATS[format_name]
        values = {'reference': comfy.upload(photo, job_id), 'width': width, 'height': height, 'seed': seed}
        for key, value in values.items():
            for target in comfy.mapping_targets(entry['mapping'][key]):
                graph[target['node']]['inputs'][target['input']] = value + target.get('offset', 0) if key == 'seed' else value
        for node in graph.values():
            if node['class_type'] == 'SaveImage':
                shot = node['inputs']['filename_prefix'].rsplit('/', 1)[-1]
                node['inputs']['filename_prefix'] = 'OverTyme/studio-' + job_id + '/' + shot

        queued = comfy.post_json('/prompt', {'prompt': graph, 'client_id': job_id})
        if queued.get('error') or not queued.get('prompt_id'):
            raise RuntimeError('ComfyUI rejected this workflow: ' + json.dumps(queued.get('error') or queued))
        job = {
            'id': job_id, 'engine': 'comfy', 'owner': owner, 'scene': scene_id, 'pack': entry['pack'], 'title': entry['title'],
            'format': format_name, 'seed': seed, 'prompt_id': queued['prompt_id'], 'status': 'queued',
            'created': time.time(), 'reference': f'{job_id}/reference.{extension}',
        }
        with jobs_lock:
            jobs[job_id] = job
            save_jobs()
        return job


def update_job(job):
    """Check one unfinished job against ComfyUI and download its photo when done."""
    prompt_id = job['prompt_id']
    history = comfy.api('/history/' + urllib.parse.quote(prompt_id, safe='')).get(prompt_id)
    if history:
        status = history.get('status', {})
        if status.get('status_str') == 'error' or any(
                m[0] in ('execution_error', 'execution_interrupted') for m in status.get('messages', [])):
            return {'status': 'failed', 'message': 'ComfyUI stopped this job. Check its window for the error.', 'finished': time.time()}
        if status.get('completed'):
            images = [image for output in history.get('outputs', {}).values()
                      for image in output.get('images', []) if image.get('type') == 'output']
            if not images:
                return {'status': 'failed', 'message': 'ComfyUI finished without saving a photo.', 'finished': time.time()}
            query = urllib.parse.urlencode({key: images[0].get(key, '') for key in ('filename', 'subfolder', 'type')})
            data = comfy.api('/view?' + query, binary=True)
            if not data.startswith(comfy.PNG):
                return {'status': 'failed', 'message': 'The result was not a valid PNG.', 'finished': time.time()}
            name = f'{job["id"]}/{job["scene"]}-{job["format"]}.png'
            (RESULTS / name).write_bytes(data)
            return {'status': 'done', 'result': name, 'finished': time.time(), 'position': None}
        return {}
    queue = comfy.api('/queue')
    if any(item[1] == prompt_id for item in queue.get('queue_running', [])):
        return {'status': 'running', 'position': 0}
    pending = sorted(item for item in queue.get('queue_pending', []))
    for index, item in enumerate(pending, 1):
        if item[1] == prompt_id:
            return {'status': 'queued', 'position': index}
    return {}


def watcher():
    while True:
        with jobs_lock:
            active = [dict(job) for job in jobs.values()
                      if job['status'] in ('queued', 'running') and job.get('engine', 'comfy') == 'comfy']
        for job in active:
            try:
                changes = update_job(job)
            except (OSError, ValueError):
                changes = {}
            if changes:
                with jobs_lock:
                    jobs[job['id']].update(changes)
                    save_jobs()
        time.sleep(2)


# ---------- Comfy Router ----------

ROUTER_RESULTS = RESULTS / 'router'
ROUTER_JOBS_FILE = ROUTER_RESULTS / 'jobs.json'
DEFAULT_ROUTER_MODEL = 'qwen/qwen-image-3.0-pro'
ROUTER_STATES = {'IN_QUEUE': 'queued', 'QUEUED': 'queued'}
engine = {'name': 'comfy', 'model': None, 'plan': None}
router_jobs = {}


def shorten(value):
    """Keep logs readable: trim long strings such as base64 images."""
    if isinstance(value, str):
        return value if len(value) <= 300 else value[:120] + f'… ({len(value)} chars)'
    if isinstance(value, dict):
        return {key: shorten(item) for key, item in value.items()}
    if isinstance(value, list):
        return [shorten(item) for item in value[:50]]
    return value


def update(store, save, job_id, **changes):
    with jobs_lock:
        store[job_id].update(changes)
        save()


def save_assets(body, folder, stem):
    """Download every asset in a Router output straight away (their URLs expire)."""
    folder.mkdir(parents=True, exist_ok=True)
    files = []
    for index, url in enumerate(router.asset_urls(body), 1):
        data, content_type = router.download(url)
        extension = (mimetypes.guess_extension((content_type or '').split(';')[0])
                     or Path(urllib.parse.urlparse(url).path).suffix or '.bin')
        name = f'{stem}-{index:02d}{extension}' if index > 1 else stem + extension
        (folder / name).write_bytes(data)
        files.append(name)
    return files


# Studio photos made on Router

def submit_router(entry, format_name, photo, extension, owner):
    graph = json.loads((ROOT / entry['file']).read_text())
    mapping = entry['mapping']
    prompt = graph[mapping['positive']['node']]['inputs'][mapping['positive']['input']]
    negative = graph[mapping['negative']['node']]['inputs'][mapping['negative']['input']]
    width, height = comfy.FORMATS[format_name]
    mime, _ = comfy.photo_type(photo)
    payload = router.studio_payload(engine['plan'], prompt, negative,
                                    f'data:{mime};base64,' + base64.b64encode(photo).decode(), width, height)
    job_id = uuid.uuid4().hex[:12]
    folder = RESULTS / job_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / ('reference.' + extension)).write_bytes(photo)
    job = {
        'id': job_id, 'engine': 'router', 'model': engine['model'], 'owner': owner,
        'scene': entry['id'], 'pack': entry['pack'], 'title': entry['title'], 'format': format_name,
        'status': 'queued', 'created': time.time(), 'reference': f'{job_id}/reference.{extension}',
        'idempotency_key': router.new_idempotency_key(), 'request_id': None,
    }
    with jobs_lock:
        jobs[job_id] = job
        save_jobs()
    threading.Thread(target=run_studio_router_job, args=(job_id, payload), daemon=True).start()
    return job


def studio_log(job_id):
    def log(step, status, body):
        print(f'[router {job_id}] {step} HTTP {status}: {json.dumps(shorten(body))[:400]}', flush=True)
    return log


def run_studio_router_job(job_id, payload):
    job = jobs[job_id]
    try:
        follow_up = router.submit_request(job['model'], payload, job['idempotency_key'], studio_log(job_id))
        update(jobs, save_jobs, job_id, request_id=follow_up['request_id'], status_url=follow_up['status_url'],
               response_url=follow_up['response_url'])
        follow_studio_router_job(job_id)
    except (router.RouterError, ValueError, OSError) as error:
        update(jobs, save_jobs, job_id, status='failed', message=str(error), finished=time.time())


def follow_studio_router_job(job_id):
    job = jobs[job_id]
    log = studio_log(job_id)
    try:
        router.follow(job['status_url'], lambda status: update(
            jobs, save_jobs, job_id, status=ROUTER_STATES.get(status, 'running')), log)
        body = router.collect(job['response_url'], log)
        images = [f for f in save_assets(body, RESULTS / job_id, f'{job["scene"]}-{job["format"]}')
                  if re.search(r'\.(png|jpe?g|webp)$', f)]
        if not images:
            raise router.RouterError(200, body, 'Router finished without returning an image.')
        update(jobs, save_jobs, job_id, status='done', result=f'{job_id}/{images[0]}', finished=time.time())
    except (router.RouterError, ValueError, OSError) as error:
        update(jobs, save_jobs, job_id, status='failed', message=str(error), finished=time.time())


def resume_router_jobs(store, save, follower, field, default_engine):
    """After a restart, keep following confirmed requests; never resubmit unconfirmed ones."""
    for job in list(store.values()):
        if job.get('engine', default_engine) != 'router' or job['status'] in ('done', 'failed'):
            continue
        if job.get('request_id') and job.get('status_url'):
            threading.Thread(target=follower, args=(job['id'],), daemon=True).start()
        else:
            job.update({'status': 'failed', field: 'The studio stopped before Router confirmed this request. '
                                                   'Check your Comfy account before trying again.', 'payload': None})
    with jobs_lock:
        save()


# Test console

def save_router_jobs():
    ROUTER_RESULTS.mkdir(parents=True, exist_ok=True)
    temp = ROUTER_RESULTS / 'jobs.tmp'
    temp.write_text(json.dumps(list(router_jobs.values()), indent=2))
    temp.replace(ROUTER_JOBS_FILE)


def load_router_jobs():
    if ROUTER_JOBS_FILE.exists():
        try:
            router_jobs.update({job['id']: job for job in json.loads(ROUTER_JOBS_FILE.read_text())})
        except (ValueError, KeyError):
            pass
    resume_router_jobs(router_jobs, save_router_jobs, follow_console_job, 'error', 'router')


def console_log(job_id):
    def log(step, status, body):
        with jobs_lock:
            router_jobs[job_id]['log'].append({'t': time.time(), 'step': step, 'http': status, 'body': shorten(body)})
            save_router_jobs()
    return log


def start_router_job(owner, model, payload):
    router.check_model(model)
    if not isinstance(payload, dict) or not payload:
        raise ValueError('The request body must be a JSON object with the model inputs.')
    if not router.api_key():
        raise ValueError('COMFY_API_KEY is not set. Add it to overtyme-studio/.env and restart the studio.')
    job_id = uuid.uuid4().hex[:12]
    job = {'id': job_id, 'owner': owner, 'model': model, 'status': 'submitting', 'created': time.time(),
           'idempotency_key': router.new_idempotency_key(), 'request_id': None, 'error': None,
           'files': [], 'output': None, 'log': [], 'payload': payload}
    with jobs_lock:
        router_jobs[job_id] = job
        save_router_jobs()
    threading.Thread(target=run_console_job, args=(job_id,), daemon=True).start()
    return job


def run_console_job(job_id):
    job = router_jobs[job_id]
    try:
        follow_up = router.submit_request(job['model'], job['payload'], job['idempotency_key'], console_log(job_id))
        # The inputs (and any embedded photo) are no longer needed once Router has them.
        update(router_jobs, save_router_jobs, job_id, payload=None, **follow_up)
        follow_console_job(job_id)
    except (router.RouterError, ValueError, OSError) as error:
        update(router_jobs, save_router_jobs, job_id, status='failed', error=str(error), payload=None, finished=time.time())


def follow_console_job(job_id):
    job = router_jobs[job_id]
    log = console_log(job_id)
    try:
        router.follow(job['status_url'], lambda status: update(router_jobs, save_router_jobs, job_id, status=status), log)
        body = router.collect(job['response_url'], log)
        files = save_assets(body, ROUTER_RESULTS / job_id, 'result')
        update(router_jobs, save_router_jobs, job_id, status='done', output=shorten(body), finished=time.time(),
               files=[f'router/{job_id}/{name}' for name in files])
    except (router.RouterError, ValueError, OSError) as error:
        update(router_jobs, save_router_jobs, job_id, status='failed', error=str(error), finished=time.time())


def public_router_job(job):
    return {key: job.get(key) for key in (
        'id', 'model', 'status', 'created', 'finished', 'request_id', 'idempotency_key', 'error', 'files', 'output', 'log')}


class Handler(BaseHTTPRequestHandler):
    server_version = 'OverTymeStudio/1.0'

    def log_message(self, *args):
        pass

    def send_json(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, cache=False):
        try:
            data = path.read_bytes()
        except OSError:
            return self.send_json({'error': 'Not found'}, 404)
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(path.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'max-age=86400' if cache else 'no-cache')
        if getattr(self, 'new_owner', None):
            self.send_header('Set-Cookie', f'studio_owner={self.new_owner}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000')
        self.end_headers()
        self.wfile.write(data)

    def owner(self):
        cookie = self.headers.get('Cookie') or ''
        match = re.search(r'(?:^|;\s*)studio_owner=([a-f0-9]{32})', cookie)
        return match.group(1) if match else None

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/':
            self.new_owner = None if self.owner() else secrets.token_hex(16)
            return self.send_file(STATIC / 'index.html')
        if path == '/router':
            self.new_owner = None if self.owner() else secrets.token_hex(16)
            return self.send_file(STATIC / 'router.html')
        if path == '/api/router/config':
            return self.send_json({'keySet': bool(router.api_key()), 'base': router.BASE, 'defaultModel': DEFAULT_ROUTER_MODEL})
        if path == '/api/router/schema':
            model = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('model', [''])[0]
            try:
                return self.send_json(router.schema(model))
            except ValueError as error:
                return self.send_json({'error': str(error)}, 400)
            except router.RouterError as error:
                return self.send_json({'error': str(error)}, 502)
            except OSError:
                return self.send_json({'error': 'Cannot reach ' + router.BASE + '.'}, 502)
        if path == '/api/router/jobs':
            owner = self.owner()
            with jobs_lock:
                mine = [public_router_job(job) for job in router_jobs.values() if owner and job['owner'] == owner]
            return self.send_json({'jobs': sorted(mine, key=lambda job: -job['created'])})
        if path.startswith('/results/router/'):
            job = router_jobs.get(path.split('/')[3])
            if not job or job['owner'] != self.owner():
                return self.send_json({'error': 'Not found'}, 404)
        if path.startswith('/static/'):
            return self.send_safe(STATIC, path[len('/static/'):])
        if path.startswith('/results/'):
            job = jobs.get(path.split('/')[2])
            if job and job.get('owner') not in (None, self.owner()):
                return self.send_json({'error': 'Not found'}, 404)
            return self.send_safe(RESULTS, urllib.parse.unquote(path[len('/results/'):]), cache=True)
        if path == '/default-photo':
            photo = default_photo()
            return self.send_file(photo) if photo else self.send_json({'error': 'No default photo'}, 404)
        if path == '/api/catalog':
            return self.send_json(catalog_payload())
        if path == '/api/status':
            owner = self.owner()
            with jobs_lock:
                listed = [public_job(job) for job in sorted(jobs.values(), key=lambda job: -job['created'])
                          if job.get('owner') in (None, owner)]
            return self.send_json({'engine': engine_status(), 'jobs': listed})
        self.send_json({'error': 'Not found'}, 404)

    def send_safe(self, base, relative, cache=False):
        target = (base / relative).resolve()
        if base.resolve() not in target.parents or not target.is_file():
            return self.send_json({'error': 'Not found'}, 404)
        return self.send_file(target, cache)

    def post_router_job(self):
        owner = self.owner()
        if not owner:
            return self.send_json({'error': 'Reload the page and try again.'}, 403)
        length = int(self.headers.get('Content-Length') or 0)
        if not 0 < length <= MAX_BODY:
            return self.send_json({'error': 'The request is empty or over 15 MB.'}, 413)
        try:
            body = json.loads(self.rfile.read(length))
            job = start_router_job(owner, body.get('model', ''), body.get('input'))
        except ValueError as error:
            return self.send_json({'error': str(error)}, 400)
        self.send_json({'job': public_router_job(job)})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == '/api/router/jobs':
            return self.post_router_job()
        if path != '/api/generate':
            return self.send_json({'error': 'Not found'}, 404)
        length = int(self.headers.get('Content-Length') or 0)
        if not 0 < length <= MAX_BODY:
            return self.send_json({'error': 'Choose a reference photo under 10 MB.'}, 413)
        try:
            body = json.loads(self.rfile.read(length))
            if body.get('photo'):
                photo = base64.b64decode(body['photo'].split(',', 1)[-1], validate=True)
            elif default_photo():
                photo = default_photo().read_bytes()
            else:
                raise ValueError('Add a photo of the subject first.')
            job = submit(body.get('scene'), body.get('format', 'portrait'), photo, self.owner())
        except (ValueError, RuntimeError) as error:
            return self.send_json({'error': str(error)}, 400)
        except (OSError, urllib.error.URLError):
            where = 'Comfy Router' if engine['name'] == 'router' else 'ComfyUI. Make sure it is running'
            return self.send_json({'error': f'Cannot reach {where}, then try again.'}, 502)
        self.send_json({'job': public_job(job)})


def lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(('10.255.255.255', 1))
            return probe.getsockname()[0]
    except OSError:
        return None


def main():
    parser = argparse.ArgumentParser(description='Browser front end for the OverTyme One Image Packs.')
    parser.add_argument('--port', type=int, default=8790)
    parser.add_argument('--share', action='store_true', help='Let other devices on your network open the studio.')
    parser.add_argument('--comfy', default=comfy.BASE, help='ComfyUI address (default %(default)s).')
    parser.add_argument('--engine', choices=('comfy', 'router'), default='comfy',
                        help='Make studio photos on your local ComfyUI (default) or on Comfy Router.')
    parser.add_argument('--model', default=DEFAULT_ROUTER_MODEL, help='Router model for --engine router (default %(default)s).')
    parser.add_argument('--router', default=router.BASE, help='Comfy Router address (default %(default)s).')
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    comfy.BASE = args.comfy.rstrip('/')
    router.BASE = args.router.rstrip('/')

    if args.engine == 'router':
        if not router.api_key():
            raise SystemExit('COMFY_API_KEY is not set. Copy overtyme-studio/.env.example to .env and add your key.')
        try:
            engine['plan'] = router.studio_plan(router.schema(router.check_model(args.model)))
        except (router.RouterError, ValueError, OSError) as error:
            raise SystemExit(f'Cannot use {args.model} for the studio: {error}')
        engine.update(name='router', model=args.model)
        print(f'Studio photos are made on Comfy Router with {args.model}: {router.describe_plan(engine["plan"])}')

    load_jobs()
    resume_router_jobs(jobs, save_jobs, follow_studio_router_job, 'message', 'comfy')
    load_router_jobs()
    threading.Thread(target=watcher, daemon=True).start()
    server = ThreadingHTTPServer(('0.0.0.0' if args.share else '127.0.0.1', args.port), Handler)
    url = f'http://127.0.0.1:{args.port}'
    print(f'OverTyme Studio is running at {url}')
    print(f'Comfy Router test console: {url}/router' + ('' if router.api_key() else '  (add COMFY_API_KEY to overtyme-studio/.env first)'))
    if args.share and lan_address():
        print(f'On the same Wi-Fi, open http://{lan_address()}:{args.port}')
    print('Press Ctrl+C to stop. Jobs already sent keep running and are picked up again on restart.')
    if not args.no_browser:
        threading.Timer(0.6, webbrowser.open, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStudio stopped.')


if __name__ == '__main__':
    main()
