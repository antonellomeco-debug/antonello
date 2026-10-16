// Finto sherpa-onnx-node per le prove dei messaggi vocali (VOICE_ENGINE) e della voce dei video (TTS_ENGINE).
// "Trascrive" dicendo quanti secondi di audio ha ricevuto; con 3,0 s esatti restituisce una frase che Whisper
// inventa sul silenzio, per provare il filtro. FAKE_SHERPA_FAIL=load fa fallire il caricamento del modello;
// FAKE_SHERPA_DELAY_MS rende lenta la trascrizione.
const fs = require("node:fs");

class OfflineRecognizer {
  constructor(config) {
    if (process.env.FAKE_SHERPA_FAIL === "load") throw new Error("modello rovinato");
    for (const f of [config.modelConfig.whisper.encoder, config.modelConfig.whisper.decoder, config.modelConfig.tokens]) {
      if (!fs.existsSync(f)) throw new Error(`manca ${f}`);
    }
    this.config = config;
  }
  createStream() {
    const s = { samples: null, acceptWaveform: (w) => (s.samples = w.samples) };
    return s;
  }
  decode(stream) {
    const ms = Number(process.env.FAKE_SHERPA_DELAY_MS) || 0;
    if (ms) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    stream.done = true;
  }
  getResult(stream) {
    const sec = stream.samples.length / 16000;
    if (Math.abs(sec - 3) < 0.01) return { text: " Sottotitoli creati dalla comunità Amara.org " };
    return { text: ` pezzo di ${sec.toFixed(1)} secondi ` };
  }
}

// Finta voce narrante (TTS_ENGINE): un tono che dura 0,06 s per lettera; "ERRORE" nel testo fa fallire la lettura.
class OfflineTts {
  constructor(config) {
    if (!fs.existsSync(config.model.vits.model)) throw new Error(`manca ${config.model.vits.model}`);
    this.sampleRate = 22050;
  }
  generate({ text, speed = 1 }) {
    if (/ERRORE/.test(text)) throw new Error("voce rotta");
    const n = Math.round((22050 * 0.06 * text.length) / speed);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 22050);
    return { samples, sampleRate: 22050 };
  }
}

module.exports = { OfflineRecognizer, OfflineTts };
