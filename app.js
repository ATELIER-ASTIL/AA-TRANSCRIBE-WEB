/* AA TRANSCRIBE — webpage edition.
   Everything runs in this browser: recordings, transcripts and the speech model stay on this device. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const view = $("#view");
const MOCK = new URLSearchParams(location.search).get("mock") === "1";
let timers = [], cleanup = [];

const LANGS = [
  ["auto", "Detect automatically (mixed languages)"], ["en", "English"], ["hi", "Hindi"], ["kn", "Kannada"], ["ta", "Tamil"],
  ["te", "Telugu"], ["ml", "Malayalam"], ["mr", "Marathi"], ["gu", "Gujarati"], ["bn", "Bengali"],
  ["pa", "Punjabi"], ["ur", "Urdu"], ["ar", "Arabic"], ["fr", "French"], ["de", "German"], ["es", "Spanish"],
  ["it", "Italian"], ["pt", "Portuguese"], ["ja", "Japanese"], ["zh", "Chinese"], ["ru", "Russian"],
];
const langName = (c) => (LANGS.find((l) => l[0] === c) || [c, (c || "—").toUpperCase()])[1];
const MODEL_INFO = {
  best: { name: "Best accuracy", detail: "Whisper large-v3-turbo at full precision · about 1.6 GB, downloaded once · used for live text too · needs a laptop or desktop with graphics acceleration" },
  balanced: { name: "Balanced", detail: "Whisper small · 500 MB to 1 GB depending on the device · works on most computers" },
  fast: { name: "Fast", detail: "Whisper base · about 80 MB · quick drafts, lower accuracy" },
};

/* ---------------------------------------------------------------- utilities */
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms);
}
function fmtTime(sec, long = false) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h || long ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
const fmtDate = (t) => new Date(t).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const reg = (n) => String(n).padStart(2, "0");
const uid = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
function every(fn, ms) { const h = setInterval(fn, ms); timers.push(h); return h; }
function teardown() { timers.forEach(clearInterval); timers = []; cleanup.forEach((f) => { try { f(); } catch (_) {} }); cleanup = []; }
const langOptions = (sel) => LANGS.map(([c, n]) => `<option value="${c}" ${c === sel ? "selected" : ""}>${n}</option>`).join("");
const fmtBytes = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + " GB" : Math.round(b / 1e6) + " MB");

/* ---------------------------------------------------------------- settings (this browser) */
const DEFAULT_SETTINGS = {
  v: 2, model: "", language: "auto", mode: "english",
  vocabulary: ["Atelier Astil", "Arpita", "BOQ", "GFC", "IFC", "MEP", "HVAC", "FCU", "AHU", "VRF", "VRV", "BMS", "PHE",
    "FF&E", "AutoCAD", "XREF", "BBMP", "NBC", "LEED", "IGBC", "WELL", "CCTV", "RCP", "PU finish", "Corian", "Italian marble",
    "pelmet", "roman blind", "roller blind", "snag list", "shop drawing", "GA drawing", "Bengaluru"],
  replacements: [
    { find: "atelier a still", replace: "Atelier Astil" }, { find: "atelier astel", replace: "Atelier Astil" },
    { find: "b o q", replace: "BOQ" }, { find: "v r f", replace: "VRF" }, { find: "f c u", replace: "FCU" }, { find: "a h u", replace: "AHU" },
  ],
};
function getSettings() {
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem("aa_settings") || "{}"); } catch (_) {}
  if ((stored.v || 1) < 2) {            // earlier versions: English output becomes the default
    stored.mode = stored.task === "transcribe" ? "english" : "english";
    stored.language = "auto"; stored.v = 2; delete stored.task;
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}
const OUTPUTS = [["english", "English — translate every language"], ["original", "Spoken language as is"]];
const outputOptions = (sel) => OUTPUTS.map(([v, n]) => `<option value="${v}" ${v === sel ? "selected" : ""}>${n}</option>`).join("");
function saveSettings(s) { try { localStorage.setItem("aa_settings", JSON.stringify(s)); } catch (_) {} }

function makeCorrector(vocab, reps) {
  const re = (phrase) => new RegExp("(?<![\\w])" + phrase.trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+") + "(?![\\w])", "gi");
  const rules = (reps || []).filter((r) => r.find && r.find.trim()).map((r) => [re(r.find), r.replace]);
  const multi = (vocab || []).filter((t) => t.includes(" ")).sort((a, b) => b.length - a.length).map((t) => [re(t), t]);
  const single = new Map((vocab || []).filter((t) => t.trim() && !t.includes(" ")).map((t) => [t.toLowerCase(), t]));
  return (text) => {
    if (!text) return text;
    for (const [r, t] of rules) text = text.replace(r, t);
    for (const [r, t] of multi) text = text.replace(r, t);
    return text.replace(/[\p{L}\p{N}&'\-]+/gu, (w) => single.get(w.toLowerCase()) || w);
  };
}

/* ---------------------------------------------------------------- device capability */
const DEVICE = { webgpu: false, f16: false, checked: false };
async function checkDevice() {
  if (DEVICE.checked) return DEVICE;
  DEVICE.checked = true;
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) { DEVICE.webgpu = true; DEVICE.f16 = adapter.features.has("shader-f16"); }
    }
  } catch (_) {}
  return DEVICE;
}
function autoModel() { return DEVICE.webgpu && DEVICE.f16 ? "best" : "balanced"; }
function chosenModel() { const s = getSettings(); return s.model || autoModel(); }
function spokenLabel(r) {
  const sp = (r.spoken || []).map(langName);
  const into = r.language === "en" && sp.length && !(sp.length === 1 && r.spoken[0] === "en") ? " → English" : "";
  return (sp.join(" + ") || langName(r.language)) + into;
}

/* ---------------------------------------------------------------- storage (IndexedDB) */
const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open("aa-transcribe", 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("recordings", { keyPath: "id" });
        db.createObjectStore("audio");
      };
      r.onsuccess = () => { this._db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx("recordings", "readonly", (s) => s.getAll()); },
  get(id) { return this.tx("recordings", "readonly", (s) => s.get(id)); },
  put(rec) { rec.updated = Date.now(); return this.tx("recordings", "readwrite", (s) => s.put(rec)); },
  async del(id) { await this.tx("recordings", "readwrite", (s) => s.delete(id)); await this.tx("audio", "readwrite", (s) => s.delete(id)); },
  putAudio(id, blob) { return this.tx("audio", "readwrite", (s) => s.put(blob, id)); },
  getAudio(id) { return this.tx("audio", "readonly", (s) => s.get(id)); },
};
async function patch(id, changes) { const r = await DB.get(id); if (!r) return null; Object.assign(r, changes); await DB.put(r); return r; }

/* ---------------------------------------------------------------- audio decoding */
async function decodeTo16k(blob) {
  const buf = await blob.arrayBuffer();
  let decoded;
  try {
    const ctx = new AudioContext({ sampleRate: 16000 });
    decoded = await ctx.decodeAudioData(buf.slice(0));
    ctx.close().catch(() => {});
  } catch (_) {
    const ctx = new AudioContext();
    const native = await ctx.decodeAudioData(buf.slice(0));
    ctx.close().catch(() => {});
    const off = new OfflineAudioContext(1, Math.ceil(native.duration * 16000), 16000);
    const src = off.createBufferSource(); src.buffer = native; src.connect(off.destination); src.start();
    decoded = await off.startRendering();
  }
  const n = decoded.length, chs = decoded.numberOfChannels;
  const mono = new Float32Array(n);
  for (let c = 0; c < chs; c++) { const d = decoded.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / chs; }
  let peak = 0; for (let i = 0; i < n; i += 7) { const a = Math.abs(mono[i]); if (a > peak) peak = a; }
  if (peak > 0 && peak < 0.5) { const g = 0.9 / peak; for (let i = 0; i < n; i++) mono[i] *= g; }
  return mono;
}

/* ---------------------------------------------------------------- transcription queue */
const worker = new Worker(new URL("worker.js" + (MOCK ? "?mock=1" : ""), import.meta.url), { type: "module" });
const queue = [];
let active = null;          // { id, resolve, reject }
const listeners = new Set();
const emit = (e) => listeners.forEach((f) => f(e));

const liveHandlers = new Set();
worker.onmessage = async (ev) => {
  const m = ev.data;
  if (m.type && m.type.startsWith("live-")) { liveHandlers.forEach((f) => f(m)); return; }
  if (!active) return;
  if (m.type === "download") {
    showJob("Downloading speech model", `${Math.round(m.progress || 0)}% of ${m.total ? fmtBytes(m.total) : "…"} · one time only on this browser`, (m.progress || 0) / 100);
  } else if (m.type === "stage") {
    showJob(m.stage, active.title, active.progress || 0);
    if (m.device) active.device = m.device;
  } else if (m.type === "progress") {
    active.progress = m.progress;
    showJob("Transcribing", `${active.title} · ${Math.round(m.progress * 100)}%`, m.progress);
    patch(active.id, { progress: m.progress });
  } else if (m.type === "live") {
    emit({ type: "live", id: active.id, text: m.text });
  } else if (m.type === "done" || m.type === "error") {
    const job = active; active = null;
    if (m.type === "done") {
      const s = getSettings(), fix = makeCorrector(s.vocabulary, s.replacements);
      const segments = mergeSegments(m.segments).map((x, i) => ({ id: i, start: x.start, end: x.end, text: fix(x.text), speaker: "S1" }));
      await patch(job.id, { status: "done", draft: false, progress: 1, segments, model: m.model, device: m.device, language: m.output || "en", spoken: m.spoken || [], error: "" });
      toast(`“${job.title}” transcribed`);
    } else {
      await patch(job.id, { status: "error", error: m.message });
      toast("Transcription failed: " + m.message, 6000);
    }
    emit({ type: "changed", id: job.id });
    hideJob();
    next();
  }
};

function mergeSegments(chunks) {
  const out = [];
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && c.start - last.end < 0.8 && (last.text.length + c.text.length) < 420 && !/[.?!]$/.test(last.text)) {
      last.text = (last.text + " " + c.text).trim(); last.end = c.end;
    } else out.push({ ...c });
  }
  return out;
}

function enqueue(id) { if (!queue.includes(id) && (!active || active.id !== id)) queue.push(id); next(); }
let recordingNow = false;   // full transcriptions wait while a live recording is running
async function next() {
  if (active || !queue.length || recordingNow) return;
  const id = queue.shift();
  const rec = await DB.get(id);
  if (!rec) return next();
  const s = getSettings();
  active = { id, title: rec.title, progress: 0, language: rec.language_req || s.language, mode: rec.mode_req || s.mode };
  await patch(id, { status: "processing", progress: 0, error: "" });
  emit({ type: "changed", id });
  showJob("Reading audio", rec.title, 0);
  try {
    const blob = await DB.getAudio(id);
    const audio = await decodeTo16k(blob);
    await patch(id, { duration: audio.length / 16000 });
    await checkDevice();
    const key = rec.model_req || s.model || "";
    worker.postMessage({ type: "transcribe", id, audio, key, device: DEVICE.webgpu ? "webgpu" : "wasm", f16: DEVICE.f16,
      language: active.language, mode: active.mode }, [audio.buffer]);
  } catch (e) {
    const job = active; active = null;
    await patch(id, { status: "error", error: "This file could not be read by the browser: " + e.message });
    emit({ type: "changed", id: job.id });
    hideJob(); next();
  }
}
function showJob(label, text, p) {
  $("#jobbar").hidden = false; $("#jobLabel").textContent = label; $("#jobText").textContent = text || "";
  $("#jobFill").style.width = Math.round((p || 0) * 100) + "%";
}
function hideJob() { $("#jobbar").hidden = true; }

async function addRecording(blob, name, meta = {}) {
  const id = uid();
  const s = getSettings();
  const rec = {
    id, title: meta.title || name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " "), project: meta.project || "",
    source: meta.source || "upload", original_name: name, created: Date.now(), duration: meta.duration || 0,
    status: "queued", progress: 0, segments: [], speakers: { S1: "Speaker 1" }, notes: "",
    language_req: meta.language || s.language, mode_req: meta.mode || s.mode, model_req: "", mime: blob.type,
  };
  await DB.putAudio(id, blob);
  await DB.put(rec);
  enqueue(id);
  return id;
}

window.addEventListener("beforeunload", (e) => { if (active || queue.length) { e.preventDefault(); e.returnValue = ""; } });

/* ---------------------------------------------------------------- router */
function route() {
  teardown();
  const h = location.hash.replace(/^#/, "") || "/";
  $$(".nav a").forEach((a) => a.classList.remove("on"));
  window.scrollTo(0, 0);
  if (h.startsWith("/r/")) return renderTranscript(h.slice(3));
  if (h === "/record") { $('[data-nav="record"]').classList.add("on"); return renderRecord(); }
  if (h === "/settings") { $('[data-nav="settings"]').classList.add("on"); return renderSettings(); }
  $('[data-nav="library"]').classList.add("on");
  return renderLibrary();
}
window.addEventListener("hashchange", route);

/* ---------------------------------------------------------------- library */
async function renderLibrary() {
  const s = getSettings();
  view.innerHTML = `
    <div class="lib-head">
      <div><span class="eyebrow">01 · Library</span><h1>Transcripts</h1>
      <div class="muted">Meetings, site visits and client calls, transcribed inside this browser.</div></div>
      <div class="row"><a class="btn primary" href="#/record">Record</a></div>
    </div>
    <div class="drop" id="drop" tabindex="0" role="button" aria-label="Upload recordings">
      <span class="label">Upload recordings</span>
      <p>Drop audio or video files here, or click to choose. MP3, M4A, WAV, MP4, WEBM, OGG and more.</p>
    </div>
    <div class="upload-opts">
      <label class="field"><span>Project</span><input type="text" id="upProject" list="projList" placeholder="e.g. CKPC"></label>
      <label class="field"><span>Spoken language</span><select id="upLang">${langOptions(s.language)}</select></label>
      <label class="field"><span>Text in</span><select id="upMode">${outputOptions(s.mode)}</select></label>
      <label class="field"><span>Title</span><input type="text" id="upTitle" placeholder="From file name"></label>
    </div>
    <datalist id="projList"></datalist>
    <div class="filters">
      <label class="field search"><span>Search all transcripts</span><input type="search" id="q" placeholder="Word, phrase, title or project"></label>
      <label class="field"><span>Project</span><select id="fProject"><option value="">All projects</option></select></label>
    </div>
    <div class="list" id="list"><div class="empty">Loading…</div></div>
    <p class="privacy">Recordings and transcripts are stored in this browser on this device only. Export anything you need to share or keep long term.</p>`;

  const drop = $("#drop"), pick = $("#filePick");
  drop.onclick = () => pick.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick.click(); } };
  pick.onchange = () => { add([...pick.files]); pick.value = ""; };
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => add([...e.dataTransfer.files]));

  async function add(files) {
    files = files.filter((f) => f.size);
    for (const f of files) {
      await addRecording(f, f.name, { title: files.length === 1 ? $("#upTitle").value.trim() : "", project: $("#upProject").value.trim(), language: $("#upLang").value, mode: $("#upMode").value });
    }
    if (files.length) { toast(files.length === 1 ? "Added. Transcription has started." : `${files.length} files added to the queue.`); $("#upTitle").value = ""; }
    load();
  }

  let q = "", proj = "";
  async function load() {
    const all = (await DB.all()).sort((a, b) => b.created - a.created);
    const projects = [...new Set(all.map((r) => r.project).filter(Boolean))].sort();
    const fp = $("#fProject");
    if (!fp) return;
    fp.innerHTML = `<option value="">All projects</option>` + projects.map((p) => `<option ${p === proj ? "selected" : ""}>${esc(p)}</option>`).join("");
    $("#projList").innerHTML = projects.map((p) => `<option value="${esc(p)}">`).join("");
    const ql = q.toLowerCase();
    const items = all.filter((r) => (!proj || r.project === proj) && (!ql || r.title.toLowerCase().includes(ql) || (r.project || "").toLowerCase().includes(ql) || r.segments.some((s) => s.text.toLowerCase().includes(ql))));
    drawList(items, q);
  }
  let deb;
  $("#q").oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => { q = e.target.value.trim(); load(); }, 200); };
  $("#fProject").onchange = (e) => { proj = e.target.value; load(); };
  const onEv = (e) => { if (e.type === "changed") load(); };
  listeners.add(onEv); cleanup.push(() => listeners.delete(onEv));
  every(() => { if (active) load(); }, 3000);
  load();
}

function statusHtml(r) {
  if (r.status === "done") return `<span class="label muted">${fmtTime(r.duration)}</span>`;
  if (r.status === "error") return `<span class="label" style="color:var(--accent)">Not finished</span>`;
  const pct = Math.round((r.progress || 0) * 100);
  return `<span class="small muted">${r.status === "processing" ? "Transcribing " + pct + "%" : "Waiting"}</span><div class="bar-mini"><i style="width:${pct}%"></i></div>`;
}
function drawList(items, q) {
  const list = $("#list");
  if (!list) return;
  if (!items.length) { list.innerHTML = `<div class="empty">${q ? "Nothing matches that search." : "No transcripts yet. Upload a recording or record one."}</div>`; return; }
  const ql = q.toLowerCase();
  list.innerHTML = items.map((r, i) => {
    let snip = "";
    if (ql) {
      const seg = r.segments.find((s) => s.text.toLowerCase().includes(ql));
      if (seg) {
        const t = seg.text, k = t.toLowerCase().indexOf(ql);
        snip = (k > 60 ? "…" : "") + esc(t.slice(Math.max(0, k - 60), k)) + "<mark>" + esc(t.slice(k, k + q.length)) + "</mark>" + esc(t.slice(k + q.length, k + q.length + 90)) + "…";
      }
    }
    return `<a class="item" href="#/r/${r.id}">
      <span class="num">${reg(i + 1)}</span>
      <span><div class="t">${esc(r.title)}</div>
        <div class="m">${esc(r.project || "Unassigned")} · ${fmtDate(r.created)} · ${r.source === "record" ? "Recorded" : "Upload"}${r.status === "done" ? " · " + esc(spokenLabel(r)) : ""}</div>
        ${snip ? `<div class="snip">${snip}</div>` : ""}</span>
      <span class="status">${statusHtml(r)}</span></a>`;
  }).join("");
}

/* ---------------------------------------------------------------- transcript */
async function renderTranscript(id) {
  let rec = await DB.get(id);
  if (!rec) { view.innerHTML = `<div class="empty">Transcript not found on this device. <a class="btn ghost" href="#/">Back to library</a></div>`; return; }
  const blob = await DB.getAudio(id);
  const url = blob ? URL.createObjectURL(blob) : "";
  const audio = new Audio(url);
  audio.preload = "metadata";
  cleanup.push(() => { audio.pause(); if (url) URL.revokeObjectURL(url); });
  let segEls = [], editing = false;

  view.innerHTML = `
    <div class="doc">
      <div>
        <span class="eyebrow">Transcript</span>
        <input class="doc-title" id="title" value="${esc(rec.title)}" aria-label="Title">
        <div class="meta" id="meta"></div>
        <div id="notice"></div>
        <div class="find"><label class="field" style="flex:1"><span>Find in transcript</span><input type="search" id="find" placeholder="Search this transcript"></label><span class="small muted" id="findCount"></span></div>
        <div id="segs"></div>
      </div>
      <aside class="side">
        <section><h2>Speakers</h2><div id="spks"></div>
          <p class="small muted" style="margin:8px 0 0">Click a speaker name in the transcript to assign that line. Rename here; every line updates.</p></section>
        <section><h2>Export</h2>
          <div class="exports">${["docx", "txt", "md", "srt", "vtt", "json"].map((f) => `<button class="btn" data-fmt="${f}">${f}</button>`).join("")}</div>
          <div class="checks"><label><input type="checkbox" id="xTs" checked> Timestamps in TXT</label><label><input type="checkbox" id="xSpk" checked> Speakers in TXT</label></div>
          <button class="btn ghost" id="copy" style="margin-top:8px">Copy full text</button></section>
        <section><h2>Details</h2>
          <label class="field" style="margin-bottom:16px"><span>Project</span><input type="text" id="project" value="${esc(rec.project)}"></label>
          <label class="field" style="margin-bottom:16px"><span>Notes</span><textarea id="notes" rows="4" placeholder="Agenda, attendees, decisions">${esc(rec.notes)}</textarea></label>
          <dl class="kv" id="kv"></dl></section>
        <section><h2>Re-transcribe</h2>
          <p class="small muted" style="margin-top:-6px">Run again with another model or language, or after adding glossary terms. Edits to the text are replaced.</p>
          <label class="field" style="margin-bottom:16px"><span>Model</span><select id="rModel">${Object.entries(MODEL_INFO).map(([k, v]) => `<option value="${k}" ${k === (rec.model_req || chosenModel()) ? "selected" : ""}>${v.name}</option>`).join("")}</select></label>
          <label class="field" style="margin-bottom:16px"><span>Spoken language</span><select id="rLang">${langOptions(rec.language_req || "auto")}</select></label>
          <label class="field" style="margin-bottom:16px"><span>Text in</span><select id="rMode">${outputOptions(rec.mode_req || "english")}</select></label>
          <div class="row"><button class="btn" id="rGo">Re-transcribe</button><button class="btn ghost danger" id="del">Delete</button></div></section>
      </aside>
    </div>
    <div class="player">
      <button class="btn play" id="play" aria-label="Play">▶</button>
      <button class="btn ghost skip" id="back" title="Back 10 s (←)">−10</button>
      <button class="btn ghost skip" id="fwd" title="Forward 10 s (→)">+10</button>
      <div class="scrub" id="scrub"><i id="scrubFill"></i><b id="scrubHead"></b></div>
      <span class="time" id="clock">00:00 / 00:00</span>
      <select class="speed" id="speed" aria-label="Playback speed">${[0.75, 1, 1.25, 1.5, 1.75, 2].map((s) => `<option value="${s}" ${s === 1 ? "selected" : ""}>${s}×</option>`).join("")}</select>
    </div>`;
  document.body.classList.add("has-player");
  cleanup.push(() => document.body.classList.remove("has-player"));

  const save = async (changes, msg) => { rec = await patch(id, changes); if (msg) toast(msg); };
  const speakerName = (c) => (rec.speakers || {})[c] || "Speaker " + String(c).replace("S", "");

  function drawMeta() {
    $("#meta").textContent = `${rec.project || "Unassigned"} · ${fmtDate(rec.created)} · ${fmtTime(rec.duration)} · ${rec.source === "record" ? "Recorded here" : rec.original_name}`;
    $("#kv").innerHTML = `<dt>Spoken</dt><dd>${esc((rec.spoken || []).map(langName).join(", ") || "—")}</dd><dt>Text in</dt><dd>${esc(langName(rec.language))}</dd><dt>Model</dt><dd>${esc((rec.model || "—").split("/").pop())}</dd>
      <dt>Processed with</dt><dd>${rec.device === "webgpu" ? "Graphics (fast)" : rec.device ? "Processor" : "—"}</dd>
      <dt>Words</dt><dd>${rec.segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0).toLocaleString("en-IN")}</dd>`;
    const n = $("#notice");
    if (rec.status === "queued" || rec.status === "processing") {
      n.innerHTML = `<div class="notice"><span class="label">${rec.draft ? "Refining with the accurate model" : "Transcribing"}</span><div class="small muted">${rec.draft ? "The live draft is shown below and will be replaced by the accurate transcript. " : ""}Keep this page open. ${rec.status === "processing" ? Math.round((rec.progress || 0) * 100) + "% done." : "Waiting for the previous file to finish."}</div><div class="bar-mini"><i style="width:${Math.round((rec.progress || 0) * 100)}%"></i></div></div><div class="livebox" id="live">Text will appear here as it is recognised…</div>`;
    } else if (rec.status === "error") {
      n.innerHTML = `<div class="notice"><span class="label">Not finished</span><div class="small muted">${esc(rec.error || "The page was closed before transcription finished.")}</div><button class="btn" id="retry" style="margin-top:12px">Transcribe now</button></div>`;
      $("#retry").onclick = () => { enqueue(id); patch(id, { status: "queued", error: "" }).then((r) => { rec = r; drawMeta(); }); };
    } else n.innerHTML = "";
  }
  function drawSpeakers() {
    const totals = {}; let all = 0;
    rec.segments.forEach((s) => { const d = s.end - s.start || 0; totals[s.speaker] = (totals[s.speaker] || 0) + d; all += d; });
    const codes = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
    $("#spks").innerHTML = codes.length ? codes.map((c) => `<div class="spk"><input type="text" data-code="${esc(c)}" value="${esc(speakerName(c))}"><span class="pct">${all ? Math.round(totals[c] / all * 100) : 0}%</span></div>`).join("") : `<p class="small muted">None yet.</p>`;
    $$("#spks input").forEach((inp) => inp.onchange = async () => { await save({ speakers: { ...rec.speakers, [inp.dataset.code]: inp.value.trim() || inp.dataset.code } }, "Speaker renamed"); drawSegments(); });
  }
  function drawSegments() {
    const box = $("#segs");
    if (!rec.segments.length) { box.innerHTML = rec.status === "done" ? `<div class="empty">No speech was detected in this recording.</div>` : ""; segEls = []; return; }
    box.innerHTML = rec.segments.map((s, i) => `<div class="seg" data-i="${i}" data-s="${s.start}" data-e="${s.end}">
      <div class="who" data-i="${i}" title="Click to change speaker"><span class="label">${esc(speakerName(s.speaker))}</span><span class="time">${fmtTime(s.start)}</span></div>
      <div class="txt" data-i="${i}" title="Double-click to edit">${esc(s.text)}</div></div>`).join("");
    segEls = $$(".seg", box);
    applyFind();
  }
  $("#segs").addEventListener("click", (e) => {
    if (editing) return;
    const who = e.target.closest(".who");
    if (who) return reassign(+who.dataset.i);
    const seg = e.target.closest(".seg");
    if (seg && !window.getSelection().toString()) { audio.currentTime = +seg.dataset.s; audio.play(); }
  });
  $("#segs").addEventListener("dblclick", (e) => {
    const t = e.target.closest(".txt");
    if (!t || editing) return;
    editing = true; audio.pause();
    const i = +t.dataset.i;
    t.contentEditable = "true"; t.focus();
    const finish = async (commit) => {
      t.contentEditable = "false"; editing = false;
      const val = t.textContent.replace(/\s+/g, " ").trim();
      if (commit && val !== rec.segments[i].text) await save({ segments: rec.segments.map((s, k) => (k === i ? { ...s, text: val } : s)) }, "Line updated");
      drawSegments();
    };
    t.onkeydown = (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); t.blur(); } if (ev.key === "Escape") { t.onblur = null; finish(false); } };
    t.onblur = () => finish(true);
  });
  async function reassign(i) {
    const codes = [...new Set([...Object.keys(rec.speakers || {}), ...rec.segments.map((s) => s.speaker)])].sort();
    const ans = prompt(`Assign this line to which speaker?\n\n${codes.map((c, k) => `${k + 1}. ${speakerName(c)}`).join("\n")}\n\nEnter a number, or type a new name.`, "");
    if (!ans) return;
    let code; const n = parseInt(ans, 10);
    if (String(n) === ans.trim() && codes[n - 1]) code = codes[n - 1];
    else {
      code = Object.keys(rec.speakers || {}).find((c) => rec.speakers[c].toLowerCase() === ans.trim().toLowerCase());
      if (!code) { let k = 1; while (codes.includes("S" + k)) k++; code = "S" + k; rec.speakers = { ...rec.speakers, [code]: ans.trim() }; }
    }
    const fromHere = confirm("Also assign the following lines until the speaker changes?");
    const orig = rec.segments[i].speaker;
    const segments = rec.segments.map((s, k) => {
      if (k === i) return { ...s, speaker: code };
      if (fromHere && k > i && rec.segments.slice(i + 1, k + 1).every((x) => x.speaker === orig)) return { ...s, speaker: code };
      return s;
    });
    await save({ segments, speakers: rec.speakers }, "Speaker changed");
    drawSegments(); drawSpeakers();
  }
  function applyFind() {
    const q = ($("#find").value || "").trim().toLowerCase();
    $$(".seg-hit").forEach((el) => el.classList.remove("seg-hit"));
    if (!q) { $("#findCount").textContent = ""; return; }
    let n = 0, first = null;
    segEls.forEach((seg, i) => { if (rec.segments[i].text.toLowerCase().includes(q)) { $(".txt", seg).classList.add("seg-hit"); n++; first = first || seg; } });
    $("#findCount").textContent = n ? `${n} lines` : "No match";
    if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  let fdeb; $("#find").oninput = () => { clearTimeout(fdeb); fdeb = setTimeout(applyFind, 200); };

  /* player */
  const playBtn = $("#play");
  playBtn.onclick = () => (audio.paused ? audio.play() : audio.pause());
  audio.onplay = () => { playBtn.textContent = "❚❚"; tick(); };
  audio.onpause = () => { playBtn.textContent = "▶"; };
  $("#back").onclick = () => (audio.currentTime = Math.max(0, audio.currentTime - 10));
  $("#fwd").onclick = () => (audio.currentTime += 10);
  $("#speed").onchange = (e) => (audio.playbackRate = +e.target.value);
  const scrub = $("#scrub");
  const seekTo = (e) => { const r = scrub.getBoundingClientRect(); const d = (isFinite(audio.duration) && audio.duration) || rec.duration; audio.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * d; };
  scrub.onpointerdown = (e) => { seekTo(e); scrub.setPointerCapture(e.pointerId); scrub.onpointermove = seekTo; };
  scrub.onpointerup = () => (scrub.onpointermove = null);
  audio.ontimeupdate = paint; audio.onloadedmetadata = paint;
  let raf = 0, lastSeg = null;
  function tick() { paint(); if (!audio.paused) raf = requestAnimationFrame(tick); }
  cleanup.push(() => cancelAnimationFrame(raf));
  function paint() {
    const t = audio.currentTime, d = (isFinite(audio.duration) && audio.duration) || rec.duration || 0;
    const pct = d ? t / d * 100 : 0;
    $("#scrubFill").style.width = pct + "%"; $("#scrubHead").style.left = pct + "%";
    $("#clock").textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
    const seg = segEls.find((el) => +el.dataset.s <= t && t < +el.dataset.e + 0.3) || null;
    if (seg !== lastSeg) {
      lastSeg && lastSeg.classList.remove("active");
      if (seg) { seg.classList.add("active"); const r = seg.getBoundingClientRect(); if (!audio.paused && !editing && (r.top < 140 || r.bottom > innerHeight - 100)) seg.scrollIntoView({ block: "center", behavior: "smooth" }); }
      lastSeg = seg;
    }
  }
  const onKey = (e) => {
    if (editing || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); playBtn.click(); }
    if (e.key === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 5);
    if (e.key === "ArrowRight") audio.currentTime += 5;
  };
  document.addEventListener("keydown", onKey); cleanup.push(() => document.removeEventListener("keydown", onKey));

  /* side actions */
  $("#title").onchange = (e) => save({ title: e.target.value.trim() || rec.title }, "Title saved");
  $("#title").onkeydown = (e) => { if (e.key === "Enter") e.target.blur(); };
  $("#project").onchange = (e) => save({ project: e.target.value.trim() }, "Project saved").then(drawMeta);
  $("#notes").onchange = (e) => save({ notes: e.target.value }, "Notes saved");
  $$(".exports [data-fmt]").forEach((b) => b.onclick = () => exportRec(rec, b.dataset.fmt, { ts: $("#xTs").checked, spk: $("#xSpk").checked }));
  $("#copy").onclick = async () => {
    try { await navigator.clipboard.writeText(`${rec.title}\n\n` + rec.segments.map((s) => `${speakerName(s.speaker)} [${fmtTime(s.start)}]\n${s.text}`).join("\n\n")); toast("Transcript copied"); }
    catch (_) { toast("Clipboard not available here", 4000); }
  };
  $("#rGo").onclick = async () => {
    if (!confirm("Re-transcribe this recording? Edits to the text will be replaced.")) return;
    rec = await patch(id, { status: "queued", progress: 0, model_req: $("#rModel").value, language_req: $("#rLang").value, mode_req: $("#rMode").value, error: "" });
    enqueue(id); drawMeta(); toast("Queued for re-transcription");
  };
  $("#del").onclick = async () => {
    if (!confirm(`Delete "${rec.title}" and its audio from this device?`)) return;
    const qi = queue.indexOf(id); if (qi >= 0) queue.splice(qi, 1);
    await DB.del(id); toast("Deleted"); location.hash = "#/";
  };

  const onEv = async (e) => {
    if (e.id !== id) return;
    if (e.type === "live") { const l = $("#live"); if (l) l.textContent = e.text; return; }
    rec = await DB.get(id); drawMeta(); drawSpeakers(); drawSegments();
  };
  listeners.add(onEv); cleanup.push(() => listeners.delete(onEv));
  every(async () => { if (rec.status === "processing") { rec = await DB.get(id); const live = $("#live")?.textContent; drawMeta(); if (live && $("#live")) $("#live").textContent = live; } }, 2500);
  drawMeta(); drawSpeakers(); drawSegments();
}

/* ---------------------------------------------------------------- record (live transcript) */
const LIVE_WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.t = 0; this.sum = 0; this.n = 0; this.out = []; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.n++; this.t += 1;
      if (this.t >= this.ratio) { this.out.push(this.sum / this.n); this.sum = 0; this.n = 0; this.t -= this.ratio; }
    }
    if (this.out.length >= 1600) { const f = new Float32Array(this.out); this.out = []; this.port.postMessage(f, [f.buffer]); }
    return true;
  }
}
registerProcessor("aa-tap", Tap);`;

async function renderRecord() {
  const s = getSettings();
  const all = await DB.all();
  const projects = [...new Set(all.map((r) => r.project).filter(Boolean))].sort();
  await checkDevice();
  const device = DEVICE.webgpu ? "webgpu" : "wasm";
  view.innerHTML = `
    <div class="live">
      <span class="eyebrow">02 · Record</span><h1>Live transcript</h1>
      <div class="muted">Words appear as people speak, in English whatever language is spoken. When you stop, the full recording is transcribed again with complete context.</div>
      <div class="rec-panel">
        <button class="rec-btn" id="rec" aria-label="Start recording"><i></i></button>
        <div><div class="clock" id="clock">00:00:00</div>
          <div class="small muted" id="recState">Preparing the live preview…</div>
          <div class="level"><i id="level"></i></div></div>
      </div>
      <div class="row" style="margin-bottom:40px">
        <label class="field grow"><span>Title</span><input type="text" id="lTitle" placeholder="e.g. Site meeting — CKPC 3rd floor"></label>
        <label class="field" style="min-width:180px"><span>Project</span><input type="text" id="lProject" list="lp"><datalist id="lp">${projects.map((p) => `<option value="${esc(p)}">`).join("")}</datalist></label>
        <label class="field" style="min-width:200px"><span>Spoken language</span><select id="lLang">${langOptions(s.language)}</select></label>
        <label class="field" style="min-width:220px"><span>Text in</span><select id="lMode">${outputOptions(s.mode)}</select></label>
      </div>
      <div class="live-head"><h2>Transcript</h2><label class="checks" style="margin:0"><label><input type="checkbox" id="follow" checked> Follow</label></label></div>
      <div class="live-text" id="out"><p class="muted">Press the bronze button and start speaking. Text appears here within a few seconds.</p></div>
    </div>`;

  const fix = makeCorrector(s.vocabulary, s.replacements);
  let mediaRec = null, stream = null, chunks = [], started = 0, ctx = null, node = null, raf = 0, wake = null;
  let pcm = new Float32Array(0), offset = 0, total = 0, busy = false, seq = 0, recording = false, liveReady = false;
  const committed = [];
  let partial = "", lastLineAt = -10, finalSeq = -1, finalDone = null;
  const out = $("#out"), btn = $("#rec");

  const onLive = (m) => {
    if (m.type === "live-loading") { $("#recState").textContent = `Downloading the speech model, one time only · ${Math.round(m.progress || 0)}%${m.total ? " of " + fmtBytes(m.total) : ""}`; }
    else if (m.type === "live-ready") { liveReady = true; if (!recording) $("#recState").textContent = "Ready. The browser will ask for microphone access."; }
    else if (m.type === "live-error") { busy = false; if (m.seq === finalSeq && finalDone) finalDone(); if (!recording) $("#recState").textContent = "Live preview unavailable on this device. Recording still works and is transcribed when you stop."; }
    else if (m.type === "live-result") {
      if (m.lang && recording) $("#recState").textContent = `Recording · hearing ${langName(m.lang)}${$("#lMode").value === "english" && m.lang !== "en" ? " → writing in English" : ""}`;
      handleResult(m);
    }
  };
  liveHandlers.add(onLive);
  cleanup.push(() => liveHandlers.delete(onLive));
  const preload = () => { liveReady = false; worker.postMessage({ type: "live-preload", device, f16: DEVICE.f16, mode: $("#lMode").value }); };
  preload();
  $("#lMode").onchange = () => { if (!recording) { $("#recState").textContent = "Preparing the speech model…"; preload(); } };

  function draw() {
    if (!committed.length && !partial) return;
    const html = committed.map((c) => {
      return `<p class="line">${c.showTime ? `<span class="ts">${fmtTime(c.start)}</span>` : `<span class="ts"></span>`}<span>${esc(c.text)}</span></p>`;
    }).join("") + (partial ? `<p class="line partial"><span class="ts"></span><span>${esc(partial)}<span class="caret"></span></span></p>` : "");
    out.innerHTML = html;
    if ($("#follow").checked) out.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function handleResult(m) {
    busy = false;
    if (m.seq !== seq) return;
    const isFinal = m.seq === finalSeq;
    const dur = pcm.length / 16000;
    const segs = m.segments || [];
    if (!segs.length) {
      if (isFinal && finalDone) finalDone();
      if (dur > 8) { const keep = 16000; offset += (pcm.length - keep) / 16000; pcm = pcm.slice(pcm.length - keep); }
      partial = ""; draw(); return;
    }
    let n = 0;
    for (let i = 0; i < segs.length - 1; i++) if (segs[i].end < dur - 3 && /[.?!]$/.test(segs[i].text)) n = i + 1;
    if (!n) for (let i = 0; i < segs.length - 1; i++) if (segs[i].end < dur - 6) n = i + 1;
    if (dur > 24) n = Math.max(n, segs.length - 1);
    if (isFinal) n = segs.length;
    for (const sg of segs.slice(0, n)) {
      const start = offset + sg.start;
      committed.push({ start, end: offset + sg.end, text: fix(sg.text), showTime: start - lastLineAt >= 30 || !committed.length });
      if (start - lastLineAt >= 30 || committed.length === 1) lastLineAt = start;
    }
    if (n) {
      const cut = Math.min(pcm.length, Math.floor(segs[n - 1].end * 16000));
      pcm = pcm.slice(cut); offset += cut / 16000;
    }
    partial = fix(segs.slice(n).map((x) => x.text).join(" "));
    draw();
    if (isFinal && finalDone) finalDone();
  }

  function pump(final = false) {
    if ((busy && !final) || !liveReady) return;
    if (!final && pcm.length < 16000) return;
    busy = true; seq++;
    const window = pcm.length > 28 * 16000 ? pcm.slice(pcm.length - 28 * 16000) : pcm.slice();
    if (pcm.length > 28 * 16000) { offset += (pcm.length - window.length) / 16000; pcm = window.slice(); }
    worker.postMessage({ type: "live", seq, audio: window, device, f16: DEVICE.f16, language: $("#lLang").value, mode: $("#lMode").value }, [window.buffer]);
    if (final) finalSeq = seq;
  }

  async function start() {
    if (!window.isSecureContext) return toast("Recording needs the https address of this page.", 6000);
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (_) { return toast("Microphone permission was refused.", 5000); }
    const types = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
    const mimeType = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
    mediaRec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined);
    chunks = [];
    mediaRec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRec.onstop = finish;
    mediaRec.start(1000);

    ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([LIVE_WORKLET], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    const src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "aa-tap");
    src.connect(node);
    node.port.onmessage = (e) => {
      const f = e.data;
      const merged = new Float32Array(pcm.length + f.length); merged.set(pcm); merged.set(f, pcm.length); pcm = merged;
      total += f.length;
      let peak = 0; for (let i = 0; i < f.length; i += 4) { const a = Math.abs(f[i]); if (a > peak) peak = a; }
      const lv = $("#level"); if (lv) lv.style.width = Math.min(100, Math.sqrt(peak) * 120) + "%";
    };

    recording = true; recordingNow = true; started = Date.now();
    out.innerHTML = `<p class="muted">Listening…</p>`;
    btn.classList.add("on"); btn.setAttribute("aria-label", "Stop recording");
    $("#recState").textContent = liveReady ? "Recording · live transcript on" : "Recording · live preview is still loading";
    every(() => { $("#clock").textContent = fmtTime((Date.now() - started) / 1000, true); }, 500);
    every(() => { if (recording) pump(); }, 700);
    try { wake = await navigator.wakeLock?.request("screen"); } catch (_) {}
  }

  function stopAll() {
    recording = false; recordingNow = false;
    try { node && node.disconnect(); } catch (_) {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { if (ctx && ctx.state !== "closed") ctx.close().catch(() => {}); } catch (_) {}
    try { wake && wake.release(); } catch (_) {}
    btn.classList.remove("on");
    const lv = $("#level"); if (lv) lv.style.width = "0";
  }

  function stop() {
    $("#recState").textContent = "Finishing the last words…";
    stopAll();
    if (mediaRec && mediaRec.state !== "inactive") mediaRec.stop();
  }

  async function finish() {
    const dur = (Date.now() - started) / 1000;
    if (dur < 1 || !chunks.length) { toast("Nothing was recorded."); return; }
    // final pass on the remaining audio so the draft is complete
    if (liveReady && pcm.length > 8000) {
      await new Promise((res) => {
        finalDone = res;
        const t0 = Date.now();
        const wait = () => { if (!busy) pump(true); else if (Date.now() - t0 < 12000) setTimeout(wait, 150); else res(); };
        wait(); setTimeout(res, 15000);
      });
      finalDone = null;
    }
    const blob = new Blob(chunks, { type: mediaRec.mimeType || "audio/webm" });
    const ext = (mediaRec.mimeType || "").includes("mp4") ? "m4a" : (mediaRec.mimeType || "").includes("ogg") ? "ogg" : "webm";
    const title = $("#lTitle").value.trim() || "Recording " + fmtDate(Date.now());
    const id = await addRecording(blob, `${title}.${ext}`, { title, project: $("#lProject").value.trim(), language: $("#lLang").value, mode: $("#lMode").value, source: "record", duration: dur });
    const draftLines = committed.concat(partial ? [{ start: offset, end: dur, text: partial }] : []);
    if (draftLines.length) {
      const r = await DB.get(id);
      if (r && r.status !== "done") { r.segments = draftLines.map((c, i) => ({ id: i, start: c.start, end: c.end, text: c.text, speaker: "S1" })); r.draft = true; await DB.put(r); }
    }
    toast("Saved. Refining with the accurate model…", 4000);
    location.hash = `#/r/${id}`;
  }

  btn.onclick = () => (recording ? stop() : start());
  const guard = (e) => { if (recording) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", guard);
  cleanup.push(() => { window.removeEventListener("beforeunload", guard); if (recording) stop(); else stopAll(); });
}

/* ---------------------------------------------------------------- settings */
async function renderSettings() {
  await checkDevice();
  const s = getSettings();
  const cur = s.model || "";
  let usage = "";
  try { const e = await navigator.storage.estimate(); usage = `${fmtBytes(e.usage || 0)} used on this device`; } catch (_) {}
  view.innerHTML = `
    <span class="eyebrow">03 · Settings</span><h1>Settings</h1>
    <div class="muted" style="margin-bottom:48px">These settings apply to this browser on this device.</div>
    <div class="settings">
      <section>
        <h2>Speech model</h2>
        <p class="help">English output uses Whisper large-v3, the model trained to translate (about 1.9 GB, downloaded once). The choice below applies to "Spoken language as is".</p>
        <p class="help">This device: ${DEVICE.webgpu ? (DEVICE.f16 ? "graphics acceleration available, best accuracy supported" : "graphics acceleration available, limited precision") : "no graphics acceleration, standard mode (slower)"}.</p>
        <label class="opt"><input type="radio" name="model" value="" ${cur === "" ? "checked" : ""}><b>Automatic</b><span class="small muted">Uses ${MODEL_INFO[autoModel()].name} on this device.</span></label>
        ${Object.entries(MODEL_INFO).map(([k, v]) => `<label class="opt"><input type="radio" name="model" value="${k}" ${cur === k ? "checked" : ""}><b>${v.name}</b><span class="small muted">${v.detail}</span></label>`).join("")}
        <div class="row" style="margin:32px 0 24px">
          <label class="field grow"><span>Text in</span><select id="dMode">${outputOptions(s.mode)}</select></label>
          <label class="field grow"><span>Spoken language</span><select id="dLang">${langOptions(s.language)}</select></label>
        </div>
        <h2 style="margin-top:48px">Studio glossary</h2>
        <p class="help">One term per line. Correct capitalisation is restored after every transcription.</p>
        <textarea id="vocab" rows="12">${esc(s.vocabulary.join("\n"))}</textarea>
      </section>
      <section>
        <h2>Corrections</h2>
        <p class="help">Fix words the engine consistently mishears. Matching ignores case and whole words only.</p>
        <table class="rules"><thead><tr><th>Heard</th><th>Write as</th><th></th></tr></thead><tbody id="rules"></tbody></table>
        <button class="btn ghost" id="addRule" style="margin-top:12px">+ Add correction</button>
        <h2 style="margin-top:56px">This device</h2>
        <dl class="kv"><dt>Storage</dt><dd>${esc(usage || "—")}</dd><dt>Recordings</dt><dd>${(await DB.all()).length}</dd></dl>
        <div class="row" style="margin-top:16px"><button class="btn" id="backup">Export all transcripts</button></div>
        <div class="row" style="margin-top:40px"><button class="btn primary" id="saveS">Save settings</button></div>
      </section>
    </div>
    <p class="privacy">Speech recognition runs inside this browser using the open-source Whisper model. Recordings and transcripts never leave this device; the only download is the speech model itself, once.</p>`;
  let rules = s.replacements.map((r) => ({ ...r }));
  const drawRules = () => {
    $("#rules").innerHTML = rules.map((r, i) => `<tr><td><input type="text" data-i="${i}" data-k="find" value="${esc(r.find)}" placeholder="v r f"></td><td><input type="text" data-i="${i}" data-k="replace" value="${esc(r.replace)}" placeholder="VRF"></td><td><button class="x" data-del="${i}" aria-label="Remove">×</button></td></tr>`).join("");
    $$("#rules input").forEach((inp) => inp.oninput = () => (rules[+inp.dataset.i][inp.dataset.k] = inp.value));
    $$("#rules [data-del]").forEach((b) => b.onclick = () => { rules.splice(+b.dataset.del, 1); drawRules(); });
  };
  drawRules();
  $("#addRule").onclick = () => { rules.push({ find: "", replace: "" }); drawRules(); };
  $("#saveS").onclick = () => {
    saveSettings({ ...s, model: ($$('input[name="model"]').find((r) => r.checked) || {}).value || "", language: $("#dLang").value, mode: $("#dMode").value,
      vocabulary: $("#vocab").value.split("\n").map((x) => x.trim()).filter(Boolean), replacements: rules.filter((r) => r.find.trim()) });
    toast("Settings saved"); updateChip();
  };
  $("#backup").onclick = async () => {
    const recs = (await DB.all()).filter((r) => r.status === "done");
    if (!recs.length) return toast("No finished transcripts yet.");
    const zip = new JSZip();
    recs.forEach((r) => zip.file(`${safeName(r.title)}-${r.id.slice(0, 4)}.txt`, toTxt(r, true, true)));
    download(await zip.generateAsync({ type: "blob" }), `AA-Transcripts-${new Date().toISOString().slice(0, 10)}.zip`);
  };
}

/* ---------------------------------------------------------------- exports */
const safeName = (t) => (t || "transcript").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 80) || "transcript";
const nameOf = (r, s) => (r.speakers || {})[s.speaker] || "Speaker " + String(s.speaker).replace("S", "");
function ts(sec, sep = ".") {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60), ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms).padStart(3, "0")}`;
}
function toTxt(r, withTs, withSpk) {
  const head = `${r.title.toUpperCase()}\n${r.project || "Atelier Astil"} · ${fmtDate(r.created)} · ${fmtTime(r.duration)}\n\n`;
  return head + r.segments.map((s) => {
    const h = [withTs ? `[${fmtTime(s.start)}]` : "", withSpk ? nameOf(r, s).toUpperCase() : ""].filter(Boolean).join(" ");
    return (h ? h + "\n" : "") + s.text;
  }).join("\n\n") + "\n";
}
function download(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
async function exportRec(r, fmt, o) {
  const base = safeName(r.title);
  if (fmt === "txt") return download(new Blob([toTxt(r, o.ts, o.spk)], { type: "text/plain" }), base + ".txt");
  if (fmt === "md") return download(new Blob([`# ${r.title}\n\n**${r.project || "Atelier Astil"}** · ${fmtDate(r.created)} · ${fmtTime(r.duration)}\n\n${r.notes ? r.notes + "\n\n" : ""}` + r.segments.map((s) => `**${nameOf(r, s)}** \`${fmtTime(s.start)}\`  \n${s.text}\n`).join("\n")], { type: "text/markdown" }), base + ".md");
  if (fmt === "srt") return download(new Blob([r.segments.map((s, i) => `${i + 1}\n${ts(s.start, ",")} --> ${ts(s.end, ",")}\n${nameOf(r, s)}: ${s.text}\n`).join("\n")], { type: "application/x-subrip" }), base + ".srt");
  if (fmt === "vtt") return download(new Blob(["WEBVTT\n\n" + r.segments.map((s) => `${ts(s.start)} --> ${ts(s.end)}\n<v ${nameOf(r, s)}>${s.text}\n`).join("\n")], { type: "text/vtt" }), base + ".vtt");
  if (fmt === "json") { const { id, title, project, notes, created, duration, language, model, speakers, segments } = r; return download(new Blob([JSON.stringify({ id, title, project, notes, created, duration, language, model, speakers, segments }, null, 2)], { type: "application/json" }), base + ".json"); }
  if (fmt === "docx") {
    if (!window.JSZip) return toast("Word export needs an internet connection the first time.", 5000);
    return download(await buildDocx(r), base + ".docx");
  }
}

/* Minimal Word document in the studio format (Engravers Gothic labels, Jost Light text, bronze hairline). */
async function buildDocx(r) {
  const x = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const run = (text, { font = "Jost Light", size = 21, color = "2E2924", spacing = 0 } = {}) =>
    `<w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}" w:eastAsia="${font}"/><w:color w:val="${color}"/>${spacing ? `<w:spacing w:val="${spacing}"/>` : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${x(text)}</w:t></w:r>`;
  const para = (runs, { before = 0, after = 80, keep = false, border = false } = {}) =>
    `<w:p><w:pPr>${keep ? "<w:keepNext/>" : ""}${border ? `<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="6" w:color="8D7040"/></w:pBdr>` : ""}<w:spacing w:before="${before}" w:after="${after}"/></w:pPr>${runs}</w:p>`;
  const EG = "Engravers Gothic";
  const names = [...new Set(r.segments.map((s) => nameOf(r, s)))];
  let body = para(run("TRANSCRIPT", { font: EG, size: 16, color: "8D7040", spacing: 40 }))
    + para(run(r.title.toUpperCase(), { font: EG, size: 36, spacing: 30 }))
    + para(run(`${r.project || "Atelier Astil"} · ${fmtDate(r.created)} · ${fmtTime(r.duration)}`, { size: 18, color: "6B5C4B" }), { border: true, after: 240 });
  if (r.notes) body += para(run(r.notes, { size: 20, color: "6B5C4B" }));
  if (names.length) body += para(run("PARTICIPANTS   ", { font: EG, size: 16, color: "6B5C4B", spacing: 30 }) + run(names.join(" · "), { size: 19 }), { after: 200 });
  for (const s of r.segments) {
    body += para(run(nameOf(r, s).toUpperCase(), { font: EG, size: 16, spacing: 30 }) + run("   " + fmtTime(s.start), { size: 16, color: "6B5C4B" }), { before: 200, after: 0, keep: true });
    body += para(run(s.text), { after: 80 });
  }
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${run("ATELIER ASTIL · TRANSCRIPT", { font: EG, size: 14, color: "6B5C4B", spacing: 30 })}</w:p></w:ftr>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1361" w:right="1361" w:bottom="1361" w:left="1361" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`);
  zip.file("word/document.xml", doc);
  zip.file("word/footer1.xml", footer);
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

/* ---------------------------------------------------------------- boot */
async function updateChip() {
  await checkDevice();
  const s = getSettings();
  const label = s.mode === "english" ? "English output · " + (DEVICE.webgpu ? (DEVICE.f16 ? "Whisper large-v3" : "Whisper medium") : "Whisper small") : MODEL_INFO[chosenModel()].name;
  $("#engineChip").textContent = `${label} · ${DEVICE.webgpu ? "Graphics" : "Standard mode"}${MOCK ? " · TEST MODE" : ""}`;
}
(async () => {
  try { await navigator.storage?.persist?.(); } catch (_) {}
  // Anything left mid-way when the page was last closed must be started again.
  for (const r of await DB.all()) if (r.status === "processing" || r.status === "queued") await patch(r.id, { status: "error", error: "The page was closed before transcription finished." });
  updateChip();
  route();
})();
