const $ = (id) => document.getElementById(id);
const state = { catalog: null, pack: null, scene: null, format: 'portrait', photo: null, jobs: [], focus: null, engine: null, sending: false };
const MAX_PHOTO = 10 * 1024 * 1024;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function sceneById(id) {
  for (const pack of state.catalog.packs) for (const scene of pack.scenes) if (scene.id === id) return { pack, scene };
  return null;
}

function remember() {
  try { localStorage.setItem('overtyme-studio', JSON.stringify({ pack: state.pack, scene: state.scene, format: state.format })); } catch {}
}

function restore() {
  try { return JSON.parse(localStorage.getItem('overtyme-studio')) || {}; } catch { return {}; }
}

/* ---------- Photo ---------- */

function showPhoto(src) {
  $('photo-preview').src = src;
  $('photo-preview').hidden = false;
  $('drop-text').innerHTML = state.photo
    ? '<strong>Photo ready</strong><br>Click or drop to replace it.'
    : '<strong>Using the included photo</strong><br>Click or drop to use a different one.';
  $('photo-clear').hidden = !state.photo || !state.catalog.defaultPhoto;
  $('photo-clear').textContent = 'Go back to the included photo';
}

function resetPhoto() {
  state.photo = null;
  if (state.catalog.defaultPhoto) showPhoto('/default-photo');
  else {
    $('photo-preview').hidden = true;
    $('drop-text').innerHTML = '<strong>Add a photo</strong><br>Drag it here or click to choose. JPG, PNG or WebP, under 10 MB.';
    $('photo-clear').hidden = true;
  }
  updateSummary();
}

function takeFile(file) {
  $('error').textContent = '';
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return ($('error').textContent = 'Choose a JPG, PNG or WebP photo.');
  if (file.size > MAX_PHOTO) return ($('error').textContent = 'That photo is over 10 MB. Choose a smaller one.');
  const reader = new FileReader();
  reader.onload = () => { state.photo = reader.result; showPhoto(reader.result); updateSummary(); };
  reader.readAsDataURL(file);
}

function setupPhoto() {
  const drop = $('drop');
  $('photo-input').addEventListener('change', (e) => takeFile(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); takeFile(e.dataTransfer.files[0]); });
  $('photo-clear').addEventListener('click', resetPhoto);
  resetPhoto();
}

/* ---------- Scenes & format ---------- */

function renderTabs() {
  $('tabs').replaceChildren(...state.catalog.packs.map((pack) => el('button', {
    class: 'tab', role: 'tab', 'aria-selected': String(pack.id === state.pack), text: pack.name,
    onclick: () => { state.pack = pack.id; remember(); renderTabs(); renderScenes(); },
  })));
}

function renderScenes() {
  const pack = state.catalog.packs.find((p) => p.id === state.pack);
  $('scenes').setAttribute('role', 'radiogroup');
  $('scenes').replaceChildren(...pack.scenes.map((scene) => el('button', {
    class: 'scene', role: 'radio', 'aria-checked': String(scene.id === state.scene),
    onclick: () => { state.scene = scene.id; remember(); renderScenes(); updateSummary(); },
  }, [el('span', { class: 'n', text: scene.number }), el('h3', { text: scene.title }), el('p', { text: scene.description })])));
}

function renderFormats() {
  const labels = { portrait: 'Portrait', widescreen: 'Widescreen' };
  $('formats').replaceChildren(...Object.entries(state.catalog.formats).map(([name, size]) => {
    const scale = 26 / Math.max(size.width, size.height);
    const shape = el('span', { class: 'shape' });
    shape.style.width = Math.round(size.width * scale) + 'px';
    shape.style.height = Math.round(size.height * scale) + 'px';
    const text = el('span', {}, [labels[name] || name, el('small', { text: `${size.width} × ${size.height}` })]);
    return el('button', {
      class: 'format', role: 'radio', 'aria-checked': String(name === state.format),
      onclick: () => { state.format = name; remember(); renderFormats(); updateSummary(); },
    }, [shape, text]);
  }));
}

function busy() {
  return state.jobs.some((job) => job.status === 'queued' || job.status === 'running');
}

function updateSummary() {
  const found = state.scene && sceneById(state.scene);
  const hasPhoto = state.photo || state.catalog.defaultPhoto;
  const summary = $('summary');
  if (!found) summary.textContent = 'Choose a scene to continue.';
  else {
    summary.replaceChildren('You will get one ', el('strong', { text: state.format }), ' photo of ',
      el('strong', { text: `${found.pack.name} / ${found.scene.title}` }), '.');
  }
  const button = $('generate');
  button.disabled = !found || !hasPhoto || busy() || state.sending || state.engine?.online === false;
  button.textContent = state.sending ? 'Sending…' : busy() ? 'Making your photo…' : 'Generate photo';
}

async function generate() {
  $('error').textContent = '';
  state.sending = true;
  updateSummary();
  try {
    const response = await fetch('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scene: state.scene, format: state.format, photo: state.photo }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Something went wrong.');
    state.focus = data.job.id;
    state.jobs.unshift(data.job);
    render();
    if (matchMedia('(max-width: 960px)').matches) $('stage').scrollIntoView({ behavior: 'smooth' });
  } catch (error) {
    $('error').textContent = error.message;
  } finally {
    state.sending = false;
    updateSummary();
  }
}

/* ---------- Stage & gallery ---------- */

function elapsed(job) {
  const seconds = Math.max(0, Math.round(((job.finished || Date.now() / 1000) - job.created)));
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m ? `${m} min ${String(s).padStart(2, '0')} s` : `${s} s`;
}

function statusText(job) {
  if (job.status === 'done') return `Finished in ${elapsed(job)}.`;
  if (job.status === 'failed') return job.message || 'This one did not finish.';
  if (job.status === 'running') return `Creating your photo… ${elapsed(job)}`;
  return job.position ? `Waiting in line (#${job.position})… ${elapsed(job)}` : `Getting the engine ready… ${elapsed(job)}`;
}

function openViewer(src, alt) {
  $('viewer-img').src = src;
  $('viewer-img').alt = alt;
  $('viewer').showModal();
}

let stageKey = '';
function renderStage() {
  const job = state.jobs.find((j) => j.id === state.focus) || state.jobs[0];
  $('stage-empty').hidden = !!job;
  $('stage-job').hidden = !job;
  if (!job) return;
  $('job-pack').textContent = job.pack;
  $('job-title').textContent = job.title;
  $('job-status').textContent = statusText(job);

  const key = job.id + job.status;
  if (key === stageKey) return;
  stageKey = key;
  const image = $('stage-image');
  image.style.aspectRatio = job.format === 'widescreen' ? '16 / 9' : '3 / 4';
  const name = `${job.title} (${job.format})`;
  if (job.status === 'done') {
    image.replaceChildren(el('img', { src: '/results/' + job.result, alt: name, onclick: () => openViewer('/results/' + job.result, name) }));
    $('job-actions').replaceChildren(
      el('a', { class: 'btn solid', href: '/results/' + job.result, download: `${job.scene}-${job.format}.png`, text: 'Download' }),
      el('button', { class: 'btn', text: 'Make another', title: 'A fresh variation of the same scene', onclick: () => {
        state.scene = job.scene; state.format = job.format; state.pack = sceneById(job.scene)?.pack.id || state.pack;
        renderTabs(); renderScenes(); renderFormats(); generate();
      } }),
    );
  } else {
    const ref = job.reference ? el('img', { class: 'ref', src: '/results/' + job.reference, alt: '' }) : null;
    const overlay = job.status === 'failed'
      ? el('div', { class: 'overlay' }, [el('strong', { text: 'Not finished' })])
      : el('div', { class: 'overlay' }, [el('div', { class: 'spinner' }), el('strong', { text: 'Making your photo' }), el('span', { text: 'This can take a few minutes.' })]);
    image.replaceChildren(...[ref, overlay].filter(Boolean));
    $('job-actions').replaceChildren();
  }
}

function renderGallery() {
  const shots = state.jobs.filter((job) => job.status !== 'failed');
  $('gallery-wrap').hidden = !shots.length;
  $('gallery').replaceChildren(...shots.map((job) => el('button', {
    class: 'shot' + (job.format === 'widescreen' ? ' wide' : ''),
    onclick: () => { state.focus = job.id; stageKey = ''; renderStage(); if (job.status === 'done') openViewer('/results/' + job.result, job.title); },
  }, [
    job.status === 'done' ? el('img', { src: '/results/' + job.result, alt: job.title, loading: 'lazy' }) : el('div', { class: 'placeholder', text: 'In progress…' }),
    el('div', { class: 'cap' }, [el('strong', { text: job.title }), job.pack]),
  ])));
}

let galleryKey = '';
function render() {
  renderStage();
  const key = state.jobs.map((j) => j.id + j.status).join();
  if (key !== galleryKey) { galleryKey = key; renderGallery(); }
  updateSummary();
}

function renderEngine() {
  const engine = state.engine, badge = $('engine');
  if (!engine) return;
  const router = engine.name === 'router';
  badge.className = 'engine ' + (!engine.online ? 'off' : engine.running || engine.pending ? 'busy' : 'ok');
  $('engine-text').textContent = !engine.online ? (router ? 'Comfy Router: API key missing' : 'Engine offline: start ComfyUI')
    : (router ? 'Comfy Router ' : 'Engine ') + (engine.running || engine.pending ? 'busy' : 'ready');
}

async function poll() {
  try {
    const data = await (await fetch('/api/status')).json();
    state.engine = data.engine;
    state.jobs = data.jobs;
  } catch {
    state.engine = { online: false };
  }
  renderEngine();
  render();
}

async function start() {
  state.catalog = await (await fetch('/api/catalog')).json();
  if (state.catalog.engine?.name === 'router') {
    $('footer-text').textContent = `Photos are made on Comfy Router (${state.catalog.engine.model}). Your photo is sent to Comfy to create each image.`;
  }
  const saved = restore();
  state.pack = state.catalog.packs.some((p) => p.id === saved.pack) ? saved.pack : state.catalog.packs[0].id;
  state.scene = saved.scene && sceneById(saved.scene) ? saved.scene : null;
  state.format = state.catalog.formats[saved.format] ? saved.format : 'portrait';
  setupPhoto();
  renderTabs();
  renderScenes();
  renderFormats();
  $('generate').addEventListener('click', generate);
  await poll();
  setInterval(poll, 2000);
}

start();
