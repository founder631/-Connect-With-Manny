/* Festival Hub dashboard. Plain JavaScript, no build step. */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const PAGE_SIZE = 100;

  const state = {
    films: [],
    byId: new Map(),
    meta: {},
    demo: false,
    judging: false,
    filtered: [],
    sort: { key: "created", dir: -1 },
    page: 0,
    drawerId: null,
    ws: { ratings: {}, flags: {}, notes: {}, shortlist: [], blocks: [] },
  };

  // ---------- helpers ----------
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const fmtInt = (n) => Number(n || 0).toLocaleString();
  const fmtMoney = (n) => "$" + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const fmtMin = (m) => (m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`);
  const fmtDate = (d) => (d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—");
  const isHttps = (u) => typeof u === "string" && /^https:\/\//i.test(u);

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove("show"), 1800);
  }

  function parseDuration(d) {
    if (!d) return null;
    const parts = String(d).split(":").map(Number);
    if (parts.some(isNaN)) return null;
    while (parts.length < 3) parts.unshift(0);
    const mins = parts[0] * 60 + parts[1] + parts[2] / 60;
    return mins > 0 ? mins : null;
  }

  const AI_TOOLS = /\b(midjourney|runway(ml)?|gen-?[234]|sora|kling|pika|luma|dream ?machine|stable diffusion|dall[\s·-]?e|elevenlabs|suno|udio|hailuo|minimax|veo ?\d?|leonardo\.ai|higgsfield|comfyui|flux|hedra|heygen|krea|chatgpt|gpt-?4o?)\b/i;
  const AI_MADE = /\b(ai[- ](generated|assisted|created|made|powered|animated|animation|film|short|tools?)|generative ai|made (with|using) ai|created (with|using) (generative )?ai|aigc|text-to-video|image-to-video)\b/i;
  const AI_TOPIC = /\b(a\.?i\.?|artificial intelligence|machine learning|algorithm|robots?|android)\b/;

  function aiLevel(sub, p) {
    const text = [p.title, p.synopsis, sub.cover_letter, p.press_kit_statement, p.shooting_format, (p.genres || []).join(" ")].join(" \n ");
    if (AI_TOOLS.test(text) || AI_MADE.test(text) || /\bai\b/i.test(p.shooting_format || "")) return "ai_made";
    if (AI_TOPIC.test(text) || /\bAI\b/.test(text)) return "ai_topic";
    return "";
  }

  function directorsOf(p) {
    const credits = p.credits || [];
    const isDirector = (t) => /^(co-)?directors?\b|director-concept/i.test(clean(t)) && !/photography|assistant|art|casting|music|animation director/i.test(t);
    const names = [];
    credits.filter((c) => isDirector(c.type)).forEach((c) => (c.entries || []).forEach((e) => {
      const n = clean(e.name || [e.first_name, e.last_name].join(" "));
      if (n && !names.includes(n)) names.push(n);
    }));
    if (!names.length && credits[0] && credits[0].entries && credits[0].entries[0]) {
      const e = credits[0].entries[0];
      const n = clean(e.name || [e.first_name, e.last_name].join(" "));
      if (n) names.push(n);
    }
    return names;
  }

  function normalize(sub) {
    const p = sub.project || {};
    const runtime = parseDuration(p.duration) ?? (p.runtime_minutes ? Number(p.runtime_minutes) : null);
    const origins = (p.countries_of_origin && p.countries_of_origin.names) || [];
    const country = clean(origins[0] || p.country_of_origin_name || p.country_name || "") || "Unknown";
    const fee = parseFloat(String(sub.submission_fee || "0").replace(/[^0-9.]/g, "")) || 0;
    const directors = directorsOf(p);
    const categories = (sub.submission_categories || []).map(clean);
    const screenings = p.screenings || [];
    const laurels = screenings.filter((s) => clean(s.event_name)).length;
    const awards = screenings.filter((s) => clean(s.awards_won) && !/^none$/i.test(clean(s.awards_won)));
    const film = {
      id: sub.id,
      tracking: sub.tracking_number || "",
      title: clean(p.title) || "(untitled)",
      directors,
      director: directors.join(", ") || "—",
      categories,
      deadline: clean((sub.submission_deadlines || [])[0]),
      status: clean(sub.submission_status) || "—",
      country,
      countries: origins.length ? origins.map(clean) : [country],
      runtime,
      fee,
      feeStr: sub.submission_fee || "",
      created: sub.created_at ? new Date(sub.created_at) : null,
      genres: (p.genres || []).map(clean).filter(Boolean),
      languages: (p.languages || []).map(clean).filter(Boolean),
      types: (p.project_categories || []).map(clean).filter(Boolean),
      student: !!p.student_project,
      first: !!p.first_time_filmmaker,
      dcp: !!p.dcp_available,
      trailer: clean(p.press_kit_trailer_url),
      screener: clean(p.digital_copy_url),
      synopsis: clean(p.synopsis),
      ai: aiLevel(sub, p),
      laurels,
      awards,
      discount: sub.discount_code && sub.discount_code.code ? sub.discount_code : null,
      apiRating: sub.average_rating != null ? Number(sub.average_rating) : null,
      apiRatingCount: sub.rating_count,
      acceptance: sub.acceptance_status || "",
      judges: sub.assigned_judges || [],
      raw: sub,
    };
    film.search = [film.title, film.director, film.tracking, film.synopsis, film.country, categories.join(" "), film.genres.join(" ")].join(" ").toLowerCase();
    return film;
  }

  // ---------- workspace (ratings, decisions, notes, shortlist, blocks) ----------
  async function loadWorkspace() {
    try {
      const res = await fetch("api/workspace");
      const ws = await res.json();
      state.ws = Object.assign({ ratings: {}, flags: {}, notes: {}, shortlist: [], blocks: [] }, ws);
    } catch (_) { /* start fresh */ }
  }

  let saveTimer = null;
  function saveWorkspace() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const res = await fetch("api/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state.ws),
        });
        if (!res.ok) throw new Error();
      } catch (_) {
        toast("⚠ Could not save — is the hub still running?");
      }
    }, 400);
  }

  const rating = (id) => state.ws.ratings[id] || 0;
  const flag = (id) => state.ws.flags[id] || "";
  const isShort = (id) => state.ws.shortlist.includes(id);

  function setRating(id, n) {
    if (rating(id) === n) delete state.ws.ratings[id]; else state.ws.ratings[id] = n;
    saveWorkspace();
  }
  function setFlag(id, f) {
    if (flag(id) === f) delete state.ws.flags[id]; else state.ws.flags[id] = f;
    saveWorkspace();
  }
  function toggleShortlist(id) {
    if (isShort(id)) {
      state.ws.shortlist = state.ws.shortlist.filter((x) => x !== id);
      state.ws.blocks.forEach((b) => (b.items = b.items.filter((x) => x !== id)));
      toast("Removed from shortlist");
    } else {
      state.ws.shortlist.push(id);
      toast("★ Added to shortlist");
    }
    saveWorkspace();
  }

  // ---------- loading ----------
  async function load(refresh = false) {
    $("#refresh-btn").disabled = true;
    $("#refresh-btn").textContent = "↻ Loading…";
    $("#error").hidden = true;
    try {
      const res = await fetch("api/submissions" + (refresh ? "?refresh=1" : ""));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      state.meta = data.meta || {};
      state.demo = !!data.demo;
      state.syncedAt = data.synced_at ? new Date(data.synced_at * 1000) : null;
      state.films = (data.submissions || []).map(normalize);
      state.byId = new Map(state.films.map((f) => [f.id, f]));
      state.judging = (state.meta.granted_scopes || []).includes("submissions:judging_data") || state.films.some((f) => f.apiRating != null);
      renderAll();
      if (refresh) toast(`Synced ${fmtInt(state.films.length)} submissions`);
    } catch (err) {
      $("#error").textContent = "Couldn't load submissions.\n" + err.message;
      $("#error").hidden = false;
    } finally {
      $("#refresh-btn").disabled = false;
      $("#refresh-btn").textContent = "↻ Refresh";
    }
  }

  function renderAll() {
    renderHeader();
    renderKpis();
    renderCharts();
    fillFilterOptions();
    applyFilters();
    renderProgramme();
    renderInsights();
  }

  // ---------- header ----------
  function daysUntil(dateStr) {
    const d = new Date(dateStr + "T23:59:59");
    return Math.ceil((d - new Date()) / 86400000);
  }

  function renderHeader() {
    const m = state.meta;
    $("#demo-badge").hidden = !state.demo;
    const synced = state.syncedAt ? ` · synced ${state.syncedAt.toLocaleString()}` : "";
    $("#season-line").textContent = `${fmtInt(state.films.length)} submissions · season ${m.season_status || ""}${synced}`;
    const items = [];
    if (m.season_end_date) items.push(["Season closes", m.season_end_date]);
    const notes = [...new Set(state.films.map((f) => f.raw.notification_date).filter(Boolean))].sort();
    notes.forEach((d, i) => items.push([notes.length > 1 ? `Notification ${i + 1}` : "Notification day", d]));
    $("#countdowns").innerHTML = items.map(([label, d]) => {
      const n = daysUntil(d);
      const big = n > 0 ? `${n} day${n === 1 ? "" : "s"}` : n === 0 ? "Today" : "Passed";
      return `<div class="countdown"><b>${big}</b><span>${esc(label)} · ${esc(fmtDate(new Date(d + "T12:00:00")))}</span></div>`;
    }).join("");
    const scopes = m.granted_scopes || [];
    $("#scope-badges").innerHTML = [["submissions:judging_data", "Judging"], ["submissions:pii", "Contact info"]]
      .map(([s, l]) => `<span class="badge ${scopes.includes(s) ? "on" : ""}" title="${scopes.includes(s) ? "Your key has" : "Your key lacks"} the ${s} scope">${scopes.includes(s) ? "✓" : "–"} ${l}</span>`).join("");
  }

  // ---------- KPIs ----------
  function renderKpis() {
    const f = state.films.filter((x) => !/withdrawn|disqualified/i.test(x.status));
    const revenue = f.reduce((a, x) => a + x.fee, 0);
    const paid = f.filter((x) => x.fee > 0).length;
    const runtime = f.reduce((a, x) => a + (x.runtime || 0), 0);
    const countries = new Set(f.flatMap((x) => x.countries)).size;
    const directors = new Set(f.map((x) => x.director.toLowerCase())).size;
    const last7 = f.filter((x) => x.created && Date.now() - x.created < 7 * 86400000).length;
    const decided = Object.keys(state.ws.flags).length;
    const kpis = [
      [fmtInt(f.length), "Active submissions", `${fmtInt(state.films.length - f.length)} withdrawn/DQ`],
      [fmtMoney(revenue), "Entry-fee revenue", `avg ${fmtMoney(paid ? revenue / paid : 0)} per paid entry`],
      [`${fmtInt(paid)} / ${fmtInt(f.length - paid)}`, "Paid / free", ""],
      [fmtInt(last7), "New in last 7 days", ""],
      [`${fmtInt(Math.round(runtime / 60))} h`, "Total runtime to watch", `${fmtInt(Math.round(runtime / Math.max(f.length, 1)))} min average`],
      [fmtInt(countries), "Countries", ""],
      [fmtInt(directors), "Unique directors", ""],
      [fmtInt(f.filter((x) => x.first).length), "First-time filmmakers", ""],
      [fmtInt(f.filter((x) => x.student).length), "Student projects", ""],
      [fmtInt(f.filter((x) => x.ai === "ai_made").length), "AI-made (detected)", `${fmtInt(f.filter((x) => x.ai === "ai_topic").length)} more mention AI`],
      [fmtInt(f.filter((x) => x.trailer).length), "With trailer", ""],
      [fmtInt(f.filter((x) => x.dcp).length), "DCP available", ""],
      [`${fmtInt(decided)} / ${fmtInt(f.length)}`, "Decided by your team", `${fmtInt(state.ws.shortlist.length)} shortlisted`],
    ];
    $("#kpis").innerHTML = kpis.map(([v, l, e]) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(l)}</span>${e ? `<em>${esc(e)}</em>` : ""}</div>`).join("");
  }

  // ---------- charts ----------
  function countBy(films, fn) {
    const m = new Map();
    films.forEach((f) => [].concat(fn(f)).filter((k) => k !== "" && k != null).forEach((k) => m.set(k, (m.get(k) || 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  function barChart(el, rows, { limit = 12, filter, money = false } = {}) {
    const shown = rows.slice(0, limit);
    const max = Math.max(1, ...shown.map((r) => r[1]));
    const rest = rows.slice(limit).reduce((a, r) => a + r[1], 0);
    el.innerHTML = `<div class="bars">${shown.map(([k, v]) => `
      <div class="bar-row" data-key="${esc(k)}" title="${esc(k)}: ${money ? fmtMoney(v) : fmtInt(v)}">
        <span class="bar-label">${esc(k)}</span>
        <span class="bar-track"><span class="bar-fill" style="display:block;width:${(v / max) * 100}%"></span></span>
        <span class="bar-val">${money ? fmtMoney(v) : fmtInt(v)}</span>
      </div>`).join("")}</div>${rest ? `<p class="muted small">+ ${money ? fmtMoney(rest) : fmtInt(rest)} more in ${rows.length - limit} others</p>` : ""}`;
    if (filter) el.querySelectorAll(".bar-row").forEach((r) => r.addEventListener("click", () => filter(r.dataset.key)));
  }

  function jumpTo(setter) {
    clearFilters(false);
    setter();
    switchTab("submissions");
    applyFilters();
  }

  function renderCharts() {
    const f = state.films;
    renderTimeline(f);
    barChart($("#chart-categories"), countBy(f, (x) => x.categories), { limit: 14, filter: (k) => jumpTo(() => ($("#f-category").value = k)) });
    barChart($("#chart-deadlines"), countBy(f, (x) => x.deadline), { filter: (k) => jumpTo(() => ($("#f-deadline").value = k)) });
    barChart($("#chart-countries"), countBy(f, (x) => x.countries), { limit: 14, filter: (k) => jumpTo(() => ($("#f-country").value = k)) });
    barChart($("#chart-genres"), countBy(f, (x) => x.genres), { limit: 14, filter: (k) => jumpTo(() => ($("#f-genre").value = k)) });
    const buckets = [[0, 5, "Under 5 min"], [5, 10, "5–10 min"], [10, 20, "10–20 min"], [20, 40, "20–40 min"], [40, 70, "40–70 min"], [70, 100, "70–100 min"], [100, 1e9, "100+ min"]];
    const rt = buckets.map(([lo, hi, label]) => [label, f.filter((x) => x.runtime != null && x.runtime >= lo && x.runtime < hi).length]);
    barChart($("#chart-runtime"), rt, {
      limit: 10,
      filter: (k) => {
        const b = buckets.find((x) => x[2] === k);
        jumpTo(() => { $("#f-min").value = b[0] || ""; $("#f-max").value = b[1] < 1e9 ? b[1] : ""; });
      },
    });
    barChart($("#chart-languages"), countBy(f, (x) => x.languages), { limit: 12 });
    barChart($("#chart-types"), countBy(f, (x) => x.types), { limit: 10 });
    const rev = new Map();
    f.forEach((x) => x.categories.forEach((c) => rev.set(c, (rev.get(c) || 0) + x.fee / Math.max(1, x.categories.length))));
    barChart($("#chart-revenue"), [...rev.entries()].sort((a, b) => b[1] - a[1]), { limit: 14, money: true });
  }

  function renderTimeline(films) {
    const dates = films.map((f) => f.created).filter(Boolean).sort((a, b) => a - b);
    const el = $("#chart-timeline");
    if (!dates.length) { el.innerHTML = '<p class="muted">No dates.</p>'; return; }
    const week = 7 * 86400000;
    const start = dates[0].getTime();
    const n = Math.max(1, Math.floor((dates[dates.length - 1] - start) / week) + 1);
    const counts = new Array(n).fill(0);
    dates.forEach((d) => counts[Math.floor((d - start) / week)]++);
    const W = 1000, H = 180, P = 24;
    const maxC = Math.max(...counts);
    const x = (i) => P + (i / Math.max(1, n - 1)) * (W - 2 * P);
    const y = (v) => H - P - (v / maxC) * (H - 2 * P);
    let cum = 0;
    const cumPts = counts.map((c, i) => { cum += c; return [x(i), H - P - (cum / dates.length) * (H - 2 * P)]; });
    const pts = counts.map((c, i) => [x(i), y(c)]);
    const line = pts.map((p) => p.join(",")).join(" ");
    const area = `${x(0)},${H - P} ${line} ${x(n - 1)},${H - P}`;
    const labels = [];
    const step = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i < n; i += step) {
      const d = new Date(start + i * week);
      labels.push(`<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</text>`);
    }
    const peak = counts.indexOf(maxC);
    el.innerHTML = `<div class="timeline"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polygon class="area" points="${area}"/><polyline class="line" points="${line}"/>
      <polyline class="cum" points="${cumPts.map((p) => p.join(",")).join(" ")}"/>
      <text x="${x(peak)}" y="${y(maxC) - 6}" text-anchor="middle">peak ${maxC}/wk</text>
      <text x="${W - P}" y="${P - 6}" text-anchor="end">${fmtInt(dates.length)} total</text>
      ${labels.join("")}</svg>
      <div class="legend"><span><i style="background:var(--bar)"></i>per week</span><span><i style="background:var(--bar2)"></i>cumulative</span></div></div>`;
  }

  // ---------- filters & table ----------
  function fillSelect(sel, values, label) {
    const cur = sel.value;
    sel.innerHTML = `<option value="">${label}</option>` + values.map(([v, c]) => `<option value="${esc(v)}">${esc(v)} (${c})</option>`).join("");
    sel.value = cur;
  }

  function fillFilterOptions() {
    const f = state.films;
    fillSelect($("#f-category"), countBy(f, (x) => x.categories), "All categories");
    fillSelect($("#f-deadline"), countBy(f, (x) => x.deadline), "All deadlines");
    fillSelect($("#f-country"), countBy(f, (x) => x.countries).sort((a, b) => a[0].localeCompare(b[0])), "All countries");
    fillSelect($("#f-genre"), countBy(f, (x) => x.genres).sort((a, b) => a[0].localeCompare(b[0])), "All genres");
    fillSelect($("#f-status"), countBy(f, (x) => x.status), "All statuses");
  }

  function clearFilters(apply = true) {
    $$(".filters input, .filters select").forEach((el) => (el.type === "checkbox" ? (el.checked = false) : (el.value = "")));
    if (apply) applyFilters();
  }

  function applyFilters() {
    const q = $("#f-search").value.trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    const cat = $("#f-category").value, dl = $("#f-deadline").value, co = $("#f-country").value;
    const ge = $("#f-genre").value, st = $("#f-status").value, ai = $("#f-ai").value, fl = $("#f-flag").value;
    const stu = $("#f-student").checked, fir = $("#f-first").checked, tr = $("#f-trailer").checked;
    const mn = parseFloat($("#f-min").value), mx = parseFloat($("#f-max").value);
    state.filtered = state.films.filter((f) =>
      terms.every((t) => f.search.includes(t)) &&
      (!cat || f.categories.includes(cat)) && (!dl || f.deadline === dl) && (!co || f.countries.includes(co)) &&
      (!ge || f.genres.includes(ge)) && (!st || f.status === st) &&
      (!ai || (ai === "none" ? !f.ai : f.ai === ai)) &&
      (!fl || (fl === "shortlist" ? isShort(f.id) : fl === "unrated" ? !flag(f.id) : flag(f.id) === fl)) &&
      (!stu || f.student) && (!fir || f.first) && (!tr || f.trailer) &&
      (isNaN(mn) || (f.runtime != null && f.runtime >= mn)) && (isNaN(mx) || (f.runtime != null && f.runtime < mx)));
    sortFiltered();
    state.page = 0;
    renderTable();
  }

  const COLUMNS = () => [
    { key: "star", label: "★", get: (f) => (isShort(f.id) ? 1 : 0) },
    { key: "tracking", label: "Tracking #", get: (f) => f.tracking },
    { key: "title", label: "Title / category", get: (f) => f.title.toLowerCase() },
    { key: "director", label: "Director", get: (f) => f.director.toLowerCase() },
    { key: "country", label: "Country", get: (f) => f.country },
    { key: "runtime", label: "Runtime", get: (f) => f.runtime ?? -1 },
    { key: "deadline", label: "Deadline", get: (f) => f.deadline },
    { key: "fee", label: "Fee", get: (f) => f.fee },
    { key: "created", label: "Submitted", get: (f) => (f.created ? f.created.getTime() : 0) },
    ...(state.judging ? [
      { key: "apiRating", label: "FF rating", get: (f) => f.apiRating ?? -1 },
      { key: "acceptance", label: "FF status", get: (f) => f.acceptance },
    ] : []),
    { key: "mine", label: "My rating", get: (f) => rating(f.id) },
    { key: "flag", label: "Decision", get: (f) => ({ yes: 3, maybe: 2, no: 1 }[flag(f.id)] || 0) },
  ];

  function sortFiltered() {
    const col = COLUMNS().find((c) => c.key === state.sort.key) || COLUMNS()[8];
    const d = state.sort.dir;
    state.filtered.sort((a, b) => {
      const x = col.get(a), y = col.get(b);
      return (x < y ? -1 : x > y ? 1 : 0) * d;
    });
  }

  function tags(f) {
    let s = "";
    if (f.ai === "ai_made") s += '<span class="pill ai">AI-made</span>';
    if (f.ai === "ai_topic") s += '<span class="pill ai-topic">about AI</span>';
    if (f.student) s += '<span class="pill student">student</span>';
    if (f.first) s += '<span class="pill first">first-time</span>';
    if (f.laurels) s += `<span class="pill laurel">${f.laurels} laurel${f.laurels > 1 ? "s" : ""}</span>`;
    return s;
  }

  function renderTable() {
    const cols = COLUMNS();
    $("#sub-head").innerHTML = cols.map((c) => `<th data-key="${c.key}" class="${state.sort.key === c.key ? "sorted" : ""}">${esc(c.label)}${state.sort.key === c.key ? (state.sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("");
    const pageRows = state.filtered.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
    $("#sub-body").innerHTML = pageRows.map((f) => {
      const fl = flag(f.id);
      return `<tr data-id="${f.id}">
        <td><button class="star-btn" data-star="${f.id}" title="Shortlist">${isShort(f.id) ? "★" : "☆"}</button></td>
        <td class="muted">${esc(f.tracking)}</td>
        <td class="title">${esc(f.title)} ${tags(f)}<span class="cats">${esc(f.categories.join(" · "))}</span></td>
        <td>${esc(f.director)}</td>
        <td>${esc(f.country)}</td>
        <td>${fmtMin(f.runtime)}</td>
        <td>${esc(f.deadline)}</td>
        <td>${f.fee ? fmtMoney(f.fee) : '<span class="muted">free</span>'}</td>
        <td>${esc(fmtDate(f.created))}</td>
        ${state.judging ? `<td>${f.apiRating != null ? f.apiRating.toFixed(1) : "—"}</td><td>${esc(f.acceptance || "—")}</td>` : ""}
        <td style="color:var(--gold)">${"★".repeat(rating(f.id))}</td>
        <td class="flag-${fl}">${{ yes: "✓ Yes", maybe: "? Maybe", no: "✗ No" }[fl] || ""}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="${cols.length}" class="muted">No submissions match these filters.</td></tr>`;
    const total = state.filtered.length;
    const runtime = state.filtered.reduce((a, f) => a + (f.runtime || 0), 0);
    $("#result-count").textContent = `${fmtInt(total)} of ${fmtInt(state.films.length)} submissions · ${fmtMin(runtime)} of viewing`;
    const pages = Math.ceil(total / PAGE_SIZE);
    $("#pager").innerHTML = pages > 1
      ? `<button class="ghost" data-page="${state.page - 1}" ${state.page === 0 ? "disabled" : ""}>‹ Prev</button>
         <span class="muted">Page ${state.page + 1} of ${pages}</span>
         <button class="ghost" data-page="${state.page + 1}" ${state.page >= pages - 1 ? "disabled" : ""}>Next ›</button>`
      : "";
  }

  // ---------- drawer ----------
  function embedFor(url) {
    let m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/i);
    if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}`;
    m = url.match(/vimeo\.com\/(?:.*\/)?(\d{6,})(?:\/(\w+))?/i);
    if (m) return `https://player.vimeo.com/video/${m[1]}${m[2] ? `?h=${m[2]}` : ""}`;
    return null;
  }

  function openDrawer(id) {
    const f = state.byId.get(id);
    if (!f) return;
    state.drawerId = id;
    const p = f.raw.project || {};
    $("#d-tracking").textContent = `${f.tracking} · ${f.status} · submitted ${fmtDate(f.created)}`;
    $("#d-title").textContent = f.title;
    $("#d-byline").innerHTML = `Directed by <b>${esc(f.director)}</b> · ${esc(f.country)} · ${fmtMin(f.runtime)} ${tags(f)}`;
    renderDecision();
    $("#d-notes").value = state.ws.notes[id] || "";

    const facts = [
      ["Categories", f.categories.join(", ")], ["Deadline", f.deadline], ["Fee paid", f.feeStr + (f.discount ? ` (code ${f.discount.code})` : "")],
      ["Genres", f.genres.join(", ")], ["Languages", f.languages.join(", ")], ["Type", f.types.join(", ")],
      ["Completed", p.completion_date], ["Budget", p.budget], ["Shooting format", p.shooting_format],
      ["Aspect ratio", p.aspect_ratio], ["Colour", p.film_color], ["DCP", f.dcp ? "Available" : "No"],
      ["Student", f.student ? "Yes" : "No"], ["First-time filmmaker", f.first ? "Yes" : "No"],
      ...(state.judging ? [["FilmFreeway rating", f.apiRating != null ? `${f.apiRating} (${f.apiRatingCount || 0} ratings)` : "—"], ["FilmFreeway status", f.acceptance], ["Judges", (f.judges || []).map((j) => j.name || j.email || j).join(", ")]] : []),
    ].filter(([, v]) => v);

    const embed = f.trailer && embedFor(f.trailer);
    const links = [
      f.trailer && isHttps(f.trailer) ? `<a href="${esc(f.trailer)}" target="_blank" rel="noopener noreferrer">Trailer ↗</a>` : "",
      f.screener && isHttps(f.screener) ? `<a href="${esc(f.screener)}" target="_blank" rel="noopener noreferrer">Screener ↗</a>` : "",
    ].filter(Boolean).join(" · ");

    const credits = (p.credits || []).map((c) => `<dt>${esc(c.type)}</dt><dd>${(c.entries || []).map((e) => esc(e.name || [e.first_name, e.last_name].join(" ")) + (e.character_name ? ` <span class="muted">as ${esc(e.character_name)}</span>` : "")).join(", ")}</dd>`).join("");
    const screenings = (p.screenings || []).filter((s) => clean(s.event_name)).map((s) =>
      `<div class="ins-row"><span>🏅 <b>${esc(s.event_name)}</b> ${esc(s.location || "")}</span><span class="muted">${esc([s.date, s.premiere_status, s.awards_won].filter((x) => x && x !== "None").join(" · "))}</span></div>`).join("");
    const custom = (f.raw.custom_fields || []).map((c) => `<div class="ins-row"><span>${esc(c.question || c.name || c.label || "")}</span><span>${esc(c.answer ?? c.value ?? "")}</span></div>`).join("");

    $("#d-body").innerHTML = `
      <p>${links}</p>
      ${embed ? `<div class="video"><iframe src="${esc(embed)}" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>` : ""}
      <div class="media" id="d-media"></div>
      <div class="facts">${facts.map(([k, v]) => `<div><span>${esc(k)}</span>${esc(v)}</div>`).join("")}</div>
      ${f.synopsis ? `<div class="section-title">Synopsis</div><p class="prose">${esc(f.synopsis)}</p>` : ""}
      ${clean(f.raw.cover_letter) ? `<div class="section-title">Cover letter</div><p class="prose">${esc(f.raw.cover_letter)}</p>` : ""}
      ${clean(p.press_kit_statement) ? `<div class="section-title">Director's statement</div><p class="prose">${esc(p.press_kit_statement)}</p>` : ""}
      ${clean(p.press_kit_biography) ? `<div class="section-title">Biography</div><p class="prose">${esc(p.press_kit_biography)}</p>` : ""}
      ${screenings ? `<div class="section-title">Screenings &amp; awards</div>${screenings}` : ""}
      ${credits ? `<div class="section-title">Credits</div><dl class="credits">${credits}</dl>` : ""}
      ${custom ? `<div class="section-title">Your custom questions</div>${custom}` : ""}
      ${f.raw.submission_notes ? `<div class="section-title">FilmFreeway notes</div><p class="prose">${esc(typeof f.raw.submission_notes === "string" ? f.raw.submission_notes : JSON.stringify(f.raw.submission_notes, null, 1))}</p>` : ""}`;

    $("#drawer").classList.add("open");
    $("#scrim").classList.add("open");
    $("#drawer").setAttribute("aria-hidden", "false");
    $("#drawer").scrollTop = 0;
    loadMedia(id);
  }

  async function loadMedia(id) {
    if (state.demo) return;
    try {
      const res = await fetch(`api/submissions/${id}`);
      if (!res.ok || state.drawerId !== id) return;
      const d = await res.json();
      const imgs = [d.poster_url, d.project_still_url, d.trailer_still_url, (d.project || {}).poster_url]
        .flat().filter(isHttps);
      const pdfs = [].concat(d.pdf_links || []).map((x) => (typeof x === "string" ? x : x && (x.url || x.link))).filter(isHttps);
      $("#d-media").innerHTML = [...new Set(imgs)].map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`).join("") +
        pdfs.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">📄 Document ${i + 1}</a>`).join(" ");
    } catch (_) { /* images are optional */ }
  }

  function renderDecision() {
    const id = state.drawerId;
    if (id == null) return;
    $("#d-stars").innerHTML = [1, 2, 3, 4, 5].map((n) => `<button data-rate="${n}" class="${n <= rating(id) ? "on" : ""}" title="${n} star${n > 1 ? "s" : ""} (${n})">★</button>`).join("");
    $$("#d-flag button").forEach((b) => b.classList.toggle("on", b.dataset.flag === flag(id)));
    $("#d-shortlist").textContent = isShort(id) ? "★ Shortlisted" : "☆ Shortlist";
    $("#d-shortlist").classList.toggle("on", isShort(id));
  }

  function closeDrawer() {
    state.drawerId = null;
    $("#drawer").classList.remove("open");
    $("#scrim").classList.remove("open");
    $("#drawer").setAttribute("aria-hidden", "true");
  }

  function stepDrawer(delta) {
    const list = state.filtered.length ? state.filtered : state.films;
    const i = list.findIndex((f) => f.id === state.drawerId);
    const next = list[i + delta];
    if (next) openDrawer(next.id);
  }

  function afterDecision() {
    renderDecision();
    renderTable();
    renderProgramme();
    renderKpis();
  }

  // ---------- shortlist & programme ----------
  const blockId = () => "b" + Math.random().toString(36).slice(2, 9);

  function filmLi(f, extra = "") {
    return `<li class="film" draggable="true" data-id="${f.id}">
      <div><div class="t">${esc(f.title)} <span style="color:var(--gold)">${"★".repeat(rating(f.id))}</span></div>
      <div class="m">${esc(f.director)} · ${esc(f.country)} · ${fmtMin(f.runtime)} · ${esc(f.categories[0] || "")}</div></div>
      <div>${extra}</div></li>`;
  }

  function renderProgramme() {
    const assigned = new Set(state.ws.blocks.flatMap((b) => b.items));
    const sortKey = $("#shortlist-sort").value;
    const films = state.ws.shortlist.map((id) => state.byId.get(id)).filter(Boolean);
    const sorters = {
      rating: (a, b) => rating(b.id) - rating(a.id),
      title: (a, b) => a.title.localeCompare(b.title),
      runtime: (a, b) => (a.runtime || 0) - (b.runtime || 0),
      category: (a, b) => (a.categories[0] || "").localeCompare(b.categories[0] || ""),
    };
    films.sort(sorters[sortKey]);
    const total = films.reduce((a, f) => a + (f.runtime || 0), 0);
    $("#shortlist-count").textContent = `${films.length} films · ${fmtMin(total)} · ${films.filter((f) => !assigned.has(f.id)).length} unscheduled`;
    $("#shortlist").innerHTML = films.map((f) => filmLi(f, `${assigned.has(f.id) ? '<span class="muted small">scheduled</span>' : ""} <button class="ghost" data-open="${f.id}">View</button>`)).join("") ||
      '<li class="muted">Nothing shortlisted yet.</li>';

    $("#blocks").innerHTML = state.ws.blocks.map((b) => {
      const items = b.items.map((id) => state.byId.get(id)).filter(Boolean);
      const used = items.reduce((a, f) => a + (f.runtime || 0), 0);
      const target = Number(b.target) || 90;
      const over = used > target;
      return `<div class="block" data-block="${b.id}">
        <div class="block-head">
          <input type="text" value="${esc(b.name)}" data-bname="${b.id}">
          <label class="small muted">Target <input type="number" min="1" value="${target}" data-btarget="${b.id}"> min</label>
          <button class="ghost" data-bdel="${b.id}" title="Delete block">🗑</button>
        </div>
        <div class="meter ${over ? "over" : ""}"><div style="width:${Math.min(100, (used / target) * 100)}%"></div></div>
        <div class="small ${over ? "flag-no" : "muted"}">${fmtMin(used)} of ${fmtMin(target)} · ${items.length} film${items.length === 1 ? "" : "s"}${over ? ` · ${fmtMin(used - target)} over` : ` · ${fmtMin(target - used)} free`}</div>
        <ul class="film-list" data-drop="${b.id}">${items.map((f, i) => filmLi(f, `<button class="ghost" data-up="${b.id}:${i}" title="Move up">↑</button><button class="ghost" data-rm="${b.id}:${f.id}" title="Remove">✕</button>`)).join("") || '<li class="muted small">Drop films here</li>'}</ul>
      </div>`;
    }).join("") || '<p class="muted">Create a block (e.g. "Saturday 2pm — Shorts I"), then drag shortlisted films into it.</p>';
  }

  function addBlock() {
    state.ws.blocks.push({ id: blockId(), name: `Block ${state.ws.blocks.length + 1}`, target: 90, items: [] });
    saveWorkspace();
    renderProgramme();
  }

  // ---------- insights ----------
  function insightRows(el, rows, empty) {
    el.innerHTML = rows.length ? rows.slice(0, 40).join("") + (rows.length > 40 ? `<p class="muted small">+ ${rows.length - 40} more</p>` : "") : `<p class="muted">${empty}</p>`;
  }
  const filmLink = (f) => `<span class="link" data-open="${f.id}">${esc(f.title)}</span>`;

  function renderInsights() {
    const f = state.films;
    const byDir = new Map();
    f.forEach((x) => x.directors.forEach((d) => { const k = d.toLowerCase(); if (!byDir.has(k)) byDir.set(k, { name: d, films: [] }); byDir.get(k).films.push(x); }));
    const repeat = [...byDir.values()].filter((d) => d.films.length > 1).sort((a, b) => b.films.length - a.films.length);
    insightRows($("#ins-repeat"), repeat.map((d) => `<div class="ins-row"><span><b>${esc(d.name)}</b> — ${d.films.map(filmLink).join(", ")}</span><span class="muted">${d.films.length} · ${fmtMoney(d.films.reduce((a, x) => a + x.fee, 0))}</span></div>`), "No repeat submitters.");

    const byTitle = new Map();
    f.forEach((x) => { const k = x.title.toLowerCase().replace(/[^a-z0-9]/g, ""); if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(x); });
    const dupes = [...byTitle.values()].filter((l) => l.length > 1).sort((a, b) => b.length - a.length);
    insightRows($("#ins-dupes"), dupes.map((l) => `<div class="ins-row"><span>${filmLink(l[0])}</span><span class="muted">${l.map((x) => `<span class="link" data-open="${x.id}">${esc(x.tracking)}</span>`).join(", ")} · ${esc([...new Set(l.flatMap((x) => x.categories))].join(" / "))}</span></div>`), "No duplicate titles.");

    const fit = f.filter((x) => x.runtime != null && x.categories.some((c) => (/under 40/i.test(c) && x.runtime >= 40.5) || (/40 minutes & over/i.test(c) && x.runtime < 40)));
    insightRows($("#ins-fit"), fit.map((x) => `<div class="ins-row"><span>${filmLink(x)}</span><span class="muted">${fmtMin(x.runtime)} in ${esc(x.categories.join(", "))}</span></div>`), "Every runtime fits its category.");

    const missing = f.filter((x) => !x.synopsis || (!x.trailer && !x.screener));
    insightRows($("#ins-missing"), missing.map((x) => `<div class="ins-row"><span>${filmLink(x)}</span><span class="muted">${[!x.synopsis && "no synopsis", !x.trailer && !x.screener && "no trailer/screener link"].filter(Boolean).join(", ")}</span></div>`), "Nothing missing.");

    const laurels = f.filter((x) => x.awards.length || x.laurels >= 2).sort((a, b) => b.awards.length - a.awards.length || b.laurels - a.laurels);
    insightRows($("#ins-laurels"), laurels.map((x) => `<div class="ins-row"><span>${filmLink(x)}</span><span class="muted">${x.laurels} festivals${x.awards.length ? " · 🏆 " + esc(x.awards.map((a) => clean(a.awards_won)).join(", ")) : ""}</span></div>`), "No laurels listed.");

    const codes = countBy(f.filter((x) => x.discount), (x) => `${x.discount.code}${x.discount.amount ? " (" + x.discount.amount + ")" : ""}`);
    insightRows($("#ins-discounts"), codes.map(([k, v]) => `<div class="ins-row"><span>${esc(k)}</span><span class="muted">${v} uses</span></div>`), "No discount codes used.");
  }

  // ---------- exports ----------
  function csvCell(v) {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running formulas
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function download(name, text, type = "text/csv;charset=utf-8") {
    const blob = new Blob([type.startsWith("text/csv") ? "﻿" + text : text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function filmsCsv(films) {
    const head = ["Tracking #", "Title", "Director", "Categories", "Deadline", "Status", "Country", "Runtime (min)", "Fee", "Submitted", "Genres", "Languages", "Student", "First-time", "AI", "Trailer", "Laurels", ...(state.judging ? ["FF rating", "FF status"] : []), "My rating", "Decision", "Shortlisted", "Notes", "Synopsis"];
    const rows = films.map((f) => [f.tracking, f.title, f.director, f.categories.join("; "), f.deadline, f.status, f.country, f.runtime ? f.runtime.toFixed(1) : "", f.fee, f.created ? f.created.toISOString().slice(0, 10) : "", f.genres.join("; "), f.languages.join("; "), f.student ? "yes" : "", f.first ? "yes" : "", f.ai.replace("_", " "), f.trailer, f.laurels, ...(state.judging ? [f.apiRating ?? "", f.acceptance] : []), rating(f.id) || "", flag(f.id), isShort(f.id) ? "yes" : "", state.ws.notes[f.id] || "", f.synopsis]);
    return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  function programmeRows() {
    const rows = [];
    state.ws.blocks.forEach((b) => {
      let t = 0;
      b.items.map((id) => state.byId.get(id)).filter(Boolean).forEach((f, i) => {
        rows.push({ block: b.name, order: i + 1, offset: t, f });
        t += f.runtime || 0;
      });
    });
    return rows;
  }

  function printablePage(title, bodyHtml) {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
      body{font-family:Georgia,serif;max-width:820px;margin:40px auto;padding:0 20px;color:#1d1b19}
      h1{font-size:30px;margin-bottom:4px} .sub{color:#777;margin-top:0} h2{margin-top:36px;border-bottom:2px solid #b5532a;padding-bottom:4px}
      .film{margin:18px 0;page-break-inside:avoid} .film h3{margin:0;font-size:19px} .meta{color:#666;font-size:13px;margin:2px 0 6px}
      .film p{margin:0;font-size:14px;line-height:1.5} .notes{color:#555;font-style:italic;font-size:13px;margin-top:4px}
      @media print{.noprint{display:none}}</style></head><body>
      <p class="noprint"><button onclick="print()">Print / save as PDF</button></p>${bodyHtml}</body></html>`;
    const w = window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })), "_blank");
    if (!w) toast("Allow pop-ups to open the page");
  }
  const filmBlock = (f, notes) => `<div class="film"><h3>${esc(f.title)}</h3>
    <div class="meta">Dir. ${esc(f.director)} · ${esc(f.country)} · ${fmtMin(f.runtime)} · ${esc(f.categories.join(", "))}</div>
    <p>${esc(f.synopsis)}</p>${notes && state.ws.notes[f.id] ? `<div class="notes">Notes: ${esc(state.ws.notes[f.id])}</div>` : ""}</div>`;

  // ---------- events ----------
  function switchTab(name) {
    $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
    try { localStorage.setItem("hub-tab", name); } catch (_) { /* optional */ }
  }

  function bind() {
    $("#tabs").addEventListener("click", (e) => e.target.dataset.tab && switchTab(e.target.dataset.tab));
    $("#refresh-btn").addEventListener("click", () => load(true));
    $("#theme-btn").addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.dataset.theme = dark ? "light" : "dark";
      try { localStorage.setItem("hub-theme", document.documentElement.dataset.theme); } catch (_) { /* optional */ }
    });

    let searchTimer;
    $("#f-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(applyFilters, 150); });
    $$(".filters select, .filters input[type=checkbox], .filters input[type=number]").forEach((el) => el.addEventListener("change", applyFilters));
    $("#f-clear").addEventListener("click", () => clearFilters());

    $("#sub-head").addEventListener("click", (e) => {
      const th = e.target.closest("th");
      if (!th) return;
      const key = th.dataset.key;
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (["title", "director", "country", "tracking", "deadline"].includes(key) ? 1 : -1) };
      sortFiltered();
      renderTable();
    });
    $("#sub-body").addEventListener("click", (e) => {
      const star = e.target.closest("[data-star]");
      if (star) { e.stopPropagation(); toggleShortlist(Number(star.dataset.star)); afterDecision(); return; }
      const tr = e.target.closest("tr[data-id]");
      if (tr) openDrawer(Number(tr.dataset.id));
    });
    $("#pager").addEventListener("click", (e) => {
      const b = e.target.closest("[data-page]");
      if (b) { state.page = Number(b.dataset.page); renderTable(); $(".table-wrap").scrollIntoView({ block: "start" }); }
    });

    $("#d-close").addEventListener("click", closeDrawer);
    $("#scrim").addEventListener("click", closeDrawer);
    $("#d-prev").addEventListener("click", () => stepDrawer(-1));
    $("#d-next").addEventListener("click", () => stepDrawer(1));
    $("#d-stars").addEventListener("click", (e) => { const b = e.target.closest("[data-rate]"); if (b) { setRating(state.drawerId, Number(b.dataset.rate)); afterDecision(); } });
    $("#d-flag").addEventListener("click", (e) => { const b = e.target.closest("[data-flag]"); if (b) { setFlag(state.drawerId, b.dataset.flag); afterDecision(); } });
    $("#d-shortlist").addEventListener("click", () => { toggleShortlist(state.drawerId); afterDecision(); });
    $("#d-notes").addEventListener("input", (e) => {
      const v = e.target.value;
      if (v.trim()) state.ws.notes[state.drawerId] = v; else delete state.ws.notes[state.drawerId];
      saveWorkspace();
    });

    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === "Escape") { if (typing) document.activeElement.blur(); else closeDrawer(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); switchTab("submissions"); $("#f-search").focus(); return; }
      if (state.drawerId == null) return;
      const id = state.drawerId;
      if (e.key === "j") stepDrawer(1);
      else if (e.key === "k") stepDrawer(-1);
      else if (/^[1-5]$/.test(e.key)) { setRating(id, Number(e.key)); afterDecision(); }
      else if (e.key === "y" || e.key === "m" || e.key === "n") { setFlag(id, { y: "yes", m: "maybe", n: "no" }[e.key]); afterDecision(); }
      else if (e.key === "s") { toggleShortlist(id); afterDecision(); }
    });

    // Insight and programme "view" links
    document.addEventListener("click", (e) => {
      const o = e.target.closest("[data-open]");
      if (o) openDrawer(Number(o.dataset.open));
    });

    // Programme blocks
    $("#add-block").addEventListener("click", addBlock);
    $("#shortlist-sort").addEventListener("change", renderProgramme);
    const prog = $("#tab-programme");
    prog.addEventListener("input", (e) => {
      const t = e.target;
      const b = state.ws.blocks.find((x) => x.id === (t.dataset.bname || t.dataset.btarget));
      if (!b) return;
      if (t.dataset.bname) b.name = t.value;
      if (t.dataset.btarget) { b.target = Number(t.value) || 90; renderProgramme(); }
      saveWorkspace();
    });
    prog.addEventListener("click", (e) => {
      const del = e.target.closest("[data-bdel]");
      if (del && confirm("Delete this block? Films stay on the shortlist.")) {
        state.ws.blocks = state.ws.blocks.filter((b) => b.id !== del.dataset.bdel);
      }
      const rm = e.target.closest("[data-rm]");
      if (rm) {
        const [bid, fid] = rm.dataset.rm.split(":");
        const b = state.ws.blocks.find((x) => x.id === bid);
        b.items = b.items.filter((x) => String(x) !== fid);
      }
      const up = e.target.closest("[data-up]");
      if (up) {
        const [bid, i] = up.dataset.up.split(":");
        const b = state.ws.blocks.find((x) => x.id === bid);
        const n = Number(i);
        if (n > 0) [b.items[n - 1], b.items[n]] = [b.items[n], b.items[n - 1]];
      }
      if (del || rm || up) { saveWorkspace(); renderProgramme(); }
    });
    prog.addEventListener("dragstart", (e) => {
      const li = e.target.closest(".film");
      if (!li) return;
      li.classList.add("dragging");
      e.dataTransfer.setData("text/plain", li.dataset.id);
    });
    prog.addEventListener("dragend", (e) => e.target.closest(".film")?.classList.remove("dragging"));
    prog.addEventListener("dragover", (e) => {
      const blk = e.target.closest(".block");
      if (!blk) return;
      e.preventDefault();
      $$(".block.over").forEach((b) => b !== blk && b.classList.remove("over"));
      blk.classList.add("over");
    });
    prog.addEventListener("dragleave", (e) => { const blk = e.target.closest(".block"); if (blk && !blk.contains(e.relatedTarget)) blk.classList.remove("over"); });
    prog.addEventListener("drop", (e) => {
      const blk = e.target.closest(".block");
      if (!blk) return;
      e.preventDefault();
      blk.classList.remove("over");
      const id = Number(e.dataTransfer.getData("text/plain"));
      if (!state.byId.has(id)) return;
      state.ws.blocks.forEach((b) => (b.items = b.items.filter((x) => x !== id)));
      state.ws.blocks.find((b) => b.id === blk.dataset.block).items.push(id);
      saveWorkspace();
      renderProgramme();
    });

    // Exports
    $("#exp-filtered").addEventListener("click", () => download(`submissions-filtered-${stamp()}.csv`, filmsCsv(state.filtered)));
    $("#exp-all").addEventListener("click", () => download(`submissions-all-${stamp()}.csv`, filmsCsv(state.films)));
    $("#exp-shortlist").addEventListener("click", () => download(`shortlist-${stamp()}.csv`, filmsCsv(state.ws.shortlist.map((id) => state.byId.get(id)).filter(Boolean))));
    $("#exp-programme").addEventListener("click", () => {
      const head = ["Block", "Order", "Starts at (min into block)", "Tracking #", "Title", "Director", "Country", "Runtime (min)", "Category"];
      const rows = programmeRows().map((r) => [r.block, r.order, Math.round(r.offset), r.f.tracking, r.f.title, r.f.director, r.f.country, r.f.runtime ? r.f.runtime.toFixed(1) : "", r.f.categories.join("; ")]);
      download(`programme-${stamp()}.csv`, [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n"));
    });
    $("#exp-tracking").addEventListener("click", async () => {
      const text = state.ws.shortlist.map((id) => state.byId.get(id)).filter(Boolean).map((f) => f.tracking).join("\n");
      try { await navigator.clipboard.writeText(text); toast("Copied tracking numbers"); } catch (_) { prompt("Copy these:", text.replace(/\n/g, ", ")); }
    });
    $("#exp-selections").addEventListener("click", () => {
      const films = state.ws.shortlist.map((id) => state.byId.get(id)).filter(Boolean);
      const byCat = new Map();
      films.forEach((f) => { const c = f.categories[0] || "Other"; if (!byCat.has(c)) byCat.set(c, []); byCat.get(c).push(f); });
      printablePage("Official Selections", `<h1>Official Selections</h1><p class="sub">${films.length} films · ${fmtMin(films.reduce((a, f) => a + (f.runtime || 0), 0))}</p>` +
        [...byCat.entries()].map(([c, l]) => `<h2>${esc(c)}</h2>${l.map((f) => filmBlock(f, false)).join("")}`).join(""));
    });
    $("#exp-programme-page").addEventListener("click", () => {
      printablePage("Festival Programme", `<h1>Festival Programme</h1>` + state.ws.blocks.map((b) => {
        const items = b.items.map((id) => state.byId.get(id)).filter(Boolean);
        return `<h2>${esc(b.name)}</h2><p class="sub">${items.length} films · ${fmtMin(items.reduce((a, f) => a + (f.runtime || 0), 0))}</p>${items.map((f) => filmBlock(f, false)).join("")}`;
      }).join(""));
    });
    $("#exp-workspace").addEventListener("click", () => download(`festival-hub-workspace-${stamp()}.json`, JSON.stringify(state.ws, null, 1), "application/json"));
    $("#imp-workspace").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const ws = JSON.parse(await file.text());
        if (typeof ws !== "object" || !ws) throw new Error();
        if (!confirm("Replace your current ratings, notes, shortlist and blocks with this backup?")) return;
        state.ws = Object.assign({ ratings: {}, flags: {}, notes: {}, shortlist: [], blocks: [] }, ws);
        saveWorkspace();
        renderAll();
        toast("Workspace restored");
      } catch (_) { toast("That file isn't a workspace backup"); }
      e.target.value = "";
    });
  }

  async function init() {
    try {
      const theme = localStorage.getItem("hub-theme");
      if (theme) document.documentElement.dataset.theme = theme;
      const tab = localStorage.getItem("hub-tab");
      if (tab && $("#tab-" + tab)) switchTab(tab);
    } catch (_) { /* optional */ }
    bind();
    await loadWorkspace();
    await load(false);
  }

  init();
})();
