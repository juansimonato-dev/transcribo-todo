// Transcripción en la nube (Deepgram, streaming por WebSocket). Sin DOM: se prueba en Node.
// Docs: https://developers.deepgram.com/reference/speech-to-text/listen-streaming

export const DG_HOST = 'wss://api.deepgram.com/v1/listen';

/** Float32 [-1,1] -> PCM 16 bits little-endian */
export function pcm16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i] > 1 ? 1 : f32[i] < -1 ? -1 : f32[i];
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out.buffer;
}

export function buildUrl({ language = 'es-419', keyterms = [], diarize = true, endpointing = 400, host = DG_HOST } = {}) {
  const p = new URLSearchParams({
    model: 'nova-3',
    language,
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    endpointing: String(endpointing),
    utterance_end_ms: '1000',
    punctuate: 'true',
    smart_format: 'true',
  });
  if (diarize) p.set('diarize_model', 'latest');
  for (const k of keyterms.slice(0, 100)) {
    const t = String(k).replace(/[,;]/g, ' ').trim();
    if (t) p.append('keyterm', t);
  }
  return `${host}?${p.toString()}`;
}

/** Agrupa palabras consecutivas del mismo hablante: [{dg, text}] */
export function groupRuns(words) {
  const runs = [];
  for (const w of words || []) {
    const dg = Number.isInteger(w.speaker) ? w.speaker : null;
    const t = (w.punctuated_word || w.word || '').trim();
    if (!t) continue;
    const last = runs[runs.length - 1];
    if (last && last.dg === dg) last.text += ' ' + t;
    else runs.push({ dg, text: t });
  }
  return runs;
}

/** Interpreta un mensaje de Deepgram. Devuelve null si no es un resultado de texto. */
export function parseMessage(raw) {
  let m;
  try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'UtteranceEnd') return { kind: 'utteranceEnd' };
  if (m.type === 'Error') return { kind: 'error', message: m.description || m.message || 'error' };
  if (m.type !== 'Results') return null;
  const alt = m.channel?.alternatives?.[0];
  const text = (alt?.transcript || '').trim();
  const words = alt?.words || [];
  const lastDg = words.length && Number.isInteger(words[words.length - 1].speaker) ? words[words.length - 1].speaker : null;
  return {
    kind: m.is_final ? 'final' : 'interim',
    text,
    words,
    runs: groupRuns(words),
    lastDg,
    speechFinal: !!m.speech_final,
  };
}

export class CloudASR {
  /**
   * opts: { key, language, keyterms, diarize, WS, url, onInterim, onFinal, onUtteranceEnd, onClose }
   */
  constructor(o) {
    this.o = o;
    this.ws = null;
    this.open = false;
    this.lastSend = 0;
    this.timer = null;
    this.closedByUs = false;
    this.stats = { sent: 0, bytes: 0, msgs: 0, results: 0, texts: 0, last: '' };
  }

  connect(timeoutMs = 8000) {
    const WS = this.o.WS || WebSocket;
    const url = this.o.url || buildUrl({ language: this.o.language, keyterms: this.o.keyterms, diarize: this.o.diarize !== false });
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (why) => { if (!settled) { settled = true; try { this.ws?.close(); } catch {} reject(new Error(why)); } };
      const to = setTimeout(() => fail('tiempo de espera agotado'), timeoutMs);
      try {
        this.ws = new WS(url, ['token', this.o.key]);
      } catch (e) { clearTimeout(to); return fail(String(e?.message || e)); }
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => {
        if (settled) return;
        settled = true; clearTimeout(to);
        this.open = true; this.lastSend = Date.now();
        this.timer = setInterval(() => {
          if (this.open && Date.now() - this.lastSend > 3000) this._json({ type: 'KeepAlive' });
        }, 3000);
        resolve();
      };
      this.ws.onerror = () => { clearTimeout(to); fail('no se pudo conectar'); };
      this.ws.onclose = (e) => {
        clearTimeout(to);
        const was = this.open;
        this.open = false; clearInterval(this.timer);
        if (!settled) fail(`conexión cerrada (${e?.code || '?'})`);
        else if (was && !this.closedByUs) this.o.onClose?.(e?.code, e?.reason);
      };
      this.ws.onmessage = (ev) => {
        const st = this.stats; st.msgs++;
        try { const j = JSON.parse(ev.data); st.last = j.type || '?'; if (j.type === 'Results') { st.results++; if ((j.channel?.alternatives?.[0]?.transcript || '').trim()) st.texts++; } else if (j.type !== 'Metadata') st.last += ' ' + String(ev.data).slice(0, 120); } catch {}
        const r = parseMessage(ev.data);
        if (!r) return;
        if (r.kind === 'interim') this.o.onInterim?.(r);
        else if (r.kind === 'final') this.o.onFinal?.(r);
        else if (r.kind === 'utteranceEnd') this.o.onUtteranceEnd?.();
        else if (r.kind === 'error') this.o.onError?.(r.message);
      };
    });
  }

  _json(obj) {
    try { if (this.open) { this.ws.send(JSON.stringify(obj)); this.lastSend = Date.now(); } } catch {}
  }

  send(f32) {
    if (!this.open) return;
    try { const b = pcm16(f32); this.ws.send(b); this.stats.sent++; this.stats.bytes += b.byteLength || 0; this.lastSend = Date.now(); } catch (e) { this.stats.last = 'send: ' + e.message; }
  }

  /** Pide cerrar lo pendiente (para que lo último dicho salga ya) */
  finalize() { this._json({ type: 'Finalize' }); }

  close() {
    this.closedByUs = true;
    if (this.open) this._json({ type: 'CloseStream' });
    clearInterval(this.timer);
    this.open = false;
    try { this.ws?.close(); } catch {}
  }
}
