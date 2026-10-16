// Processo a parte per la voce narrante dei video (avviato da tts.js): carica la voce una volta e legge le frasi
// che riceve, scrivendo un WAV per schermata. TTS_ENGINE sostituisce la libreria nelle prove.
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { trim, joinSentences, writeWav } from "./wav.js";

const require = createRequire(import.meta.url);
const send = (m) => process.send?.(m);
const dir = process.env.TTS_MODEL_DIR;

let tts;
try {
  const sherpa = require(process.env.TTS_ENGINE || "sherpa-onnx-node");
  tts = new sherpa.OfflineTts({
    model: {
      vits: { model: path.join(dir, "it_IT-paola-medium.onnx"), tokens: path.join(dir, "tokens.txt"), dataDir: path.join(dir, "espeak-ng-data") },
      numThreads: Math.max(1, Math.min(4, os.availableParallelism?.() || 2)),
      provider: "cpu",
      debug: 0,
    },
    maxNumSentences: 1,
  });
} catch (err) {
  send({ type: "fatal", error: String(err?.message ?? err).split("\n")[0].slice(0, 300) });
  process.exit(1);
}
send({ type: "ready" });

process.on("message", (m) => {
  if (m?.type !== "speak") return;
  try {
    const items = m.items.map((item) => {
      let rate = 22050;
      const parts = item.sentences.map((text) => {
        const audio = tts.generate({ text, sid: 0, speed: m.speed });
        rate = audio.sampleRate;
        return { text, samples: trim(audio.samples, rate) };
      });
      const { samples, times } = joinSentences(parts, rate, m.gap);
      writeWav(item.out, samples, rate);
      return { seconds: samples.length / rate, sentences: times };
    });
    send({ type: "result", id: m.id, items });
  } catch (err) {
    send({ type: "error", id: m.id, error: String(err?.message ?? err) });
  }
});
process.on("disconnect", () => process.exit(0));
