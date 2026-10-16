// Piccoli aiuti per l'audio della voce narrante (WAV PCM 16 bit, un canale): silenzio ai bordi e scrittura.
import fs from "node:fs";

/** Toglie il silenzio prima e dopo la frase (con un piccolo margine): così i tempi delle parole sono più precisi. */
export function trim(samples, rate) {
  let a = 0;
  let b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < 0.01) a++;
  while (b > a && Math.abs(samples[b]) < 0.01) b--;
  const pad = Math.round(rate * 0.03);
  return samples.subarray(Math.max(0, a - pad), Math.min(samples.length, b + pad));
}

/** Unisce le frasi con una pausa tra l'una e l'altra; restituisce l'audio e i tempi di ogni frase. */
export function joinSentences(parts, rate, gap) {
  const times = [];
  const chunks = [];
  let t = 0;
  for (const { text, samples } of parts) {
    if (chunks.length) {
      chunks.push(new Float32Array(Math.round(rate * gap)));
      t += gap;
    }
    chunks.push(samples);
    times.push({ text, start: t, end: t + samples.length / rate });
    t += samples.length / rate;
  }
  const all = new Float32Array(chunks.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of chunks) {
    all.set(p, at);
    at += p.length;
  }
  return { samples: all, times };
}

export function writeWav(file, samples, rate) {
  fs.writeFileSync(file, wavBuffer(samples, rate));
}

export function wavBuffer(samples, rate) {
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
  return buf;
}
