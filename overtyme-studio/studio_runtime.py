"""A single, local ComfyUI test. Uses Python's standard library only."""
import copy
import fcntl
import json
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

BASE = 'http://127.0.0.1:8188'
PNG = b'\x89PNG\r\n\x1a\n'
FORMATS = {'portrait': (768, 1024), 'widescreen': (1280, 720)}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def api(path, body=None, content_type=None, binary=False):
    if not path.startswith('/') or path.startswith('//'):
        raise ValueError('Invalid local request.')
    headers = {'Content-Type': content_type} if content_type else {}
    request = urllib.request.Request(BASE + path, data=body, headers=headers)
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        data = response.read()
    return data if binary else json.loads(data)

def post_json(path, value):
    return api(path, json.dumps(value).encode(), 'application/json')

def mapping_targets(value):
    return value if isinstance(value, list) else [value]

def preflight(graph):
    api('/system_stats')
    catalog = api('/object_info')
    for node in graph.values():
        info = catalog.get(node['class_type'])
        if not info:
            raise RuntimeError('ComfyUI is missing this node: ' + node['class_type'])
        if info.get('api_node'):
            raise RuntimeError('External generation nodes are blocked in this local test.')
        inputs = {**info.get('input', {}).get('required', {}), **info.get('input', {}).get('optional', {})}
        for key, value in node['inputs'].items():
            spec = inputs.get(key)
            if spec and isinstance(spec[0], list) and not isinstance(value, list) and key != 'image' and value not in spec[0]:
                raise RuntimeError('ComfyUI is missing this model or option: ' + str(value))

def photo_type(photo):
    if not 0 < len(photo) <= 10 * 1024 * 1024:
        raise RuntimeError('Choose a reference photo under 10 MB.')
    if photo.startswith(PNG): return ('image/png', 'png')
    if photo.startswith(b'\xff\xd8\xff'): return ('image/jpeg', 'jpg')
    if photo[:4] == b'RIFF' and photo[8:12] == b'WEBP': return ('image/webp', 'webp')
    raise RuntimeError('Choose a JPG, PNG, or WebP reference photo.')

def upload(photo, job_id):
    mime, extension = photo_type(photo)
    boundary = 'OverTyme' + uuid.uuid4().hex
    lines = []
    for key, value in [('type', 'input'), ('overwrite', 'false')]:
        lines.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n').encode())
    lines.append((f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="studio-{job_id}.{extension}"\r\nContent-Type: {mime}\r\n\r\n').encode())
    lines.extend([photo, f'\r\n--{boundary}--\r\n'.encode()])
    result = api('/upload/image', b''.join(lines), f'multipart/form-data; boundary={boundary}')
    if not isinstance(result.get('name'), str):
        raise RuntimeError('ComfyUI did not accept the reference photo.')
    return '/'.join(filter(None, [result.get('subfolder', ''), result['name']]))

def save_session(folder, session):
    folder.mkdir(parents=True, exist_ok=True)
    temp = folder / 'session.tmp'
    temp.write_text(json.dumps(session, indent=2))
    temp.replace(folder / 'session.json')

def wait_and_download(folder, session):
    prompt_id = session['prompt_id']
    print('Waiting for Spark to finish this one photo.', flush=True)
    deadline = time.monotonic() + 4 * 60 * 60
    next_update = 0
    while time.monotonic() < deadline:
        try:
            history = api('/history/' + urllib.parse.quote(prompt_id, safe='')).get(prompt_id)
        except (urllib.error.URLError, TimeoutError):
            history = None
        if history:
            status = history.get('status', {})
            if status.get('status_str') == 'error' or any(m[0] in ('execution_error', 'execution_interrupted') for m in status.get('messages', [])):
                session['status'] = 'failed'
                save_session(folder, session)
                raise RuntimeError('ComfyUI could not finish the job. Check its local error message.')
            if status.get('completed'):
                images = [image for output in history.get('outputs', {}).values() for image in output.get('images', []) if image.get('type') == 'output']
                if len(images) != 1:
                    raise RuntimeError('This workflow must return exactly one saved photo. Check ComfyUI.')
                names = []
                for index, image in enumerate(images, 1):
                    query = urllib.parse.urlencode({key: image.get(key, '') for key in ('filename', 'subfolder', 'type')})
                    data = api('/view?' + query, binary=True)
                    if not data.startswith(PNG):
                        raise RuntimeError('A result was not a valid PNG. The job is saved; run this package again to retry downloads.')
                    name = f'{index:02d}-' + Path(image['filename']).name
                    (folder / name).write_bytes(data)
                    names.append(name)
                session.update(status='completed', files=names)
                save_session(folder, session)
                print(f'Done. Saved {len(names)} photos in: {folder}', flush=True)
                return names
        if time.monotonic() >= next_update:
            print('The job is submitted. Waiting for the local engine...', flush=True)
            next_update = time.monotonic() + 60
        time.sleep(3)
    raise RuntimeError('The job is still saved. Run this package again to continue checking; it will not submit it twice.')

def _run(workflow, photo, folder, format_name='portrait', check_only=False):
    graph = workflow['graph']
    if sum(n['class_type'] == 'SaveImage' for n in graph.values()) != 1 or sum(n['class_type'] == 'KSampler' for n in graph.values()) != 1:
        raise RuntimeError('Choose a workflow with exactly one sampler and one saved image.')
    previous = folder / 'session.json'
    if previous.exists() and not check_only:
        session = json.loads(previous.read_text())
        if session['status'] == 'completed':
            print('This test already finished. Your photos are in: ' + str(folder))
            return session['files']
        if session.get('prompt_id'):
            return wait_and_download(folder, session)
        raise RuntimeError('A previous submission is saved without a confirmed job ID. Check the ComfyUI queue before starting another test.')
    preflight(workflow['graph'])
    print('ComfyUI is reachable. Required nodes and model names passed the check.', flush=True)
    if check_only:
        print('Connection check complete. No photo uploaded and no generation started.')
        return []
    queue = api('/queue')
    if queue.get('queue_running') or queue.get('queue_pending'):
        raise RuntimeError('ComfyUI still has a job running or waiting. Let it finish or cancel it in ComfyUI, then run this again.')
    graph = copy.deepcopy(workflow['graph'])
    job_id = str(uuid.uuid4())
    seed = secrets.randbits(32)
    reference = upload(photo, job_id)
    width, height = FORMATS[format_name]
    values = {'reference': reference, 'width': width, 'height': height, 'seed': seed}
    for key, value in values.items():
        for target in mapping_targets(workflow['mapping'][key]):
            graph[target['node']]['inputs'][target['input']] = value + target.get('offset', 0) if key == 'seed' else value
    # Keep the original shot prompt and quality settings unchanged.
    for node in graph.values():
        if node['class_type'] == 'SaveImage':
            shot = node['inputs']['filename_prefix'].rsplit('/', 1)[-1]
            node['inputs']['filename_prefix'] = 'OverTyme/one-image-' + job_id + '/' + shot
    session = {'status': 'submitting', 'client_id': job_id, 'format': format_name, 'seed': seed}
    save_session(folder, session)
    try:
        queued = post_json('/prompt', {'prompt': graph, 'client_id': job_id})
    except Exception:
        session['status'] = 'unknown'
        save_session(folder, session)
        raise RuntimeError('The submission response was lost. Check the local ComfyUI queue; this package will not submit the job again automatically.')
    if queued.get('error') or not queued.get('prompt_id'):
        session['status'] = 'rejected'
        save_session(folder, session)
        raise RuntimeError('ComfyUI rejected this workflow: ' + json.dumps(queued))
    session.update(status='queued', prompt_id=queued['prompt_id'])
    save_session(folder, session)
    print('Submitted one local job for one photo.', flush=True)
    return wait_and_download(folder, session)

def run(workflow, photo, folder, format_name='portrait', check_only=False):
    if check_only:
        return _run(workflow, photo, folder, format_name, True)
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / 'test.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('This test is already running in another terminal. Let that copy finish.')
        return _run(workflow, photo, folder, format_name, False)
