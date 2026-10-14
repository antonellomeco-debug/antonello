// Finto sherpa-onnx-node per le prove dei messaggi vocali (VOICE_ENGINE): niente modello da 564 MB.
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

module.exports = { OfflineRecognizer };
