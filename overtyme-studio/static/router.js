const $ = (id) => document.getElementById(id);
const state = { schema: null, props: {}, required: [], values: {}, photos: [], rawEdited: false, jobs: [] };
const MAX_PHOTO = 10 * 1024 * 1024;
const LIVE = (job) => !['done', 'failed'].includes(job.status);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/* ---------- OpenAPI ---------- */

function resolve(doc, node, depth = 0) {
  if (!node || depth > 12) return node || {};
  if (node.$ref) {
    const target = node.$ref.replace(/^#\//, '').split('/').reduce((obj, key) => obj?.[decodeURIComponent(key.replace(/~1/g, '/').replace(/~0/g, '~'))], doc);
    return resolve(doc, { ...target, ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== '$ref')) }, depth + 1);
  }
  if (node.allOf) {
    const merged = { ...node, properties: {}, required: [] };
    delete merged.allOf;
    for (const part of node.allOf.map((p) => resolve(doc, p, depth + 1))) {
      Object.assign(merged.properties, part.properties || {});
      merged.required.push(...(part.required || []));
      for (const k of ['type', 'description', 'title']) if (part[k] && !merged[k]) merged[k] = part[k];
    }
    return merged;
  }
  const variants = node.anyOf || node.oneOf;
  if (variants) {
    const options = variants.map((v) => resolve(doc, v, depth + 1)).filter((v) => v.type !== 'null');
    const first = options[0] || {};
    return { ...first, ...Object.fromEntries(Object.entries(node).filter(([k]) => !['anyOf', 'oneOf'].includes(k))), _variants: options.length };
  }
  return node;
}

function requestSchema(doc) {
  const ops = [];
  for (const [path, item] of Object.entries(doc.paths || {})) {
    if (item.post?.requestBody) ops.push({ path, op: item.post });
  }
  if (!ops.length) throw new Error('This schema has no POST request body.');
  const pick = ops.find((o) => !o.path.endsWith('/requests')) || ops[0];
  const content = resolve(doc, pick.op.requestBody).content || {};
  const media = content['application/json'] || Object.values(content)[0];
  return { path: pick.path, schema: resolve(doc, media?.schema || {}) };
}

function typeOf(prop) {
  if (Array.isArray(prop.type)) return prop.type.find((t) => t !== 'null') || 'string';
  return prop.type || (prop.properties ? 'object' : prop.enum ? 'string' : 'string');
}

function isImage(name, prop) {
  const item = prop.items || {};
  const text = `${name} ${prop.description || ''} ${prop.format || ''} ${item.format || ''} ${prop.contentMediaType || ''}`.toLowerCase();
  return /image|photo|reference|picture/.test(name.toLowerCase()) && (typeOf(prop) === 'string' || (typeOf(prop) === 'array' && typeOf(item) === 'string'))
    || /contentmediatype.*image|binary|byte/.test(text) && /image/.test(text);
}

/* ---------- Form ---------- */

function limits(prop) {
  const out = [];
  if (prop.minimum !== undefined) out.push(`min ${prop.minimum}`);
  if (prop.maximum !== undefined) out.push(`max ${prop.maximum}`);
  if (prop.minLength !== undefined) out.push(`min length ${prop.minLength}`);
  if (prop.maxLength !== undefined) out.push(`max length ${prop.maxLength}`);
  if (prop.minItems !== undefined) out.push(`min items ${prop.minItems}`);
  if (prop.maxItems !== undefined) out.push(`max items ${prop.maxItems}`);
  if (prop.default !== undefined) out.push(`default ${JSON.stringify(prop.default)}`);
  return out.join(' · ');
}

function set(name, value) {
  if (value === '' || value === undefined || (Array.isArray(value) && !value.length)) delete state.values[name];
  else state.values[name] = value;
  if (!state.rawEdited) $('raw').value = JSON.stringify(state.values, null, 2);
}

function photoField(name, prop) {
  const many = typeOf(prop) === 'array';
  const strip = el('div', { class: 'photos' });
  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: many || undefined });
  input.addEventListener('change', async () => {
    $('send-error').textContent = '';
    const tokens = [];
    strip.replaceChildren();
    for (const file of [...input.files].slice(0, prop.maxItems || 10)) {
      if (file.size > MAX_PHOTO) { $('send-error').textContent = `${file.name} is over 10 MB.`; continue; }
      const data = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(file); });
      state.photos.push(data);
      tokens.push(`@photo:${state.photos.length - 1}`);
      strip.append(el('img', { src: data, alt: file.name }));
    }
    set(name, many ? tokens : tokens[0]);
  });
  strip.append(input);
  return [strip, el('span', { class: 'desc', text: 'Sent as a base64 data URI. If the description below asks for a public URL instead, paste one in the JSON.' })];
}

function control(name, prop) {
  const type = typeOf(prop);
  if (isImage(name, prop)) return photoField(name, prop);
  if (prop.enum) {
    const select = el('select', { onchange: (e) => set(name, e.target.value === '' ? '' : prop.enum[e.target.selectedIndex - 1]) },
      [el('option', { value: '', text: prop.default !== undefined ? `(default: ${prop.default})` : '(not set)' }), ...prop.enum.map((v) => el('option', { text: String(v) }))]);
    return [select];
  }
  if (type === 'boolean') {
    const box = el('input', { type: 'checkbox', checked: prop.default === true });
    box.addEventListener('change', () => set(name, box.checked));
    return [el('label', { class: 'check' }, [box, 'on'])];
  }
  if (type === 'integer' || type === 'number') {
    const input = el('input', { type: 'number', min: prop.minimum, max: prop.maximum, step: type === 'integer' ? 1 : 'any', placeholder: prop.default ?? '' });
    input.addEventListener('input', () => set(name, input.value === '' ? '' : Number(input.value)));
    return [input];
  }
  if (type === 'string') {
    const long = /prompt|text|description/.test(name) || (prop.maxLength || 0) > 200;
    const input = el(long ? 'textarea' : 'input', { rows: long ? 4 : undefined, placeholder: prop.default ?? prop.example ?? '' });
    input.addEventListener('input', () => set(name, input.value));
    return [input];
  }
  const area = el('textarea', { rows: 3, placeholder: 'JSON ' + type });
  area.addEventListener('input', () => {
    try { set(name, area.value.trim() ? JSON.parse(area.value) : ''); area.setCustomValidity(''); }
    catch { area.setCustomValidity('Not valid JSON'); }
  });
  return [area];
}

function renderFields() {
  $('fields').replaceChildren(...Object.entries(state.props).map(([name, raw]) => {
    const prop = resolve(state.schema, raw);
    const req = state.required.includes(name);
    return el('div', { class: 'field' }, [
      el('span', {}, [name, req ? el('span', { class: 'req', text: 'required' }) : null, el('span', { class: 'type', text: typeOf(prop) + (prop.items ? ` of ${typeOf(resolve(state.schema, prop.items))}` : '') })]),
      ...control(name, prop),
      prop.description ? el('span', { class: 'desc', text: prop.description }) : null,
      limits(prop) ? el('span', { class: 'desc', text: limits(prop) }) : null,
    ]);
  }));
}

async function loadSchema(event) {
  event?.preventDefault();
  const model = $('model').value.trim();
  $('schema-error').textContent = '';
  $('schema-meta').textContent = 'Loading…';
  try {
    const response = await fetch('/api/router/schema?model=' + encodeURIComponent(model));
    const doc = await response.json();
    if (!response.ok) throw new Error(doc.error || 'Could not load the schema.');
    const { path, schema } = requestSchema(doc);
    Object.assign(state, { schema: doc, props: schema.properties || {}, required: schema.required || [], values: {}, photos: [], rawEdited: false });
    try { localStorage.setItem('router-model', model); } catch {}
    $('schema-meta').textContent = `${doc.info?.title || model}${doc.info?.version ? ' · v' + doc.info.version : ''} · POST ${path} · ${Object.keys(state.props).length} inputs`;
    renderFields();
    $('raw').value = '{}';
    $('inputs-step').hidden = $('send-step').hidden = false;
  } catch (error) {
    $('schema-meta').textContent = '';
    $('schema-error').textContent = error.message;
  }
}

/* ---------- Send & follow ---------- */

function withPhotos(value) {
  if (typeof value === 'string') {
    const match = value.match(/^@photo:(\d+)$/);
    return match ? state.photos[Number(match[1])] : value;
  }
  if (Array.isArray(value)) return value.map(withPhotos);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withPhotos(v)]));
  return value;
}

async function send() {
  $('send-error').textContent = '';
  let body;
  try { body = JSON.parse($('raw').value || '{}'); } catch { return ($('send-error').textContent = 'The request body is not valid JSON.'); }
  const missing = state.required.filter((name) => body[name] === undefined);
  if (missing.length) return ($('send-error').textContent = 'Fill in: ' + missing.join(', '));
  $('send').disabled = true;
  $('send').textContent = 'Sending…';
  try {
    const response = await fetch('/api/router/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: $('model').value.trim(), input: withPhotos(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Something went wrong.');
    await poll();
  } catch (error) {
    $('send-error').textContent = error.message;
  } finally {
    $('send').disabled = false;
    $('send').textContent = 'Send to Router';
  }
}

function elapsed(job) {
  const s = Math.max(0, Math.round((job.finished || Date.now() / 1000) - job.created));
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
}

function openViewer(src) {
  $('viewer-img').src = src;
  $('viewer').showModal();
}

const openLogs = new Set();
function renderJobs() {
  if (!state.jobs.length) return $('jobs').replaceChildren(el('p', { class: 'hint', text: 'Nothing sent yet.' }));
  $('jobs').replaceChildren(...state.jobs.map((job) => {
    const pill = job.status === 'done' ? 'done' : job.status === 'failed' ? 'failed' : 'live';
    const images = job.files.filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
    const others = job.files.filter((f) => !images.includes(f));
    const log = el('details', { class: 'log', open: openLogs.has(job.id) || undefined, ontoggle: (e) => e.target.open ? openLogs.add(job.id) : openLogs.delete(job.id) }, [
      el('summary', { text: `Router exchange (${job.log.length} steps)` }),
      ...job.log.map((entry) => el('pre', { text: `${entry.step.toUpperCase()} → HTTP ${entry.http}\n${JSON.stringify(entry.body, null, 2)}` })),
    ]);
    return el('div', { class: 'job' }, [
      el('div', { class: 'job-head' }, [el('strong', { text: job.model }), el('span', { class: 'pill ' + pill, text: job.status })]),
      el('div', { class: 'meta', text: `${elapsed(job)}${job.request_id ? ' · request_id ' + job.request_id : ''}` }),
      job.error ? el('p', { class: 'error', text: job.error }) : null,
      images.length ? el('div', { class: 'outputs' }, images.map((f) => el('img', { src: '/results/' + f, alt: 'Result', onclick: () => openViewer('/results/' + f) }))) : null,
      job.files.length ? el('div', { class: 'stage-actions', style: 'margin-top:10px' }, job.files.map((f, i) =>
        el('a', { class: 'btn', href: '/results/' + f, download: f.split('/').pop(), text: `Download ${others.includes(f) ? 'file' : 'image'} ${i + 1}` }))) : null,
      log,
    ]);
  }));
}

let timer = null;
async function poll() {
  try {
    const data = await (await fetch('/api/router/jobs')).json();
    state.jobs = data.jobs || [];
    renderJobs();
  } catch {}
  clearTimeout(timer);
  timer = setTimeout(poll, state.jobs.some(LIVE) ? 2000 : 10000);
}

async function start() {
  const config = await (await fetch('/api/router/config')).json();
  $('key-badge').className = 'engine ' + (config.keySet ? 'ok' : 'off');
  $('key-text').textContent = config.keySet ? 'API key loaded on server' : 'No API key';
  $('key-help').hidden = config.keySet;
  let saved = null;
  try { saved = localStorage.getItem('router-model'); } catch {}
  $('model').value = saved || config.defaultModel;
  $('model-form').addEventListener('submit', loadSchema);
  $('raw').addEventListener('input', () => { state.rawEdited = true; });
  $('raw-reset').addEventListener('click', () => { state.rawEdited = false; $('raw').value = JSON.stringify(state.values, null, 2); });
  $('send').addEventListener('click', send);
  poll();
  if (config.keySet) loadSchema();
}

start();
