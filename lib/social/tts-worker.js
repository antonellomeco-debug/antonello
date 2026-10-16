// Processo a parte per la voce narrante dei video (avviato da tts.js): carica la voce una volta e legge le frasi
// che riceve, scrivendo un WAV per schermata. TTS_ENGINE sostituisce la libreria nelle prove.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

/** Toglie il silenzio prima e dopo la frase (con un piccolo margine): così i tempi delle parole sono più precisi. */
function trim(samples, rate) {
  let a = 0;
  let b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < 0.01) a++;
  while (b > a && Math.abs(samples[b]) < 0.01) b--;
  const pad = Math.round(rate * 0.03);
  return samples.subarray(Math.max(0, a - pad), Math.min(samples.length, b + pad));
}

function writeWav(file, samples, rate) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

process.on("message", (m) => {
  if (m?.type !== "speak") return;
  try {
    const items = m.items.map((item) => {
      const parts = [];
      const times = [];
      let rate = 22050;
      let t = 0;
      for (const text of item.sentences) {
        const audio = tts.generate({ text, sid: 0, speed: m.speed });
        rate = audio.sampleRate;
        const s = trim(audio.samples, rate);
        if (parts.length) {
          parts.push(new Float32Array(Math.round(rate * m.gap)));
          t += m.gap;
        }
        parts.push(s);
        times.push({ text, start: t, end: t + s.length / rate });
        t += s.length / rate;
      }
      const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.length;
      }
      writeWav(item.out, all, rate);
      return { seconds: all.length / rate, sentences: times };
    });
    send({ type: "result", id: m.id, items });
  } catch (err) {
    send({ type: "error", id: m.id, error: String(err?.message ?? err) });
  }
});
process.on("disconnect", () => process.exit(0));
