// Voce narrante dei video (create_video): testo italiano → audio, sul nostro server, gratis e senza chiavi.
// Voce "Paola" di Piper (sherpa-onnx, la stessa libreria dei messaggi vocali), circa 65 MB scaricati una volta sola
// nella cartella dei dati alla prima richiesta. Lavora in un processo a parte (tts-worker.js) che si chiude da solo.
// Di ogni frase si conosce la durata: i sottotitoli parola per parola si sincronizzano stimando la durata delle
// parole in proporzione alle lettere (la voce di Piper non dice quando inizia ogni parola).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fork, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../paths.js";

const env = process.env;
export const VOICE = {
  name: "tts-paola",
  url: env.TTS_MODEL_URL || "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-it_IT-paola-medium.tar.bz2",
  sha256: env.TTS_MODEL_URL ? env.TTS_MODEL_SHA256 || null : "7541f75778afa164e44e34baaef63befad7698595df26a95ca944b63ef1a16b4",
  folder: "vits-piper-it_IT-paola-medium",
  model: "it_IT-paola-medium.onnx",
  downloadMB: 65,
};
const MODELS_DIR = path.join(DATA_DIR, "models");
export const VOICE_DIR = path.join(MODELS_DIR, VOICE.name);
const READY_FILE = path.join(VOICE_DIR, "pronto.json");
const WORKER = fileURLToPath(new URL("./tts-worker.js", import.meta.url));
const IDLE_MS = Number(env.TTS_IDLE_MS) || 2 * 60_000;
const GAP = 0.15; // secondi di pausa tra una frase e l'altra

const ready = () => fs.existsSync(READY_FILE) && fs.existsSync(path.join(VOICE_DIR, VOICE.model)) && fs.existsSync(path.join(VOICE_DIR, "espeak-ng-data"));

let preparing = null;
/** Scarica e prepara la voce se manca (una volta sola; più richieste insieme aspettano lo stesso scarico). */
export function prepareVoice() {
  if (ready()) return Promise.resolve();
  preparing ??= doPrepare().finally(() => (preparing = null));
  return preparing;
}

async function doPrepare() {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const archive = path.join(MODELS_DIR, `${VOICE.name}.tar.bz2.part`);
  const tmp = path.join(MODELS_DIR, `.${VOICE.name}-tmp`);
  fs.rmSync(archive, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  let res;
  try {
    res = await fetch(VOICE.url, { redirect: "follow", signal: AbortSignal.timeout(20 * 60_000) });
  } catch {
    throw new Error("Non riesco a scaricare la voce narrante: controlla la connessione a internet e riprova.");
  }
  if (!res.ok || !res.body) throw new Error(`Download della voce narrante non riuscito (risposta ${res.status}). Riprova più tardi.`);
  const hash = crypto.createHash("sha256");
  try {
    await pipeline(Readable.fromWeb(res.body), async function* (src) {
      for await (const chunk of src) {
        hash.update(chunk);
        yield chunk;
      }
    }, fs.createWriteStream(archive));
    if (VOICE.sha256 && hash.digest("hex") !== VOICE.sha256) throw new Error("Il file della voce scaricato non è quello atteso (controllo di integrità). Riprova più tardi.");
    fs.mkdirSync(tmp, { recursive: true });
    const r = await run("tar", ["-xjf", archive, "-C", tmp]);
    if (r.code !== 0) throw new Error(`Estrazione della voce non riuscita: ${r.out.trim().slice(-200)}`);
    fs.rmSync(VOICE_DIR, { recursive: true, force: true });
    fs.renameSync(path.join(tmp, VOICE.folder), VOICE_DIR);
    fs.writeFileSync(READY_FILE, JSON.stringify({ url: VOICE.url, at: new Date().toISOString() }));
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ code: -1, out: err.message }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

// ---------- testo ----------

/** Testo da leggere: simboli a parole, niente emoji né caratteri che la voce leggerebbe male. */
export function speakable(text) {
  return String(text ?? "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/(\d)\s*%/g, "$1 per cento")
    .replace(/€\s*(\d[\d.,]*)/g, "$1 euro")
    .replace(/(\d[\d.,]*)\s*€/g, "$1 euro")
    .replace(/\$\s*(\d[\d.,]*)/g, "$1 dollari")
    .replace(/(\d[\d.,]*)\s*\$/g, "$1 dollari")
    .replace(/&/g, " e ")
    .replace(/[#*_~^<>{}[\]|\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Frasi (la voce le legge una per una: così si sa quando inizia ciascuna). */
export function sentences(text) {
  return speakable(text)
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/** Tempi stimati delle parole di una frase: in proporzione alle lettere, con un po' di pausa dopo la punteggiatura. */
export function wordTimes(text, start, end) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const weight = (w) => Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, "").length) + (/[,;:.!?…]$/.test(w) ? 3 : 0);
  const total = words.reduce((n, w) => n + weight(w), 0) || 1;
  const span = Math.max(0.1, end - start);
  let t = start;
  return words.map((w) => {
    const d = (span * weight(w)) / total;
    const out = { word: w, start: t, end: t + d };
    t += d;
    return out;
  });
}

// ---------- processo della voce ----------

let worker = null;
let idleTimer = null;
let seq = 0;
const waiting = new Map();

function startWorker() {
  const child = fork(WORKER, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...env, TTS_MODEL_DIR: VOICE_DIR } });
  let err = "";
  child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
  const started = new Promise((resolve, reject) => {
    child.on("message", (m) => {
      if (m?.type === "ready") resolve();
      else if (m?.type === "fatal") reject(new Error(m.error));
      else if (m?.id && waiting.has(m.id)) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        m.type === "result" ? w.resolve(m.items) : w.reject(new Error(m.error));
      }
    });
    child.on("close", (code) => {
      if (worker?.child === child) worker = null;
      const e = new Error(`la voce narrante si è fermata: ${err.trim().split("\n").pop() || `codice ${code}`}`);
      reject(e);
      for (const w of waiting.values()) w.reject(e);
      waiting.clear();
    });
  });
  worker = { child, started };
  return worker;
}

function stopWorker() {
  clearTimeout(idleTimer);
  worker?.child.kill();
  worker = null;
}

/**
 * Legge i testi (uno per schermata) e scrive un WAV per ciascuno in outDir.
 * Restituisce per ogni testo { file, seconds, words: [{ word, start, end }] } (null se il testo è vuoto).
 */
export async function synthesize(texts, outDir, { speed = 1.05 } = {}) {
  const items = texts.map((t, i) => {
    const list = sentences(t);
    return list.length ? { out: path.join(outDir, `voce-${i}.wav`), sentences: list } : null;
  });
  if (!items.some(Boolean)) return items;
  await prepareVoice();
  clearTimeout(idleTimer);
  const w = worker ?? startWorker();
  await w.started;
  const id = ++seq;
  const done = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  w.child.send({ type: "speak", id, speed, gap: GAP, items: items.filter(Boolean) });
  let results;
  try {
    results = await done;
  } finally {
    idleTimer = setTimeout(stopWorker, IDLE_MS);
    idleTimer.unref?.();
  }
  let k = 0;
  return items.map((it) => {
    if (!it) return null;
    const r = results[k++];
    return { file: it.out, seconds: r.seconds, words: r.sentences.flatMap((s) => wordTimes(s.text, s.start, s.end)) };
  });
}

export const shutdownTts = stopWorker;
