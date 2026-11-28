// Transcripción por frases con Whisper alojado en Groq (API compatible con OpenAI).
export const GROQ_URL = 'https://api.groq.com/openai/v1';
export const GROQ_MODELS = {
  'whisper-large-v3-turbo': 'Rápido (recomendado)',
  'whisper-large-v3': 'Más preciso (algo más lento)',
};

export class GroqError extends Error {
  constructor(message, status = 0, retryAfter = 0) { super(message); this.status = status; this.retryAfter = retryAfter; }
}

/** Float32 mono → WAV PCM16 */
export function wavBlob(f32, sampleRate = 16000) {
  const n = f32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Decide si lo que devolvió Whisper es ruido/silencio inventado. */
export function looksLikeNoSpeech(j) {
  const segs = j?.segments;
  if (!Array.isArray(segs) || !segs.length) return false;
  return segs.every((s) => (s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -0.7);
}

export async function transcribeGroq({ key, audio, model = 'whisper-large-v3-turbo', words = [], timeoutMs = 15000, fetchImpl }) {
  const f = fetchImpl || fetch;
  const fd = new FormData();
  fd.append('file', wavBlob(audio), 'frase.wav');
  fd.append('model', model);
  fd.append('language', 'es');
  fd.append('temperature', '0');
  fd.append('response_format', 'verbose_json');
  if (words.length) fd.append('prompt', ('Vocabulario: ' + words.join(', ')).slice(0, 600));
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  let r;
  try {
    r = await f(GROQ_URL + '/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd, signal: ctl.signal });
  } catch (e) {
    throw new GroqError(e?.name === 'AbortError' ? 'tardó demasiado' : 'sin conexión con Groq');
  } finally { clearTimeout(to); }
  if (!r.ok) {
    let msg = ''; try { msg = (await r.json())?.error?.message || ''; } catch {}
    throw new GroqError(msg || 'error ' + r.status, r.status, +(r.headers?.get?.('retry-after') || 0));
  }
  const j = await r.json();
  return { text: looksLikeNoSpeech(j) ? '' : String(j.text || '').trim() };
}

/** Verifica la clave (y que el navegador pueda hablar con Groq). */
export async function testGroqKey(key, fetchImpl) {
  const f = fetchImpl || fetch;
  let r;
  try { r = await f(GROQ_URL + '/models', { headers: { Authorization: 'Bearer ' + key } }); }
  catch { throw new GroqError('sin conexión con Groq'); }
  if (!r.ok) throw new GroqError(r.status === 401 ? 'la clave no es válida' : 'error ' + r.status, r.status);
}
