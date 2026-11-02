// AA TRANSCRIBE — speech engine running inside the browser (Web Worker).
// Whisper via Transformers.js; models download once from Hugging Face and are cached by the browser.
const MOCK = new URL(self.location.href).searchParams.get("mock") === "1";
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";

let T = null;            // library module
// One model run at a time: the graphics session cannot run two passes at once.
let gate = Promise.resolve();
function exclusive(fn) { const run = gate.then(fn, fn); gate = run.catch(() => {}); return run; }
const pipes = new Map(); // "key|device" -> Promise<pipeline>  (shared by live preview and full transcription)

const MODELS = {
  best: "onnx-community/whisper-large-v3-turbo",
  balanced: "onnx-community/whisper-small",
  fast: "onnx-community/whisper-base",
};

// Full precision wherever the device allows it: compressed (q4) weights cost accuracy.
function dtypeFor(key, device, f16) {
  if (device === "wasm") return "q8";
  if (f16) return { encoder_model: "fp16", decoder_model_merged: "fp16" };
  if (key === "best") return { encoder_model: "fp32", decoder_model_merged: "q4" };
  return { encoder_model: "fp32", decoder_model_merged: "fp32" };
}

function load(key, device, f16) {
  const id = key + "|" + device;
  if (!pipes.has(id)) {
    const p = create(key, device, f16).catch((e) => { pipes.delete(id); throw e; });
    pipes.set(id, p);
  }
  return pipes.get(id);
}

async function create(key, device, f16) {
  T = T || await import(LIB);
  T.env.allowLocalModels = false;
  const files = {};
  const pipe = await T.pipeline("automatic-speech-recognition", MODELS[key], {
    device, dtype: dtypeFor(key, device, f16),
    progress_callback: (p) => {
      if (p.status === "progress_total") {
        postMessage({ type: "download", progress: p.progress, loaded: p.loaded, total: p.total });
      } else if (p.status === "progress" && p.file) {
        files[p.file] = [p.loaded || 0, p.total || 0];
        const v = Object.values(files);
        const loaded = v.reduce((a, b) => a + b[0], 0), total = v.reduce((a, b) => a + b[1], 0);
        postMessage({ type: "download", progress: total ? (loaded / total) * 100 : 0, loaded, total });
      }
    },
  });
  return pipe;
}

async function transcribe({ id, audio, key, device, f16, language, task }) {
  postMessage({ type: "stage", id, stage: "Preparing the speech model" });
  let pipe;
  try {
    pipe = await load(key, device, f16);
  } catch (e) {
    if (device !== "webgpu") throw e;
    postMessage({ type: "stage", id, stage: "Graphics acceleration unavailable, using standard mode" });
    device = "wasm";
    pipe = await load(key, "wasm", false);
  }
  postMessage({ type: "stage", id, stage: "Transcribing", device });

  const sr = 16000, chunk = 30, stride = 5;
  const win = chunk * sr, step = (chunk - 2 * stride) * sr;
  const windows = audio.length <= win ? 1 : Math.ceil((audio.length - win) / step) + 1;
  let done = 0, live = "";
  const streamer = new T.WhisperTextStreamer(pipe.tokenizer, {
    skip_prompt: true,
    callback_function: (text) => { live = (live + text).slice(-400); postMessage({ type: "live", id, text: live }); },
    on_finalize: () => { done++; postMessage({ type: "progress", id, progress: Math.min(0.99, done / windows) }); live += " "; },
  });
  const opts = { chunk_length_s: chunk, stride_length_s: stride, return_timestamps: true, streamer };
  if (language && language !== "auto") opts.language = language;
  if (task === "translate") opts.task = "translate";
  else if (language && language !== "auto") opts.task = "transcribe";
  const out = await exclusive(() => pipe(audio, opts));
  const duration = audio.length / sr;
  const segments = (out.chunks || [{ timestamp: [0, duration], text: out.text }])
    .map((c) => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? duration, text: (c.text || "").trim() }))
    .filter((c) => c.text);
  return { segments, device, model: MODELS[key] };
}

async function mockTranscribe({ id, audio }) {
  const dur = audio.length / 16000;
  for (let p = 0; p <= 100; p += 25) { postMessage({ type: "download", progress: p, loaded: p * 1e6, total: 1e8 }); await new Promise((r) => setTimeout(r, 60)); }
  postMessage({ type: "stage", id, stage: "Transcribing", device: "test" });
  const words = "the boq for the false ceiling and the v r f layout is ready for review at site tomorrow".split(" ");
  const segments = [];
  for (let t = 0, i = 0; t < dur - 1; t += 4, i++) {
    segments.push({ start: t, end: Math.min(dur, t + 3.6), text: words.slice(0, 6 + (i % 10)).join(" ") + "." });
    postMessage({ type: "live", id, text: segments.map((s) => s.text).join(" ").slice(-300) });
    postMessage({ type: "progress", id, progress: Math.min(0.99, t / dur) });
    await new Promise((r) => setTimeout(r, 40));
  }
  return { segments, device: "test", model: "test" };
}

/* ---------------- live preview: a small fast model decodes the last few seconds while people talk */
// Live text uses the same large model as the final transcript when the graphics chip supports it,
// so what you see while talking is already close to final. Otherwise the best model the device can keep up with.
function liveKeyFor(device, f16) { return device === "webgpu" ? (f16 ? "best" : "balanced") : "fast"; }
let liveAnnounced = false;
async function loadLive(device, f16) {
  const key = liveKeyFor(device, f16);
  const id = key + "|" + device;
  if (!pipes.has(id)) {
    const p = (async () => {
      T = T || await import(LIB);
      T.env.allowLocalModels = false;
      return T.pipeline("automatic-speech-recognition", MODELS[key], {
        device, dtype: dtypeFor(key, device, f16),
        progress_callback: (q) => { if (q.status === "progress_total") postMessage({ type: "live-loading", progress: q.progress, total: q.total }); },
      });
    })().catch((e) => { pipes.delete(id); throw e; });
    pipes.set(id, p);
  }
  const pipe = await pipes.get(id);
  if (!liveAnnounced) { liveAnnounced = true; postMessage({ type: "live-ready", model: MODELS[key] }); }
  return pipe;
}

async function liveDecode({ seq, audio, device, f16, language }) {
  if (MOCK) {
    const n = Math.floor(audio.length / 16000);
    const words = "the client approved the walnut veneer for the lobby ceiling and asked for a revised boq by friday".split(" ");
    const segs = [];
    for (let i = 0; i < n; i += 3) segs.push({ start: i, end: Math.min(n, i + 2.8), text: words.slice(i % 12, i % 12 + 5).join(" ") });
    return { seq, segments: segs, device: "test" };
  }
  let pipe;
  try { pipe = await loadLive(device, f16); }
  catch (e) { if (device !== "webgpu") throw e; device = "wasm"; pipe = await loadLive("wasm", false); }
  const opts = { return_timestamps: true };
  if (language && language !== "auto") { opts.language = language; opts.task = "transcribe"; }
  const out = await exclusive(() => pipe(audio, opts));
  const dur = audio.length / 16000;
  const segments = (out.chunks || [{ timestamp: [0, dur], text: out.text }])
    .map((c) => ({ start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? dur, text: (c.text || "").trim() }))
    .filter((c) => c.text && !/^[\[(].*[\])]$/.test(c.text));
  return { seq, segments, device };
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "live-preload") {
    if (!MOCK) loadLive(msg.device, msg.f16).catch((err) => postMessage({ type: "live-error", message: String(err && err.message || err) }));
    else postMessage({ type: "live-ready" });
    return;
  }
  if (msg.type === "live") {
    try { postMessage({ type: "live-result", ...(await liveDecode(msg)) }); }
    catch (err) { postMessage({ type: "live-error", seq: msg.seq, message: String(err && err.message || err) }); }
    return;
  }
  if (msg.type !== "transcribe") return;
  try {
    const result = MOCK ? await mockTranscribe(msg) : await transcribe(msg);
    postMessage({ type: "done", id: msg.id, ...result });
  } catch (err) {
    postMessage({ type: "error", id: msg.id, message: String(err && err.message || err) });
  }
};
