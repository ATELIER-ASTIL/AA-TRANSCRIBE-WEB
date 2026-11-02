// AA TRANSCRIBE — speech engine running inside the browser (Web Worker).
// Whisper via Transformers.js; models download once from Hugging Face and are cached by the browser.
//
// Output modes
//   english  : every language becomes English text. The spoken language is detected for each
//              section of audio; English sections are transcribed, all others are translated.
//              Uses Whisper large-v3 (trained for translation).
//   original : text in the language that was spoken (Whisper large-v3-turbo).
const MOCK = new URL(self.location.href).searchParams.get("mock") === "1";
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";
const SR = 16000;

let T = null;
// One model run at a time: the graphics session cannot run two passes at once.
let gate = Promise.resolve();
function exclusive(fn) { const run = gate.then(fn, fn); gate = run.catch(() => {}); return run; }
const pipes = new Map(); // "key|device" -> Promise<pipeline>, shared by live text and full transcription

const MODELS = {
  // original-language mode
  best: "onnx-community/whisper-large-v3-turbo",
  balanced: "onnx-community/whisper-small",
  fast: "onnx-community/whisper-base",
  // English mode (translation-capable models)
  en_best: "onnx-community/whisper-large-v3-ONNX",
  en_mid: "onnx-community/whisper-medium-ONNX",
  en_small: "onnx-community/whisper-small",
};

function dtypeFor(key, device, f16) {
  if (device === "wasm") return "q8";
  if (key === "en_best") return f16 ? { encoder_model: "fp16", decoder_model_merged: "q4f16" } : { encoder_model: "fp32", decoder_model_merged: "q4" };
  if (key === "en_mid") return f16 ? { encoder_model: "fp16", decoder_model_merged: "fp16" } : { encoder_model: "fp32", decoder_model_merged: "q4" };
  if (f16) return { encoder_model: "fp16", decoder_model_merged: "fp16" };
  if (key === "best") return { encoder_model: "fp32", decoder_model_merged: "q4" };
  return { encoder_model: "fp32", decoder_model_merged: "fp32" };
}

// Which model a device uses for each mode.
function keyFor(mode, chosen, device, f16) {
  if (mode === "english") return device !== "webgpu" ? "en_small" : f16 ? "en_best" : "en_mid";
  return chosen || (device === "webgpu" ? (f16 ? "best" : "balanced") : "fast");
}
function liveKeyFor(mode, device, f16) {
  if (mode === "english") return keyFor("english", "", device, f16);
  return device === "webgpu" ? (f16 ? "best" : "balanced") : "fast";
}

function load(key, device, f16, report) {
  const id = key + "|" + device;
  if (!pipes.has(id)) {
    const p = (async () => {
      T = T || await import(LIB);
      T.env.allowLocalModels = false;
      const files = {};
      return T.pipeline("automatic-speech-recognition", MODELS[key], {
        device, dtype: dtypeFor(key, device, f16),
        progress_callback: (q) => {
          if (q.status === "progress_total") return report(q.progress, q.total);
          if (q.status === "progress" && q.file) {
            files[q.file] = [q.loaded || 0, q.total || 0];
            const v = Object.values(files), l = v.reduce((a, b) => a + b[0], 0), t = v.reduce((a, b) => a + b[1], 0);
            report(t ? (l / t) * 100 : 0, t);
          }
        },
      });
    })().catch((e) => { pipes.delete(id); throw e; });
    pipes.set(id, p);
  }
  return pipes.get(id);
}

/* ---------------- language detection: ask the model which language this section is in */
let langIds = null;
async function detectLanguage(pipe, audio) {
  const gc = pipe.model.generation_config;
  if (!gc.is_multilingual && !gc.lang_to_id) return "en";
  if (!langIds) langIds = new Map(Object.entries(gc.lang_to_id || {}).map(([tok, id]) => [Number(id), tok.replace(/[<|>]/g, "")]));
  const slice = audio.length > 30 * SR ? audio.subarray(0, 30 * SR) : audio;
  const { input_features } = await pipe.processor(slice);
  const out = await pipe.model.generate({
    inputs: input_features, decoder_input_ids: [gc.decoder_start_token_id], max_new_tokens: 1, return_timestamps: false,
  });
  const ids = out.tolist ? out.tolist()[0] : out[0].tolist();
  return langIds.get(Number(ids[ids.length - 1])) || null;
}

/* ---------------- split long audio at the quietest moment near each 28 s mark */
function sections(audio) {
  const out = [];
  const max = 28 * SR, min = 20 * SR, frame = SR / 10;
  let start = 0;
  while (audio.length - start > max) {
    let best = start + max, bestE = Infinity;
    for (let p = start + min; p + frame <= start + max; p += frame) {
      let e = 0; for (let i = p; i < p + frame; i += 4) e += audio[i] * audio[i];
      if (e < bestE) { bestE = e; best = p + frame / 2; }
    }
    out.push([start, Math.floor(best)]);
    start = Math.floor(best);
  }
  out.push([start, audio.length]);
  return out;
}

function toSegments(out, offset, dur) {
  return (out.chunks || [{ timestamp: [0, dur], text: out.text }])
    .map((c) => ({ start: offset + (c.timestamp[0] ?? 0), end: offset + (c.timestamp[1] ?? dur), text: (c.text || "").trim() }))
    .filter((c) => c.text && !/^[\[(].*[\])]$/.test(c.text));
}

// Decode one section (≤ 30 s). In English mode English speech is transcribed and anything else translated.
async function decodeSection(pipe, audio, mode, language, streamer) {
  let lang = language && language !== "auto" ? language : null;
  if (!lang) lang = await exclusive(() => detectLanguage(pipe, audio)) || "en";
  const opts = { return_timestamps: true, language: lang, task: mode === "english" && lang !== "en" ? "translate" : "transcribe" };
  if (streamer) opts.streamer = streamer;
  const out = await exclusive(() => pipe(audio, opts));
  return { out, lang };
}

/* ---------------- full transcription */
async function transcribe({ id, audio, key: chosen, device, f16, language, mode }) {
  postMessage({ type: "stage", id, stage: "Preparing the speech model" });
  const report = (progress, total) => postMessage({ type: "download", progress, total });
  let key = keyFor(mode, chosen, device, f16), pipe;
  try { pipe = await load(key, device, f16, report); }
  catch (e) {
    if (device !== "webgpu") throw e;
    postMessage({ type: "stage", id, stage: "Graphics acceleration unavailable, using standard mode" });
    device = "wasm"; key = keyFor(mode, chosen, "wasm", false);
    pipe = await load(key, "wasm", false, report);
  }
  postMessage({ type: "stage", id, stage: mode === "english" ? "Transcribing into English" : "Transcribing", device });

  const parts = sections(audio);
  const segments = [], langs = {};
  let live = "";
  for (let i = 0; i < parts.length; i++) {
    const [a, b] = parts[i];
    const chunk = audio.subarray(a, b);
    const streamer = new T.WhisperTextStreamer(pipe.tokenizer, {
      skip_prompt: true,
      callback_function: (text) => { live = (live + text).slice(-400); postMessage({ type: "live", id, text: live }); },
    });
    const { out, lang } = await decodeSection(pipe, chunk, mode, language, streamer);
    langs[lang] = (langs[lang] || 0) + (b - a);
    segments.push(...toSegments(out, a / SR, (b - a) / SR));
    live += " ";
    postMessage({ type: "progress", id, progress: Math.min(0.99, (i + 1) / parts.length) });
  }
  const spoken = Object.entries(langs).sort((x, y) => y[1] - x[1]).map(([l]) => l);
  return { segments, device, model: MODELS[key], spoken, output: mode === "english" ? "en" : spoken[0] };
}

async function mockTranscribe({ id, audio }) {
  const dur = audio.length / SR;
  for (let p = 0; p <= 100; p += 25) { postMessage({ type: "download", progress: p, loaded: p * 1e6, total: 1e8 }); await new Promise((r) => setTimeout(r, 60)); }
  postMessage({ type: "stage", id, stage: "Transcribing into English", device: "test" });
  const words = "the boq for the false ceiling and the v r f layout is ready for review at site tomorrow".split(" ");
  const segments = [];
  for (let t = 0, i = 0; t < dur - 1; t += 4, i++) {
    segments.push({ start: t, end: Math.min(dur, t + 3.6), text: words.slice(0, 6 + (i % 10)).join(" ") + "." });
    postMessage({ type: "live", id, text: segments.map((s) => s.text).join(" ").slice(-300) });
    postMessage({ type: "progress", id, progress: Math.min(0.99, t / dur) });
    await new Promise((r) => setTimeout(r, 40));
  }
  return { segments, device: "test", model: "test", spoken: ["hi", "en"], output: "en" };
}

/* ---------------- live text while recording */
let liveAnnounced = "", liveLang = null, liveCalls = 0;
async function loadLive(mode, device, f16) {
  const key = liveKeyFor(mode, device, f16);
  const pipe = await load(key, device, f16, (progress, total) => postMessage({ type: "live-loading", progress, total }));
  if (liveAnnounced !== key) { liveAnnounced = key; postMessage({ type: "live-ready", model: MODELS[key] }); }
  return pipe;
}

async function liveDecode({ seq, audio, device, f16, language, mode }) {
  if (MOCK) {
    const n = Math.floor(audio.length / SR);
    const words = "the client approved the walnut veneer for the lobby ceiling and asked for a revised boq by friday".split(" ");
    const segs = [];
    for (let i = 0; i < n; i += 3) segs.push({ start: i, end: Math.min(n, i + 2.8), text: words.slice(i % 12, i % 12 + 5).join(" ") });
    return { seq, segments: segs, device: "test", lang: "hi" };
  }
  let pipe;
  try { pipe = await loadLive(mode, device, f16); }
  catch (e) { if (device !== "webgpu") throw e; device = "wasm"; pipe = await loadLive(mode, "wasm", false); }
  // Re-check the spoken language every few passes so a switch from English to Hindi is followed.
  let lang = language && language !== "auto" ? language : null;
  if (!lang) {
    if (!liveLang || liveCalls % 4 === 0) liveLang = await exclusive(() => detectLanguage(pipe, audio)) || liveLang || "en";
    lang = liveLang;
  }
  liveCalls++;
  const opts = { return_timestamps: true, language: lang, task: mode === "english" && lang !== "en" ? "translate" : "transcribe" };
  const out = await exclusive(() => pipe(audio, opts));
  return { seq, segments: toSegments(out, 0, audio.length / SR), device, lang };
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === "live-preload") {
    liveLang = null; liveCalls = 0;
    if (!MOCK) loadLive(msg.mode, msg.device, msg.f16).catch((err) => postMessage({ type: "live-error", message: String(err && err.message || err) }));
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
