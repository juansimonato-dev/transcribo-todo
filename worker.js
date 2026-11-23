// Worker: carga Whisper (transcripción) y WavLM-SV (huella de voz) y procesa frases de a una.
import { pipeline, env, WavLMForXVector, AutoProcessor } from './lib/transformers.min.js';
import { normalize } from './core.js';

env.allowLocalModels = false;
env.useBrowserCache = true; // los modelos quedan guardados en el dispositivo (Cache Storage)
env.useWasmCache = false; // el service worker ya guarda el motor (.wasm)

const BASE = new URL('./lib/', import.meta.url).href;
let asr = null;
let spk = null;
let spkProc = null;

const post = (m, t) => self.postMessage(m, t || []);

const t0 = performance.now();
const log = (msg) => post({ type: 'log', msg: `[${((performance.now() - t0) / 1000).toFixed(1)} s] ${msg}` });

function setWasm(flavor, threads) {
  const suffix = flavor === 'plain' ? '' : '.asyncify';
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${BASE}ort-wasm-simd-threaded${suffix}.mjs`,
    wasm: `${BASE}ort-wasm-simd-threaded${suffix}.wasm`,
  };
  // varios núcleos solo si se pidió Y el navegador lo permite; por defecto 1 (lo más estable)
  env.backends.onnx.wasm.numThreads = threads && self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
}

const progress = (p) => {
  if (p && p.file) post({ type: 'progress', status: p.status, file: p.file, loaded: p.loaded, total: p.total });
};

async function loadAsr(modelId, threads) {
  // El motor se elige UNA vez: si el archivo "asyncify" (más grande) no está publicado, uso el liviano.
  let flavor = 'plain';
  try {
    const r = await fetch(`${BASE}ort-wasm-simd-threaded.asyncify.mjs`);
    r.body?.cancel();
    if (r.ok) flavor = 'asyncify';
  } catch {}
  setWasm(flavor, threads);
  log(`Motor: ${flavor}, núcleos: ${env.backends.onnx.wasm.numThreads}. Cargando ${modelId}…`);
  asr = await pipeline('automatic-speech-recognition', modelId, { dtype: 'q8', device: 'wasm', progress_callback: progress });
  return flavor;
}

let asrReady = Promise.resolve();

async function loadAsrStage({ asrModel, threads }) {
  try {
    const flavor = await loadAsr(asrModel, threads);
    log('Transcripción lista.');
    post({ type: 'asr-ready', flavor, threads: env.backends.onnx.wasm.numThreads, isolated: !!self.crossOriginIsolated });
    return true;
  } catch (e) {
    log('ERROR al cargar la transcripción: ' + String(e?.message || e));
    post({ type: 'error', stage: 'asr', message: String(e?.message || e) });
    return false;
  }
}

async function loadSpkStage({ spkModel }) {
  try {
    log('Cargando identificación de voces…');
    spkProc = await AutoProcessor.from_pretrained(spkModel, { progress_callback: progress });
    spk = await WavLMForXVector.from_pretrained(spkModel, { dtype: 'q8', device: 'wasm', progress_callback: progress });
    log('Voces listas.');
    post({ type: 'ready', speakers: true });
  } catch (e) {
    spk = null;
    log('ERROR al cargar voces (la transcripción sigue funcionando): ' + String(e?.message || e));
    post({ type: 'ready', speakers: false, message: String(e?.message || e) });
  }
}

function load(m) {
  asrReady = loadAsrStage(m).then((ok) => {
    if (ok) loadSpkStage(m); // en segundo plano: NO bloquea la transcripción
    return ok;
  });
}

async function embed(audio) {
  if (!spk || !spkProc || audio.length < 16000 * 0.6) return null; // menos de ~0.6 s no alcanza para una huella confiable
  const a = audio.length > 16000 * 10 ? audio.subarray(0, 16000 * 10) : audio;
  const inputs = await spkProc(a);
  const out = await spk(inputs);
  const t = out.embeddings ?? out.logits;
  return normalize(Array.from(t.data));
}

const asrQ = [];
const embQ = [];
let running = false;

async function doAsr({ id, audio, wantEmbedding }) {
  const t0 = performance.now();
  let text = '';
  let error = null;
  try {
    const r = await asr(audio, { language: 'spanish', task: 'transcribe', max_new_tokens: 220 });
    text = (Array.isArray(r) ? r.map((x) => x.text).join(' ') : r.text || '').trim();
  } catch (e) {
    error = String(e?.message || e);
  }
  // el texto sale enseguida; la huella de voz llega después
  post({ type: 'result', id, text, ms: Math.round(performance.now() - t0), error, embeddingPending: !!(wantEmbedding && spk && !error) });
  if (wantEmbedding && spk && !error) embQ.push({ id, audio });
}

async function doEmbed({ id, audio }) {
  let embedding = null;
  try { embedding = await embed(audio); } catch (e) { embedding = null; }
  post({ type: 'embedding', id, embedding });
}

async function pump() {
  if (running) return;
  running = true;
  while (asrQ.length || embQ.length) {
    if (asrQ.length) await doAsr(asrQ.shift()); // siempre se transcribe primero
    else await doEmbed(embQ.shift());
  }
  running = false;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load') load(m);
  else if (m.type === 'process') {
    asrReady.then((ok) => {
      if (!ok || !asr) { post({ type: 'result', id: m.id, text: '', ms: 0, error: 'El motor de transcripción no está listo.' }); return; }
      // transcripción en vivo: si hay demasiado atraso, se descarta lo más viejo
      while (asrQ.length >= 4) {
        const d = asrQ.shift();
        post({ type: 'result', id: d.id, text: '', ms: 0, dropped: true });
      }
      asrQ.push(m);
      pump();
    });
  }
};
