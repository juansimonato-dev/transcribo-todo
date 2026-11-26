import {
  Segmenter, MAX_SPEAKERS, SAMPLE_RATE, resampleLinear, extractName, capitalizeName,
  matchSpeaker, updateCentroid, cleanTranscript, applyCustomWords, formatTime,
} from './core.js';
import { CloudASR } from './cloud.js';

window.__txLoaded = true;
const $ = (id) => document.getElementById(id);
const SPK_MODEL = 'Xenova/wavlm-base-plus-sv';
const MODELS = {
  tiny: { id: 'Xenova/whisper-tiny', label: 'Liviano (más rápido, menos preciso) · ~45 MB', mb: 45 },
  base: { id: 'Xenova/whisper-base', label: 'Equilibrado (recomendado) · ~90 MB', mb: 90 },
  small: { id: 'Xenova/whisper-small', label: 'Preciso (más lento, para equipos potentes) · ~280 MB', mb: 280 },
};
const DEF = { fs: 34, theme: 'dark', model: 'base', th: 0.85, words: '', mic: '', gain: 6, cloud: true, cloudKey: '' };

/* ───────────── Estado y persistencia ───────────── */
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const S = { ...DEF, ...load('tx.settings', {}) };
if (!MODELS[S.model]) S.model = 'base';
let speakers = load('tx.speakers', []);
let lines = load('tx.log', []).filter((l) => l && l.text);
const lineEls = new Map();
const words = () => S.words.split(/[\n,]/).map((w) => w.trim()).filter(Boolean);
const saveSettings = () => save('tx.settings', S);
const saveSpeakers = () => save('tx.speakers', speakers);
const saveLog = () => save('tx.log', lines.filter((l) => !l.pending && l.text).slice(-300).map(({ emb, ...l }) => l));
const speakerById = (id) => speakers.find((s) => s.id === id);
const cands = () => speakers.filter((s) => s.centroid && s.centroid.length); // los que tienen huella de voz

/* ───────────── Ajustes visibles ───────────── */
function applySettings() {
  document.documentElement.dataset.theme = S.theme;
  document.documentElement.style.setProperty('--fs', S.fs + 'px');
  $('fs').value = S.fs; $('fsVal').textContent = S.fs + ' px';
  $('theme').value = S.theme;
  $('th').value = S.th; $('thVal').textContent = Number(S.th).toFixed(2);
  $('words').value = S.words;
  $('gain').value = S.gain; $('gainVal').textContent = '×' + S.gain;
  $('cloudOn').checked = !!S.cloud; $('cloudKey').value = S.cloudKey || '';
  const m = document.querySelector('meta[name=theme-color]');
  if (m) m.content = S.theme === 'light' ? '#ffffff' : '#0b0f14';
}
$('model').innerHTML = Object.entries(MODELS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
$('model').value = S.model;
$('fs').oninput = (e) => { S.fs = +e.target.value; applySettings(); saveSettings(); };
$('theme').onchange = (e) => { S.theme = e.target.value; applySettings(); saveSettings(); };
$('th').oninput = (e) => { S.th = +e.target.value; applySettings(); saveSettings(); };
$('gain').oninput = (e) => { S.gain = +e.target.value; applySettings(); saveSettings(); };
$('words').onchange = (e) => { S.words = e.target.value; saveSettings(); };
$('cloudOn').onchange = (e) => { S.cloud = e.target.checked; saveSettings(); reconnectCloud(); };
$('cloudKey').onchange = (e) => { S.cloudKey = e.target.value.trim(); saveSettings(); cloudFail = 0; reconnectCloud(); };
$('cloudTest').onclick = async () => {
  const key = $('cloudKey').value.trim();
  if (!key) { $('cloudMsg').textContent = 'Pegá primero la clave.'; return; }
  $('cloudMsg').textContent = 'Probando…';
  const c = new CloudASR({ key, diarize: false });
  try { await c.connect(); c.close(); $('cloudMsg').textContent = '✅ Conectó bien con la nube.'; }
  catch (e) { $('cloudMsg').textContent = '❌ No pude conectar: ' + e.message + '. Revisá la clave y la conexión a internet.'; }
};
$('btnSettings').onclick = () => { $('settings').hidden = false; checkReady(); };
$('btnCloseSettings').onclick = () => { $('settings').hidden = true; };
applySettings();

/* ───────────── Transcripción en pantalla ───────────── */
let stick = true;
const log = $('log');
log.addEventListener('scroll', () => {
  stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  $('btnBottom').hidden = stick;
});
$('btnBottom').onclick = () => { stick = true; log.scrollTop = log.scrollHeight; $('btnBottom').hidden = true; };

function lineLabel(l) {
  if (l.pending || l.waiting) return { cls: '', who: '' };
  if (l.spk === null || l.spk === undefined) return { cls: '', who: '' };
  if (l.spk === '?') return { cls: 'cu', who: '¿Quién?' };
  const sp = speakerById(l.spk);
  return sp ? { cls: 'c' + sp.color, who: sp.name } : { cls: 'cu', who: '¿Quién?' };
}

function renderLine(l) {
  let el = lineEls.get(l.id);
  if (!el) {
    el = document.createElement('p');
    el.dataset.id = l.id;
    el.onclick = () => openAssign(l.id);
    log.appendChild(el);
    lineEls.set(l.id, el);
    $('empty')?.remove();
  }
  const { cls, who } = lineLabel(l);
  el.className = ['line', cls, l.pending ? 'pending' : '', l.uncertain ? 'uncertain' : ''].filter(Boolean).join(' ');
  el.replaceChildren();
  if (who) {
    const w = document.createElement('span');
    w.className = 'who'; w.textContent = who + ':';
    el.append(w, ' ');
  }
  const t = document.createElement('span');
  t.className = 'txt'; t.textContent = l.text;
  el.append(t);
  if (l.interim) {
    const i = document.createElement('span');
    i.className = 'interim'; i.textContent = (l.text ? ' ' : '') + l.interim;
    el.append(i);
  }
  if (stick) log.scrollTop = log.scrollHeight;
}

function removeLine(id) {
  lines = lines.filter((l) => l.id !== id);
  lineEls.get(id)?.remove();
  lineEls.delete(id);
}
const rerenderAll = () => lines.forEach(renderLine);
lines.forEach((l) => { l.pending = false; renderLine(l); });
if (lines.length) stick = true;

/* ───────────── Interlocutores ───────────── */
function renderChips() {
  $('chips').replaceChildren(...speakers.map((sp) => {
    const b = document.createElement('button');
    b.className = 'chip c' + sp.color;
    b.textContent = sp.name;
    b.onclick = () => openSpkMenu(sp.id);
    return b;
  }));
  $('btnAdd').disabled = speakers.length >= MAX_SPEAKERS;
  $('btnAdd').textContent = speakers.length >= MAX_SPEAKERS ? `Máximo ${MAX_SPEAKERS} interlocutores` : '＋ Agregar interlocutor';
}

function freeColor() {
  const used = new Set(speakers.map((s) => s.color));
  for (let i = 0; i < MAX_SPEAKERS; i++) if (!used.has(i)) return i;
  return 0;
}

/* Menú de un interlocutor */
let menuId = null;
function openSpkMenu(id) {
  const sp = speakerById(id); if (!sp) return;
  menuId = id;
  $('smTitle').textContent = sp.name;
  $('smTitle').style.color = `var(--sp${sp.color})`;
  $('smName').value = sp.name;
  $('spkMenu').hidden = false;
}
function closeSpkMenu() {
  const sp = speakerById(menuId);
  const n = capitalizeName($('smName').value.trim());
  if (sp && n && n !== sp.name) { sp.name = n; saveSpeakers(); renderChips(); rerenderAll(); saveLog(); }
  $('spkMenu').hidden = true; menuId = null;
}
$('smOk').onclick = closeSpkMenu;
$('smRetrain').onclick = () => { const id = menuId; closeSpkMenu(); openEnroll(id); };
$('smDelete').onclick = () => {
  const sp = speakerById(menuId); if (!sp) return;
  if (!confirm(`¿Eliminar a ${sp.name}?`)) return;
  speakers = speakers.filter((s) => s.id !== sp.id);
  for (const [k, v] of dgMap) if (v === sp.id) dgMap.delete(k);
  lines.forEach((l) => { if (l.spk === sp.id) l.spk = '?'; });
  saveSpeakers(); saveLog(); renderChips(); rerenderAll();
  $('spkMenu').hidden = true; menuId = null;
};

/* Cambiar quién dijo una frase (y aprender de la corrección) */
let assignId = null;
function openAssign(lineId) {
  const l = lines.find((x) => x.id === lineId); if (!l || l.pending || !speakers.length) return;
  assignId = lineId;
  const mk = (label, cls, fn) => {
    const b = document.createElement('button');
    b.textContent = label; if (cls) b.className = cls;
    if (cls?.startsWith('c')) b.style.setProperty('--c', `var(--sp${cls.slice(1)})`);
    b.onclick = () => { fn(); $('assign').hidden = true; };
    return b;
  };
  $('asList').replaceChildren(
    ...speakers.map((sp) => mk(sp.name, 'c' + sp.color, () => reassign(l, sp.id))),
    mk('Sin identificar', '', () => reassign(l, '?')),
  );
  $('assign').hidden = false;
}
function reassign(l, spkId) {
  l.spk = spkId; l.uncertain = false;
  const sp = speakerById(spkId);
  if (l.cloud && l.dg != null && l.sess === cloudSess) { // nube: se aprende "esta voz de la nube = esta persona"
    if (spkId === '?') dgMap.delete(l.dg); else dgMap.set(l.dg, spkId);
    relabelSession(l.dg);
  }
  if (sp && l.emb) {
    if (sp.centroid) updateCentroid(sp, l.emb); else { sp.centroid = Array.from(l.emb); sp.n = 1; }
    saveSpeakers();
  }
  renderLine(l); saveLog();
}
$('asCancel').onclick = () => { $('assign').hidden = true; };

/* ───────────── Motor (worker) ───────────── */
let worker = null, asrReady = false, spkReady = false;
const jobs = new Map();
let jobSeq = 0, files = {}, slowWarned = false, loadStage = '', retries = 0, loadTimer = null;
const diag = [];
const addLog = (t) => { diag.push(t); if (diag.length > 60) diag.shift(); const el = $('diag'); if (el) el.textContent = diag.join('\n'); };

const setNotice = (t) => { $('notice').hidden = !t; $('notice').textContent = t || ''; };

function startWorker() {
  worker?.terminate();
  jobs.forEach((j) => { if (j.lineId) removeLine(j.lineId); });
  jobs.clear();
  asrReady = spkReady = false; files = {};
  try {
    worker = new Worker('worker.js', { type: 'module' });
  } catch (e) {
    setNotice('Este navegador no puede correr el motor de voz. Probá con Chrome o Safari actualizados.');
    return;
  }
  worker.onmessage = onWorker;
  worker.onerror = (e) => setNotice('Error en el motor de voz: ' + (e.message || 'desconocido'));
  $('loadbar').hidden = false; $('loadfill').style.width = '0'; $('loadtext').textContent = 'Cargando reconocimiento de voz…';
  addLog(`${new Date().toLocaleTimeString('es-AR')} Iniciando motor (${MODELS[S.model].id})`);
  loadStage = 'transcripción';
  worker.postMessage({ type: 'load', asrModel: MODELS[S.model].id, spkModel: SPK_MODEL, threads: false });
  clearTimeout(loadTimer);
  loadTimer = setTimeout(() => {
    if (asrReady) return;
    addLog('El motor no arrancó en 2 minutos.');
    if (retries++ < 1) { setNotice('El motor tardó demasiado en arrancar. Reiniciándolo…'); startWorker(); }
    else setNotice('El motor de voz no arranca. Mirá Ajustes → Diagnóstico y mandame ese texto.');
  }, 120000);
  updateLive();
}

function onWorker(e) {
  const m = e.data;
  if (m.type === 'progress') {
    if (m.status === 'done') { if (files[m.file]) files[m.file].loaded = files[m.file].total; }
    else if (m.total) files[m.file] = { loaded: m.loaded || 0, total: m.total };
    const v = Object.values(files);
    const tot = v.reduce((a, f) => a + f.total, 0), got = v.reduce((a, f) => a + f.loaded, 0);
    if (tot) {
      const pct = Math.min(100, Math.round((got / tot) * 100));
      $('loadfill').style.width = pct + '%';
      $('loadtext').textContent = `Cargando ${loadStage}… ${pct} %  (la primera vez se descargan; después quedan guardados)`;
    }
  } else if (m.type === 'asr-ready') {
    asrReady = true;
    $('speed').textContent = `Procesamiento: ${m.threads} ${m.threads === 1 ? 'núcleo' : 'núcleos'}${m.isolated ? '' : ' (modo básico)'}`;
    loadStage = 'identificación de voces'; files = {};
    $('loadtext').textContent = 'Ya puedo transcribir. Cargando identificación de voces en segundo plano…';
    setTimeout(() => { if (asrReady && !spkReady) $('loadbar').hidden = true; }, 4000); // no molestar mientras las voces cargan de fondo
    setNotice('');
  } else if (m.type === 'ready') {
    spkReady = m.speakers;
    $('loadbar').hidden = true;
    if (!m.speakers) setNotice('Transcribo, pero no pude cargar el reconocimiento de voces todavía (se necesita internet la primera vez).');
    checkReady();
  } else if (m.type === 'error') {
    $('loadbar').hidden = true;
    setNotice(navigator.onLine
      ? (/fetch|network|load/i.test(m.message)
        ? 'No pude descargar el reconocimiento de voz (la red lo bloquea o es inestable). Probá de nuevo con otra conexión; se baja una sola vez.'
        : 'No pude cargar el reconocimiento de voz: ' + m.message)
      : 'Primera vez: hace falta internet una sola vez para bajar el reconocimiento de voz. Cuando haya conexión lo hago solo; después funciona sin internet.');
  } else if (m.type === 'log') {
    addLog(m.msg);
  } else if (m.type === 'result') {
    onResult(m);
  } else if (m.type === 'embedding') {
    onEmbedding(m);
  }
}

function sendJob(audio, extra) {
  const id = ++jobSeq;
  jobs.set(id, extra);
  const wantEmbedding = extra.kind === 'enroll' || extra.kind === 'enrollEmb' || speakers.length > 0; // sin interlocutores no hace falta la huella
  worker?.postMessage({ type: 'process', id, audio, wantEmbedding }, [audio.buffer]);
  updateLive();
}

function onResult(m) {
  const job = jobs.get(m.id);
  if (!job) return;
  if (!m.embeddingPending) jobs.delete(m.id);
  updateLive();
  if (m.ms) $('speed').dataset.last = (m.ms / 1000).toFixed(1);
  $('speedLast').textContent = m.ms ? `Última frase: ${(m.ms / 1000).toFixed(1)} s` : '';
  if (m.ms > 7000 && !slowWarned) {
    slowWarned = true;
    setNotice('Este dispositivo tarda en transcribir. Para más velocidad: Ajustes → Calidad → Liviano.');
  }
  if (m.error) { setNotice('Error al transcribir: ' + m.error); addLog('Error al transcribir: ' + m.error); }
  if (job.kind === 'enrollEmb') { if (!m.embeddingPending) jobs.delete(m.id); return; }
  if (job.kind === 'enroll') { job.text = m.text; if (!m.embeddingPending) onEnrollResult({ text: m.text, embedding: null }); return; }

  const l = lines.find((x) => x.id === job.lineId); if (!l) return;
  const text = cleanTranscript(applyCustomWords(m.text || '', words()));
  if (!text) { removeLine(l.id); jobs.delete(m.id); return; }
  l.text = text; l.pending = false;
  if (!speakers.length) l.spk = null;
  else if (m.embeddingPending) l.waiting = true; // se muestra sin color hasta que llegue la huella de voz
  else l.spk = '?';
  renderLine(l); saveLog();
}

function onEmbedding(m) {
  const job = jobs.get(m.id); jobs.delete(m.id);
  updateLive();
  if (!job) return;
  if (job.kind === 'enroll') return onEnrollResult({ text: job.text, embedding: m.embedding });
  if (job.kind === 'enrollEmb') { // modo nube: la huella de voz llega aparte
    if (m.embedding && enroll.stage !== 'idle') {
      const sp = enroll.refId ? speakerById(enroll.refId) : null;
      if (sp) { const e = Float32Array.from(m.embedding); if (sp.centroid) { updateCentroid(sp, e); updateCentroid(sp, e); } else { sp.centroid = Array.from(e); sp.n = 1; } saveSpeakers(); }
      else enroll.emb = m.embedding;
    }
    return;
  }
  const l = lines.find((x) => x.id === job.lineId); if (!l) return;
  l.waiting = false;
  if (!speakers.length) l.spk = null;
  else if (!m.embedding) l.spk = '?';
  else {
    const emb = Float32Array.from(m.embedding);
    l.emb = emb;
    const cs = cands();
    const r = cs.length ? matchSpeaker(emb, cs, { threshold: S.th }) : { index: -1 };
    if (r.index < 0) l.spk = '?';
    else {
      const sp = cs[r.index];
      l.spk = sp.id; l.uncertain = !!r.close;
      if (r.confident) { updateCentroid(sp, emb); saveSpeakers(); }
    }
  }
  renderLine(l); saveLog();
}

/* ───────────── Micrófono (escucha siempre; solo se pausa a pedido) ───────────── */
let ctx = null, stream = null, node = null, seg = null, micOn = false, wake = null;
let micWanted = true, lastSound = Date.now(), silentWarned = false, starting = false;

function updateLive() {
  const el = $('live');
  let t = 'Micrófono en pausa', c = 'live';
  if (micOn) {
    if (seg?.speaking) { t = '🗣 Detecté voz…'; c = 'live hear'; }
    else if (jobs.size) { t = `⏳ Transcribiendo${jobs.size > 1 ? ` (${jobs.size})` : ''}…`; c = 'live busy'; }
    else { t = '🎙 Escuchando…'; }
  } else if (jobs.size) { t = `⏳ Terminando de transcribir (${jobs.size})…`; c = 'live busy'; }
  el.textContent = t; el.className = c;
}

async function listMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    $('micSel').innerHTML = '<option value="">Predeterminado</option>' + devs.map((d, i) =>
      `<option value="${d.deviceId}">${(d.label || 'Micrófono ' + (i + 1)).replace(/</g, '')}</option>`).join('');
    $('micSel').value = S.mic || '';
  } catch {}
}
$('micSel').onchange = (e) => { S.mic = e.target.value; saveSettings(); if (micWanted) restartMic(); };
navigator.mediaDevices?.addEventListener?.('devicechange', listMics);

async function startMic() {
  if (starting || micOn) return micOn;
  starting = true;
  try {
    const base = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: S.mic ? { ...base, deviceId: { exact: S.mic } } : base });
    } catch (e) {
      if (!S.mic) throw e;
      S.mic = ''; saveSettings();
      stream = await navigator.mediaDevices.getUserMedia({ audio: base }); // el micrófono elegido ya no está
    }
  } catch (e) {
    starting = false;
    setNotice('No pude usar el micrófono. Tocá el candado junto a la dirección (o el ícono del micrófono) y permití el micrófono; después tocá “Activar micrófono”.');
    $('btnMic').textContent = '🎙 Activar micrófono'; $('btnMic').classList.remove('on');
    return false;
  }
  try {
    try { ctx = new AudioContext({ sampleRate: SAMPLE_RATE }); } catch { ctx = new AudioContext(); }
    await ctx.audioWorklet.addModule('worklet.js');
    const src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'capture');
    const mute = ctx.createGain(); mute.gain.value = 0;
    src.connect(node); node.connect(mute); mute.connect(ctx.destination);
    seg = new Segmenter({ sampleRate: SAMPLE_RATE });
    node.port.onmessage = (e) => {
      let a = e.data;
      if (ctx.sampleRate !== SAMPLE_RATE) a = resampleLinear(a, ctx.sampleRate, SAMPLE_RATE);
      onAudio(a);
    };
    stream.getAudioTracks()[0].onended = () => { if (micWanted) restartMic(); };
    if (ctx.state !== 'running') { try { await ctx.resume(); } catch {} }
    if (ctx.state !== 'running') {
      setNotice('Tocá cualquier parte de la pantalla para activar el micrófono.');
      const go = async () => { try { await ctx.resume(); } catch {} if (ctx?.state === 'running') setNotice(''); };
      addEventListener('pointerdown', go, { once: true }); addEventListener('keydown', go, { once: true });
    }
  } catch (e) {
    starting = false;
    setNotice('No pude iniciar el audio: ' + (e.message || e));
    return false;
  }
  micOn = true; starting = false; lastSound = Date.now(); silentWarned = false;
  $('btnMic').textContent = '⏸ Pausar'; $('btnMic').classList.add('on');
  try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  listMics();
  updateLive();
  connectCloud(); // sin esperar: mientras tanto sigue en modo local
  return true;
}

function stopMic() {
  if (seg) seg.flush().forEach(handleEvent);
  micOn = false;
  disconnectCloud();
  try { node?.disconnect(); } catch {}
  stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  try { ctx?.close(); } catch {}
  node = stream = ctx = null;
  try { wake?.release(); } catch {}
  $('btnMic').textContent = '▶ Reanudar'; $('btnMic').classList.remove('on');
  $('meter').style.width = '0'; $('enMeter').style.width = '0';
  updateLive();
}
async function restartMic() { stopMic(); await new Promise((r) => setTimeout(r, 300)); if (micWanted) await startMic(); }

$('btnMic').onclick = async () => {
  if (micOn) { micWanted = false; stopMic(); }
  else { micWanted = true; setNotice(''); await startMic(); }
};
document.addEventListener('visibilitychange', async () => {
  if (micOn && document.visibilityState === 'visible') { try { wake = await navigator.wakeLock?.request('screen'); } catch {} }
});
// vigilante: si el audio se suspende o se corta, lo reactiva solo
setInterval(async () => {
  if (!micWanted || starting) return;
  if (!micOn) { await startMic(); return; }
  if (ctx && ctx.state !== 'running') { try { await ctx.resume(); } catch {} }
  if (stream && stream.getAudioTracks()[0]?.readyState === 'ended') restartMic();
}, 5000);

let peakEnv = 0.05, curGain = 1;
function onAudio(a) {
  // amplificación automática: sube solo si el micrófono es bajito, y nunca satura (S.gain es el tope)
  let rawPeak = 0;
  for (let i = 0; i < a.length; i += 8) { const v = Math.abs(a[i]); if (v > rawPeak) rawPeak = v; }
  peakEnv = Math.max(rawPeak, peakEnv * 0.97);
  const g = Math.min(S.gain, Math.max(1, 0.35 / Math.max(peakEnv, 1e-4)));
  curGain = g;
  if (g > 1.05) for (let i = 0; i < a.length; i++) { const v = a[i] * g; a[i] = v > 1 ? 1 : v < -1 ? -1 : v; }
  const events = seg.push(a);
  const db = 20 * Math.log10(Math.max(seg.lastRms, 1e-5));
  const lvl = Math.max(0, Math.min(1, (db + 60) / 45)) * 100 + '%'; // -60 dB .. -15 dB
  $('meter').style.width = lvl; $('enMeter').style.width = lvl;
  let peak = 0;
  for (let i = 0; i < a.length; i += 16) peak = Math.max(peak, Math.abs(a[i]));
  const now = Date.now();
  if (peak > 0.002) {
    lastSound = now;
    if (silentWarned) { silentWarned = false; setNotice(''); }
  } else if (now - lastSound > 6000 && !silentWarned) {
    silentWarned = true;
    setNotice('No me llega sonido del micrófono. Revisá que no esté silenciado, o elegí otro en Ajustes → Micrófono.');
  }
  events.forEach(handleEvent);
  if (cloud) cloudFeed(a);
  updateLive();
}

function handleEvent(ev) {
  if (ev.type === 'segment') onSegment(ev.audio, ev.durationMs);
}

function onSegment(audio) {
  if (cloud) { // con la nube conectada no se transcribe en el equipo; solo se saca la huella para dar de alta a alguien
    if ((enroll.stage === 'listen' || enroll.stage === 'confirm') && !enroll.embSent) {
      enroll.embSent = true;
      sendJob(audio, { kind: 'enrollEmb' });
    }
    return;
  }
  if (enroll.stage === 'listen') {
    enroll.stage = 'busy';
    $('enMsg').textContent = 'Procesando tu voz…';
    sendJob(audio, { kind: 'enroll' });
    return;
  }
  const l = { id: uid(), t: Date.now(), spk: undefined, text: '', pending: true };
  lines.push(l); renderLine(l);
  sendJob(audio, { kind: 'line', lineId: l.id });
}

/* ───────────── Alta / refuerzo de interlocutor ───────────── */
const enroll = { stage: 'idle', refId: null, emb: null, embSent: false, buf: '', dg: null, dgCount: {}, timer: null };

async function openEnroll(refId = null) {
  if (!refId && speakers.length >= MAX_SPEAKERS) return;
  if (!micOn) { micWanted = true; if (!(await startMic())) return; }
  Object.assign(enroll, { stage: 'listen', refId, emb: null, embSent: false, buf: '', dg: null, dgCount: {} });
  clearTimeout(enroll.timer);
  const sp = refId ? speakerById(refId) : null;
  $('enTitle').textContent = sp ? `Reforzar la voz de ${sp.name}` : 'Nuevo interlocutor';
  $('enMsg').textContent = sp ? `${sp.name}: hablá unos 5 segundos (contá algo, lo que sea)` : 'Decí tu nombre en voz alta';
  $('enForm').hidden = $('enSave').hidden = $('enRetry').hidden = true;
  $('enroll').hidden = false;
}

function onEnrollResult(m) {
  if (enroll.stage !== 'busy') return;
  if (!m.embedding) {
    enroll.stage = 'listen';
    $('enMsg').textContent = spkReady ? 'Fue muy corto. Probá de nuevo, un poco más largo.' : 'El reconocimiento de voces no está listo todavía. Esperá un momento y probá de nuevo.';
    return;
  }
  enroll.emb = m.embedding; enroll.stage = 'confirm';
  const sp = enroll.refId ? speakerById(enroll.refId) : null;
  if (sp) {
    const e = Float32Array.from(m.embedding);
    updateCentroid(sp, e); updateCentroid(sp, e); saveSpeakers();
    $('enMsg').textContent = `Listo, mejoré la voz de ${sp.name}.`;
    $('enRetry').hidden = true; $('enSave').hidden = true; $('enCancel').textContent = 'Cerrar';
    return;
  }
  const guess = extractName(cleanTranscript(m.text || ''));
  const cs = cands();
  const dup = cs.length ? matchSpeaker(Float32Array.from(m.embedding), cs, { threshold: S.th }) : { index: -1 };
  $('enMsg').textContent = (guess ? `Entendí: “${guess}”` : 'No entendí el nombre. Escribilo abajo.')
    + (dup.index >= 0 ? `  ⚠ Esta voz se parece a la de ${cs[dup.index].name}.` : '');
  $('enName').value = guess;
  $('enForm').hidden = $('enSave').hidden = $('enRetry').hidden = false;
  $('enCancel').textContent = 'Cancelar';
}

$('enRetry').onclick = () => {
  Object.assign(enroll, { stage: 'listen', emb: null, embSent: false, buf: '', dg: null, dgCount: {} }); clearTimeout(enroll.timer);
  $('enMsg').textContent = 'Decí tu nombre en voz alta';
  $('enForm').hidden = $('enSave').hidden = $('enRetry').hidden = true;
};
$('enSave').onclick = () => {
  let name = capitalizeName($('enName').value.trim());
  if (!name || (!enroll.emb && !cloud)) return;
  if (speakers.some((s) => s.name === name)) name += ' 2';
  const sp = { id: uid(), name, color: freeColor(), centroid: enroll.emb ? Array.from(enroll.emb) : null, n: 1 };
  speakers.push(sp);
  if (cloud && enroll.dg != null) { dgMap.set(enroll.dg, sp.id); relabelSession(enroll.dg); }
  saveSpeakers(); renderChips(); closeEnroll();
};
$('enCancel').onclick = closeEnroll;
function closeEnroll() { clearTimeout(enroll.timer); enroll.stage = 'idle'; $('enroll').hidden = true; $('enCancel').textContent = 'Cancelar'; }
$('btnAdd').onclick = () => openEnroll(null);

/* ───────────── Guardar / borrar ───────────── */
$('btnSave').onclick = () => {
  const txt = lines.filter((l) => !l.pending && l.text).map((l) => {
    const { who } = lineLabel(l);
    return `[${formatTime(new Date(l.t))}] ${who ? who + ': ' : ''}${l.text}`;
  }).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain;charset=utf-8' }));
  a.download = `conversacion-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('btnClear').onclick = () => {
  if (!confirm('¿Borrar toda la conversación de la pantalla?')) return;
  lines = []; lineEls.forEach((el) => el.remove()); lineEls.clear(); saveLog();
};
$('btnForget').onclick = () => {
  if (!confirm('¿Borrar todas las voces guardadas?')) return;
  speakers = []; dgMap.clear(); saveSpeakers(); renderChips();
  lines.forEach((l) => { if (l.spk && l.spk !== '?') l.spk = null; }); rerenderAll(); saveLog();
};

/* ───────────── Conexión y estado "listo sin internet" ───────────── */
function updNet() {
  const on = navigator.onLine;
  $('net').textContent = on ? 'En línea' : 'Sin conexión';
  $('net').className = 'pill ' + (on ? 'ok' : 'off');
}
addEventListener('online', () => { updNet(); if (!asrReady) startWorker(); cloudFail = 0; connectCloud(); checkReady(); });
addEventListener('offline', () => { updNet(); if (cloud) onCloudClosed('sin internet'); checkReady(); });

async function cacheHas(cacheName, test, min = 1) {
  try {
    const c = await caches.open(cacheName);
    return (await c.keys()).filter((r) => test(r.url)).length >= min;
  } catch { return false; }
}
async function checkReady() {
  const base = new URL('./', location.href);
  const inSw = async (p) => { try { return !!(await caches.match(new URL(p, base).href)); } catch { return false; } };
  const m = MODELS[S.model];
  const checks = [
    ['La aplicación', await inSw('app.js') && await inSw('index.html') && await inSw('lib/transformers.min.js')],
    ['El motor de voz', (await inSw('lib/ort-wasm-simd-threaded.asyncify.wasm')) || (await inSw('lib/ort-wasm-simd-threaded.wasm'))],
    [`Transcripción (${m.id.split('/')[1]})`, await cacheHas('transformers-cache', (u) => u.includes(m.id) && u.endsWith('.onnx'), 2)],
    ['Reconocimiento de voces', await cacheHas('transformers-cache', (u) => u.includes(SPK_MODEL) && u.endsWith('.onnx'))],
  ];
  $('checks').innerHTML = checks.map(([n, ok]) => `<li>${ok ? '✅' : '⬜'} ${n}</li>`).join('');
  const all = checks.every(([, ok]) => ok);
  const p = $('offlineReady');
  p.textContent = all ? '✔ Listo sin internet' : 'Falta descargar (con internet, una vez)';
  p.className = 'pill ' + (all ? 'ok' : 'warn');
  $('modelHint').textContent = all ? '' : 'Cambiar de calidad por primera vez necesita internet para bajar ese modelo.';
  return all;
}

$('model').onchange = async (e) => {
  const prev = S.model; S.model = e.target.value;
  const m = MODELS[S.model];
  const cached = await cacheHas('transformers-cache', (u) => u.includes(m.id) && u.endsWith('.onnx'), 2);
  if (!cached && !navigator.onLine) {
    S.model = prev; e.target.value = prev;
    setNotice('Para usar esa calidad hace falta internet la primera vez (se baja una sola vez).');
    return;
  }
  saveSettings(); startWorker();
};

/* ───────────── Nube (Deepgram) con respaldo local ───────────── */
let cloud = null, connecting = false, cloudSess = 0, cloudFail = 0, reconnectTimer = null;
let dgMap = new Map(), live = null, liveTimer = null, ring = [], cloudUntil = 0;
const cloudWanted = () => !!(S.cloud && S.cloudKey && navigator.onLine);

function setModePill(state) {
  const el = $('mode');
  if (!S.cloudKey || !S.cloud) { el.textContent = '📴 Local'; el.className = 'pill'; return; }
  if (state === 'cloud') { el.textContent = '☁ En la nube'; el.className = 'pill ok'; }
  else if (state === 'connecting') { el.textContent = '☁ Conectando…'; el.className = 'pill warn'; }
  else { el.textContent = '📴 Local (sin nube)'; el.className = 'pill warn'; }
}

function spkForDg(dg) {
  if (!speakers.length) return null;
  if (dg == null) return '?';
  const id = dgMap.get(dg);
  return id && speakerById(id) ? id : '?';
}
function relabelSession(dg) {
  lines.forEach((x) => { if (x.cloud && x.sess === cloudSess && x.dg === dg) { x.spk = spkForDg(dg); renderLine(x); } });
  saveLog();
}

function newLive(dg) {
  const l = { id: uid(), t: Date.now(), text: '', interim: '', dg, sess: cloudSess, cloud: true, spk: spkForDg(dg) };
  lines.push(l);
  return l;
}
function closeLive() {
  clearTimeout(liveTimer);
  if (!live) return;
  if (live.interim) { live.text = (live.text + ' ' + live.interim).trim(); live.interim = ''; }
  if (live.text) renderLine(live); else removeLine(live.id);
  saveLog(); live = null;
}
const armLive = () => { clearTimeout(liveTimer); liveTimer = setTimeout(closeLive, 3500); };

function onCloudInterim(r) {
  if (enroll.stage !== 'idle' || !r.text) return;
  const dg = r.lastDg;
  if (live && dg != null && live.dg != null && dg !== live.dg && live.text) closeLive();
  if (!live) live = newLive(dg);
  live.interim = r.text; live.spk = spkForDg(live.dg ?? dg);
  renderLine(live); armLive();
}

function onCloudFinal(r) {
  if (enroll.stage === 'listen') { onEnrollCloud(r); return; }
  if (enroll.stage !== 'idle') return; // mientras se confirma un alta no se escribe en pantalla
  if (!r.text) { if (r.speechFinal) closeLive(); return; }
  const runs = r.runs.length ? r.runs : [{ dg: null, text: r.text }];
  for (const run of runs) {
    if (live && live.dg !== run.dg) closeLive();
    if (!live) live = newLive(run.dg);
    live.text = (live.text + ' ' + applyCustomWords(run.text, words())).trim();
    live.interim = ''; live.spk = spkForDg(live.dg);
    renderLine(live);
  }
  saveLog();
  if (r.speechFinal) closeLive(); else armLive();
}

/* alta de interlocutor mientras la nube está conectada: el nombre sale del texto y la voz de la nube se asocia a esa persona */
function onEnrollCloud(r) {
  if (r.text) enroll.buf = (enroll.buf + ' ' + r.text).trim();
  for (const w of r.words || []) if (Number.isInteger(w.speaker)) enroll.dgCount[w.speaker] = (enroll.dgCount[w.speaker] || 0) + 1;
  clearTimeout(enroll.timer);
  if (!enroll.buf) return;
  if (r.speechFinal) finishEnrollCloud(); else enroll.timer = setTimeout(finishEnrollCloud, 1800);
}
function finishEnrollCloud() {
  if (enroll.stage !== 'listen') return;
  const best = Object.entries(enroll.dgCount).sort((a, b) => b[1] - a[1])[0];
  enroll.dg = best ? +best[0] : null;
  enroll.stage = 'confirm';
  const sp = enroll.refId ? speakerById(enroll.refId) : null;
  if (sp) {
    if (enroll.dg != null) { dgMap.set(enroll.dg, sp.id); relabelSession(enroll.dg); }
    $('enMsg').textContent = `Listo, ya reconozco a ${sp.name} en esta conversación.`;
    $('enRetry').hidden = true; $('enSave').hidden = true; $('enCancel').textContent = 'Cerrar';
    return;
  }
  const guess = extractName(cleanTranscript(enroll.buf));
  $('enMsg').textContent = guess ? `Entendí: “${guess}”` : 'No entendí el nombre. Escribilo abajo.';
  $('enName').value = guess;
  $('enForm').hidden = $('enSave').hidden = $('enRetry').hidden = false;
  $('enCancel').textContent = 'Cancelar';
}

/* audio hacia la nube: solo mientras hay voz (más 1,6 s de cola) para gastar menos crédito */
setInterval(() => {
  if (!micOn) return;
  const st = cloud?.stats, db = Math.round(20 * Math.log10(Math.max(seg?.lastRms || 0, 1e-5)));
  addLog(`${new Date().toLocaleTimeString('es-AR')} mic ${db} dB (amplif. ×${curGain.toFixed(1)})${seg?.speaking ? ' (voz)' : ''}, ` + (cloud ? `nube: enviados ${st.sent} bloques, recibidos ${st.msgs} (${st.results} resultados, ${st.texts} con texto)${st.last ? ', último: ' + st.last : ''}` : 'sin nube'));
}, 10000);

function cloudFeed(a) {
  const now = Date.now();
  if (seg.speaking) cloudUntil = now + 1600;
  if (now < cloudUntil) {
    if (ring.length) { ring.forEach((c) => cloud?.send(c)); ring = []; }
    cloud?.send(a);
  } else {
    ring.push(a.slice());
    if (ring.length > 6) ring.shift(); // ~600 ms previos al inicio de la frase
  }
}

async function connectCloud() {
  if (connecting || cloud || !micOn || !cloudWanted()) { setModePill(cloud ? 'cloud' : 'local'); return; }
  connecting = true; setModePill('connecting');
  let c = null;
  for (const diarize of [true, false]) {
    const cand = new CloudASR({
      key: S.cloudKey, keyterms: words(), diarize,
      onInterim: onCloudInterim, onFinal: onCloudFinal, onUtteranceEnd: closeLive,
      onError: (m) => addLog('Nube: ' + m),
      onClose: (code) => { if (cloud === cand) onCloudClosed('código ' + code); },
    });
    try { await cand.connect(); c = cand; addLog(`Nube conectada (${diarize ? 'con' : 'sin'} reconocimiento de hablantes).`); break; }
    catch (e) { addLog(`Nube (${diarize ? 'con' : 'sin'} hablantes): ${e.message}`); }
  }
  connecting = false;
  if (!c || !micOn) { c?.close(); cloudFail++; setModePill('local'); if (cloudFail === 1) setNotice('No pude conectar con la nube (¿la clave es correcta?). Sigo en modo local.'); scheduleReconnect(); return; }
  cloud = c; cloudSess++; dgMap = new Map(); live = null; ring = []; cloudFail = 0;
  setModePill('cloud'); setNotice('');
  speakers.length && addLog('Nube: las voces de cada persona se vuelven a asociar al hablar o tocando una frase.');
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!cloudWanted() || !micOn || cloudFail > 6) return;
  reconnectTimer = setTimeout(connectCloud, Math.min(60000, 8000 * Math.max(1, cloudFail)));
}

function onCloudClosed(why) {
  addLog('Nube desconectada: ' + why + '. Sigo en modo local.');
  closeLive();
  try { cloud?.close(); } catch {}
  cloud = null; ring = [];
  setModePill('local'); scheduleReconnect();
}

function disconnectCloud() {
  clearTimeout(reconnectTimer);
  const c = cloud; cloud = null;
  if (c) { c.finalize(); setTimeout(() => { c.close(); closeLive(); }, 900); } // deja salir lo último que se dijo
  setModePill('local');
}

function reconnectCloud() {
  const c = cloud; cloud = null; clearTimeout(reconnectTimer);
  if (c) c.close();
  closeLive(); setModePill('local');
  connectCloud();
}

/* ───────────── Instalar la app ───────────── */
let installEvt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
function showInstall(text, withButton) {
  if (standalone()) return;
  $('installText').textContent = text;
  $('btnInstall').hidden = !withButton;
  $('install').hidden = false;
}
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); installEvt = e;
  showInstall('Instalá la app para abrirla con un toque, aunque no haya internet.', true);
});
addEventListener('appinstalled', () => { $('install').hidden = true; installEvt = null; });
$('btnInstall').onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  try { await installEvt.userChoice; } catch {}
  installEvt = null; $('install').hidden = true;
};
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone()) {
  showInstall('Para instalarla en el iPhone/iPad: tocá el botón Compartir (el cuadradito con la flecha) y elegí “Agregar a inicio”.', false);
}

/* ───────────── Arranque ───────────── */
async function init() {
  renderChips(); updNet(); setModePill('local');
  try { await navigator.storage?.persist?.(); } catch {}
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { setNotice('No pude activar el modo sin internet en este navegador.'); }
  }
  startWorker();
  checkReady();
  startMic(); // escucha desde que se abre
}
init();
