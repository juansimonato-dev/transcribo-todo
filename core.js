// Lógica pura (sin DOM, sin modelos). Se usa desde la app y desde los tests de Node.

export const MAX_SPEAKERS = 5;
export const SAMPLE_RATE = 16000;

/* ───────────── Detección de voz (VAD) y corte en frases ───────────── */

export class Segmenter {
  constructor(o = {}) {
    this.sr = o.sampleRate || SAMPLE_RATE;
    this.frameLen = Math.round(this.sr * 0.02); // 20 ms
    this.startFrames = o.startFrames ?? 4; // 80 ms de voz seguida para arrancar
    this.endFrames = Math.round((o.endMs ?? 550) / 20); // silencio que cierra la frase
    this.minVoiced = Math.round((o.minSpeechMs ?? 350) / 20);
    this.preRoll = Math.round((o.preRollMs ?? 300) / 20);
    this.maxFrames = Math.round((o.maxMs ?? 20000) / 20);
    this.minRms = o.minRms ?? 0.004; // umbral bajo: hay micrófonos de notebook muy bajitos
    this.ratio = o.ratio ?? 3;
    this.noise = 0.002;
    this.calib = o.calibFrames ?? 25; // primeros 0.5 s: medir el ruido de fondo
    this.calibMin = Infinity;
    this.carry = new Float32Array(0);
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.pre = [];
    this.run = 0;
    this.seg = [];
    this.silence = 0;
    this.voiced = 0;
    this.lastRms = 0;
  }

  get speaking() {
    return this.state === 'speech';
  }

  /** Recibe audio mono Float32 a this.sr. Devuelve eventos: start | segment | discard */
  push(chunk) {
    const events = [];
    let buf = chunk;
    if (this.carry.length) {
      buf = new Float32Array(this.carry.length + chunk.length);
      buf.set(this.carry, 0);
      buf.set(chunk, this.carry.length);
    }
    let i = 0;
    for (; i + this.frameLen <= buf.length; i += this.frameLen) {
      this._frame(buf.slice(i, i + this.frameLen), events);
    }
    this.carry = buf.slice(i);
    return events;
  }

  flush() {
    const events = [];
    if (this.state === 'speech') this._finish(events);
    this.carry = new Float32Array(0);
    return events;
  }

  _frame(f, events) {
    let s = 0;
    for (let i = 0; i < f.length; i++) s += f[i] * f[i];
    const rms = Math.sqrt(s / f.length);
    this.lastRms = rms;
    if (this.calib > 0) {
      // calibración: me quedo con el cuadro más silencioso para estimar el ruido de fondo
      this.calib--;
      this.calibMin = Math.min(this.calibMin, rms);
      if (this.calib === 0) this.noise = Math.min(0.02, Math.max(0.0005, this.calibMin * 1.5));
      return;
    }
    const thr = Math.max(this.minRms, this.noise * this.ratio);
    const speech = rms > thr;

    if (this.state === 'idle') {
      // el piso de ruido baja rápido y sube lento
      const rate = speech ? 0.002 : 0.02;
      this.noise = Math.max(0.0005, (1 - rate) * this.noise + rate * rms);
      this.pre.push(f);
      if (this.pre.length > this.preRoll + this.startFrames) this.pre.shift();
      this.run = speech ? this.run + 1 : 0;
      if (this.run >= this.startFrames) {
        this.state = 'speech';
        this.seg = this.pre;
        this.pre = [];
        this.voiced = this.run;
        this.silence = 0;
        events.push({ type: 'start' });
      }
    } else {
      this.seg.push(f);
      if (speech) {
        this.voiced++;
        this.silence = 0;
      } else this.silence++;
      if (this.silence >= this.endFrames || this.seg.length >= this.maxFrames) this._finish(events);
    }
  }

  _finish(events) {
    const trim = Math.max(0, this.silence - 10); // dejo 200 ms de cola
    const frames = trim ? this.seg.slice(0, this.seg.length - trim) : this.seg;
    if (this.voiced >= this.minVoiced) {
      const audio = new Float32Array(frames.length * this.frameLen);
      frames.forEach((fr, k) => audio.set(fr, k * this.frameLen));
      events.push({ type: 'segment', audio, durationMs: frames.length * 20, voicedMs: this.voiced * 20 });
    } else {
      events.push({ type: 'discard' });
    }
    this.state = 'idle';
    this.seg = [];
    this.pre = [];
    this.run = 0;
    this.silence = 0;
    this.voiced = 0;
  }
}

/** Remuestreo lineal simple (solo se usa si el navegador no entrega 16 kHz). */
export function resampleLinear(x, from, to) {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from);
  const y = new Float32Array(n);
  const k = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * k;
    const j = Math.floor(p);
    const t = p - j;
    y[i] = x[j] * (1 - t) + (x[Math.min(j + 1, x.length - 1)] || 0) * t;
  }
  return y;
}

/* ───────────── Nombres ───────────── */

const GREET = /^(hola|buenas( tardes| noches| días| dias)?|buen d[ií]a|che|ey|hey|bueno|este|eh|ah)\b[\s,.!¡]*/i;
const INTRO = /^(yo\s+)?(me\s+llamo|mi\s+nombre\s+es|el\s+nombre\s+es|me\s+dicen|soy|mi\s+nombre)\s+/i;
const STOP = new Set(['y', 'e', 'que', 'soy', 'es', 'acá', 'aca', 'aquí', 'aqui', 'tengo', 'de', 'del', 'para', 'con', 'como', 'cómo']);

export function capitalizeName(s) {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toLocaleUpperCase('es-AR') + w.slice(1).toLocaleLowerCase('es-AR'))
    .join(' ');
}

/** "Hola, me llamo Juan Pablo." -> "Juan Pablo" */
export function extractName(text) {
  let t = (text || '').replace(/[“”"()\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const n = t.replace(GREET, '');
    if (n === t) break;
    t = n.trim();
  }
  t = t.replace(INTRO, '').trim();
  const clause = t.split(/[,.;:!?¡¿]/).map((x) => x.trim()).find(Boolean) || '';
  const out = [];
  for (const w of clause.split(' ')) {
    if (!w) continue;
    if (STOP.has(w.toLowerCase())) break;
    out.push(w);
    if (out.length === 2) break;
  }
  return capitalizeName(out.join(' ')).slice(0, 24);
}

/* ───────────── Voces: comparación de embeddings ───────────── */

export function normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
  return o;
}

export function cosine(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * speakers: [{centroid:number[]|Float32Array, ...}]
 * Devuelve {index, score, second, confident}. index=-1 si ninguno supera el umbral.
 */
export function matchSpeaker(emb, speakers, { threshold = 0.85, margin = 0.02 } = {}) {
  let best = -1,
    bestS = -2,
    second = -2;
  speakers.forEach((sp, i) => {
    const s = cosine(emb, sp.centroid);
    if (s > bestS) {
      second = bestS;
      bestS = s;
      best = i;
    } else if (s > second) second = s;
  });
  if (best < 0 || bestS < threshold) return { index: -1, score: bestS, second, confident: false };
  const gap = speakers.length > 1 ? bestS - second : 1;
  return { index: best, score: bestS, second, confident: bestS >= threshold + 0.03 && gap >= margin + 0.01, close: gap < margin };
}

/** Promedia la nueva muestra con la huella de la persona (hasta 30 muestras de peso). */
export function updateCentroid(sp, emb, cap = 30) {
  const w = Math.min(sp.n || 1, cap);
  const c = new Float32Array(emb.length);
  for (let i = 0; i < emb.length; i++) c[i] = sp.centroid[i] * w + emb[i];
  sp.centroid = Array.from(normalize(c));
  sp.n = (sp.n || 1) + 1;
}

/* ───────────── Texto: limpieza y diccionario propio ───────────── */

const strip = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const HALLUCINATIONS = [
  /amara\.org/,
  /subtitulos? (realizados?|por|de|en)/,
  /subtitulado (por|en)/,
  /gracias por (ver|vernos|mirar|su atencion|escuchar)/,
  /suscri(be|ba|banse|bete|bite)/,
  /dale (like|me gusta)/,
  /(nos vemos|hasta) (en el proximo|la proxima)/,
  /^(\W|_)*$/,
];

function lev(a, b) {
  const m = a.length,
    n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Reemplaza palabras parecidas por las que cargó la familia (nombres, lugares, términos). */
export function applyCustomWords(text, words) {
  const list = (words || []).map((w) => w.trim()).filter(Boolean);
  if (!list.length) return text;
  const targets = list.map((w) => ({ w, n: strip(w) }));
  return text.replace(/[\p{L}\p{N}]+/gu, (tok) => {
    const n = strip(tok);
    let best = null,
      bd = 99;
    for (const t of targets) {
      if (t.n === n) return t.w;
      if (n.length < 5 || t.n.length < 5 || n[0] !== t.n[0]) continue;
      const maxd = n.length >= 8 ? 2 : 1;
      const d = lev(n, t.n);
      if (d <= maxd && d < bd) {
        best = t;
        bd = d;
      }
    }
    return best ? best.w : tok;
  });
}

/** Colapsa "no no no no no" (4 o más repeticiones seguidas de 1 a 4 palabras) en una sola. */
function collapseRepeats(text) {
  const w = text.split(' ');
  for (let n = 1; n <= 4; n++) {
    for (let i = 0; i + n <= w.length; i++) {
      const key = w.slice(i, i + n).map(strip).join(' ');
      let reps = 1;
      while (i + (reps + 1) * n <= w.length && w.slice(i + reps * n, i + (reps + 1) * n).map(strip).join(' ') === key) reps++;
      if (reps >= 4) w.splice(i + n, (reps - 1) * n);
    }
  }
  return w.join(' ');
}

/** Quita alucinaciones típicas de Whisper (silencio -> "Subtítulos por Amara.org", repeticiones, [Música]). */
export function cleanTranscript(text) {
  let t = (text || '').replace(/\[[^\]]*\]|\([^)]*\)|♪+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // repeticiones: "no no no no no no" / "gracias gracias gracias gracias gracias"
  t = collapseRepeats(t);
  const n = strip(t);
  if (HALLUCINATIONS.some((r) => r.test(n))) return '';
  return t;
}

/* ───────────── Varios ───────────── */

export function formatTime(d) {
  return d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}
