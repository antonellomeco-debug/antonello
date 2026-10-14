// Raccoglie l'audio grezzo del microfono per i messaggi vocali (usato da recorder.js) e lo manda a pacchetti.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data !== "flush") return;
      if (this.n) this.port.postMessage(this.buf.slice(0, this.n));
      this.n = 0;
      this.port.postMessage("flushed");
    };
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice(0));
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
