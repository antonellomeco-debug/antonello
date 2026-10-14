// Processo a parte per i messaggi vocali (avviato da lib/voice.js): carica Whisper una volta e trascrive i pezzi
// di audio che riceve. Così la memoria del modello (circa 1,7 GB mentre lavora) torna libera quando si chiude.
// "--check": prova solo che la libreria nativa funzioni su questo computer, poi esce.
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const send = (m) => process.send?.(m);
/** Manda l'ultimo messaggio ed esce solo quando è partito davvero (altrimenti il programma potrebbe non riceverlo). */
async function finish(m, code) {
  if (!process.send) process.exit(code);
  process.send(m, () => process.exit(code));
  await new Promise(() => {}); // si ferma qui fino all'uscita
}
const firstLines = (err) => String(err?.message ?? err).split("\n").slice(0, 2).join(" ").slice(0, 300);

let sherpa;
try {
  sherpa = require(process.env.VOICE_ENGINE || "sherpa-onnx-node");
} catch (err) {
  const msg = firstLines(err);
  await finish(process.argv.includes("--check") ? { type: "check", ok: false, error: msg } : { type: "fatal", error: msg }, 1);
}

if (process.argv.includes("--check")) {
  await finish({ type: "check", ok: typeof sherpa.OfflineRecognizer === "function" }, 0);
}

const dir = process.env.VOICE_MODEL_DIR;
const threads = Math.max(1, Math.min(4, Number(process.env.VOICE_THREADS) || os.availableParallelism?.() || 2));
let recognizer;
try {
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: path.join(dir, "turbo-encoder.int8.onnx"),
        decoder: path.join(dir, "turbo-decoder.int8.onnx"),
        language: "it",
        task: "transcribe",
        tailPaddings: -1,
      },
      tokens: path.join(dir, "turbo-tokens.txt"),
      numThreads: threads,
      provider: "cpu",
      debug: 0,
    },
  });
} catch (err) {
  await finish({ type: "fatal", error: firstLines(err) }, 1);
}
send({ type: "ready" });

process.on("message", (m) => {
  if (m?.type !== "transcribe") return;
  try {
    const texts = [];
    for (const samples of m.parts) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples });
      recognizer.decode(stream);
      const t = String(recognizer.getResult(stream)?.text ?? "").trim();
      if (t) texts.push(t);
    }
    send({ type: "result", id: m.id, text: texts.join(" ") });
  } catch (err) {
    send({ type: "error", id: m.id, error: String(err?.message ?? err) });
  }
});
// Se il programma principale si chiude, questo processo non deve restare acceso da solo.
process.on("disconnect", () => process.exit(0));
