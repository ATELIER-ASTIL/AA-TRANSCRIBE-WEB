// AA TRANSCRIBE — speech engine running inside the browser (Web Worker).
// Whisper via Transformers.js; models download once from Hugging Face and are cached by the browser.
const MOCK = new URL(self.location.href).searchParams.get("mock") === "1";
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";

let T = null;            // library module
let current = null;      // { key, pipe, device }

const MODELS = {
  best: "onnx-community/whisper-large-v3-turbo",
  balanced: "onnx-community/whisper-small",
  fast: "onnx-community/whisper-base",
};

function dtypeFor(key, device, f16) {
  if (device === "wasm") return "q8";
  if (key === "best") return { encoder_model: f16 ? "fp16" : "fp32", decoder_model_merged: "q4" };
  return { encoder_model: "fp32", decoder_model_merged: "q4" };
}

async function load(key, device, f16) {
  if (current && current.key === key && current.device === device) return current.pipe;
  if (current) { try { await current.pipe.dispose(); } catch (_) {} current = null; }
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
  current = { key, pipe, device };
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
  const out = await pipe(audio, opts);
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

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type !== "transcribe") return;
  try {
    const result = MOCK ? await mockTranscribe(msg) : await transcribe(msg);
    postMessage({ type: "done", id: msg.id, ...result });
  } catch (err) {
    postMessage({ type: "error", id: msg.id, message: String(err && err.message || err) });
  }
};
