// AudioWorklet: junta bloques de 128 muestras y los manda al hilo principal cada ~100 ms.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(Math.round(sampleRate / 10));
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this.buf.length - this.n);
      this.buf.set(ch.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.buf.length) {
        const out = this.buf;
        this.port.postMessage(out, [out.buffer]);
        this.buf = new Float32Array(Math.round(sampleRate / 10));
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
