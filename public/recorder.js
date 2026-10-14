// Registrazione dei messaggi vocali per Orion. Si prende l'audio grezzo del microfono (AudioWorklet, vedi
// pcm-worklet.js) e alla fine si prepara un WAV a 16 kHz, un canale: è ciò che serve al server per trascrivere e
// funziona allo stesso modo su iPhone (anche come app sulla schermata Home), Safari e Chrome.

export const MAX_SECONDS = 120;
const TARGET_RATE = 16000;

export const recordingSupported = () =>
  Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioContext && window.AudioWorkletNode);

/** Messaggio chiaro per gli errori del microfono. */
export function micErrorText(err) {
  const name = err?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Il microfono non è consentito. Sull'iPhone: Impostazioni → App → Safari → Microfono → «Consenti» (o «Chiedi»), poi chiudi e riapri l'app. Sul computer: consenti il microfono dall'icona accanto all'indirizzo.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Non trovo un microfono su questo dispositivo.";
  if (name === "NotReadableError" || name === "AbortError") return "Il microfono è occupato da un'altra app (per esempio una chiamata): chiudila e riprova.";
  return `Non riesco a usare il microfono (${err?.message || name || "errore sconosciuto"}).`;
}

export class VoiceRecorder {
  /** onTick(secondi), onLimit() al limite di durata, onInterrupted(motivo) se la registrazione si interrompe. */
  constructor({ onTick, onLimit, onInterrupted } = {}) {
    Object.assign(this, { onTick, onLimit, onInterrupted });
    this.chunks = [];
    this.length = 0;
    this.closed = false;
  }

  get seconds() {
    return this.ctx ? this.length / this.ctx.sampleRate : 0;
  }

  /**
   * Va chiamato direttamente dal tocco sul pulsante: l'audio sull'iPhone parte solo dentro un tocco, quindi il
   * contesto audio si crea subito, prima di qualsiasi attesa.
   */
  async start() {
    const ctx = (this.ctx = new AudioContext());
    const resumed = ctx.resume().catch(() => {});
    let streamP = null;
    try {
      streamP = navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamP.catch(() => {}); // l'errore si gestisce sotto: niente avvisi in console nel frattempo
      await ctx.audioWorklet.addModule("/pcm-worklet.js");
      const stream = (this.stream = await streamP);
      await resumed;
      if (this.closed) {
        // annullato mentre si chiedeva il permesso: si spegne subito il microfono appena ottenuto
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      this.source = ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(ctx, "pcm-tap", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      this.node.port.onmessage = (e) => {
        if (e.data === "flushed") return this.flushed?.();
        if (this.closed) return;
        this.chunks.push(e.data);
        this.length += e.data.length;
        if (this.seconds >= MAX_SECONDS) this.onLimit?.();
      };
      this.source.connect(this.node);
      this.node.connect(ctx.destination); // in uscita solo silenzio: serve perché il browser faccia girare il nodo
      const track = this.stream.getAudioTracks()[0];
      if (track) track.onended = () => this.interrupt("Il microfono si è spento.");
      this.onHidden = () => document.hidden && this.interrupt("Registrazione annullata: l'app è passata in secondo piano.");
      document.addEventListener("visibilitychange", this.onHidden);
      const t0 = performance.now();
      this.timer = setInterval(() => this.onTick?.((performance.now() - t0) / 1000), 250);
      return true;
    } catch (err) {
      const cancelled = this.closed;
      this.cleanup();
      // il permesso può arrivare anche dopo l'errore: il microfono non deve restare acceso
      streamP?.then((st) => st.getTracks().forEach((t) => t.stop()), () => {});
      if (cancelled) return false; // annullato: l'errore non interessa
      throw err;
    }
  }

  interrupt(reason) {
    if (this.closed) return;
    this.cleanup();
    this.onInterrupted?.(reason);
  }

  /** Annulla senza mandare niente. */
  cancel() {
    this.cleanup();
  }

  /** Ferma e restituisce il WAV (Blob audio/wav), oppure null se non c'era audio. */
  async stop() {
    if (this.closed) return null;
    if (this.node) {
      await new Promise((resolve) => {
        this.flushed = resolve;
        this.node.port.postMessage("flush");
        setTimeout(resolve, 600); // se il browser non risponde si usa ciò che è già arrivato
      });
    }
    const rate = this.ctx?.sampleRate ?? TARGET_RATE;
    const chunks = this.chunks;
    this.cleanup();
    if (!chunks.length) return null;
    const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    return wavBlob(resample(all, rate, TARGET_RATE), TARGET_RATE);
  }

  cleanup() {
    if (this.closed && !this.ctx) return;
    this.closed = true;
    clearInterval(this.timer);
    if (this.onHidden) document.removeEventListener("visibilitychange", this.onHidden);
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.node?.port.close();
    } catch {
      // già scollegati
    }
    this.stream?.getTracks().forEach((t) => t.stop()); // spegne il pallino arancione dell'iPhone
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.chunks = [];
  }
}

/** Ricampiona con la media dei campioni vicini (basta per la voce). */
function resample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const start = i * ratio;
    const s = Math.floor(start);
    const e = Math.min(input.length, Math.max(s + 1, Math.ceil(start + ratio)));
    let sum = 0;
    for (let j = s; j < e; j++) sum += input[j];
    out[i] = sum / (e - s);
  }
  return out;
}

function wavBlob(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off, s) => [...s].forEach((ch, i) => v.setUint8(off + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // un canale
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}
