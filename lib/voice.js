// Messaggi vocali per Orion: la voce diventa testo qui, sul nostro server (Whisper "turbo" con sherpa-onnx),
// senza servizi esterni né chiavi. Il modello (circa 560 MB) si scarica una volta sola nella cartella dei dati
// e si usa in un processo a parte (lib/voice-worker.js): occupa molta memoria solo mentre trascrive e si chiude
// da solo dopo qualche minuto senza messaggi.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fork, spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./paths.js";
import { bus, log } from "./store.js";

const env = process.env;

/** Modello ufficiale di sherpa-onnx (Whisper large-v3-turbo, int8): italiano buono anche con numeri e termini di borsa. */
export const MODEL = {
  name: "whisper-turbo",
  url: env.VOICE_MODEL_URL || "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2",
  sha256: env.VOICE_MODEL_URL ? env.VOICE_MODEL_SHA256 || null : "b11acbbcd660b44a8e0df33724feb5aaa709cf65668f2823d59f656312544f22",
  folder: "sherpa-onnx-whisper-turbo",
  files: { encoder: "turbo-encoder.int8.onnx", decoder: "turbo-decoder.int8.onnx", tokens: "turbo-tokens.txt" },
  downloadMB: 564,
  diskMB: 1040,
};

const MODELS_DIR = path.join(DATA_DIR, "models");
export const MODEL_DIR = path.join(MODELS_DIR, MODEL.name);
const READY_FILE = path.join(MODEL_DIR, "pronto.json");
const ARCHIVE = path.join(MODELS_DIR, `${MODEL.name}.tar.bz2.part`);
const WORKER = env.VOICE_WORKER || fileURLToPath(new URL("./voice-worker.js", import.meta.url));

export const SAMPLE_RATE = 16000; // Whisper lavora a 16 kHz, un canale
export const MIN_SECONDS = 0.5;
export const MAX_SECONDS = 125; // l'app ferma la registrazione a 2 minuti
const WINDOW_SECONDS = 28; // Whisper ascolta al massimo 30 secondi per volta: i messaggi più lunghi si dividono
const IDLE_MS = Number(env.VOICE_IDLE_MS) || 3 * 60_000; // poi il processo si chiude e libera la memoria

// ---------- stato del modello ----------

let status = { state: "missing", progress: 0, error: null };

function setStatus(next) {
  status = { ...status, ...next };
  bus.emit("event", { type: "voice", status: publicStatus() });
}

/** Stato per l'app: missing | downloading | extracting | ready | error | unsupported. */
export function publicStatus() {
  if (status.state === "missing" || status.state === "ready") status.state = modelReady() ? "ready" : "missing";
  return { ...status, downloadMB: MODEL.downloadMB };
}

function modelReady() {
  try {
    return fs.existsSync(READY_FILE) && Object.values(MODEL.files).every((f) => fs.statSync(path.join(MODEL_DIR, f)).size > 0);
  } catch {
    return false;
  }
}

// ---------- preparazione (scarico ed estrazione, una volta sola) ----------

let preparing = null;

/** Avvia la preparazione del modello se manca. Restituisce subito lo stato: l'avanzamento arriva con gli eventi. */
export function prepare() {
  if (modelReady()) return publicStatus();
  if (!preparing) {
    preparing = doPrepare()
      .catch((err) => {
        const unsupported = err.code === "VOICE_UNSUPPORTED";
        setStatus({ state: unsupported ? "unsupported" : "error", error: err.message, progress: 0 });
        log("programma", "warn", `Messaggi vocali: preparazione non riuscita. ${err.message}`);
      })
      .finally(() => (preparing = null));
  }
  return publicStatus();
}

async function doPrepare() {
  setStatus({ state: "downloading", progress: 0, error: null });
  const engine = await engineWorks();
  if (!engine.ok) throw Object.assign(new Error(engine.error), { code: "VOICE_UNSUPPORTED" });

  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const free = freeMB(MODELS_DIR);
  const needed = MODEL.downloadMB + MODEL.diskMB + 100;
  if (free != null && free < needed) {
    throw new Error(`Spazio insufficiente: servono circa ${Math.ceil(needed / 100) / 10} GB liberi, ce ne sono ${Math.floor(free / 100) / 10}.`);
  }
  log("programma", "info", `Messaggi vocali: scarico il riconoscimento della voce (circa ${MODEL.downloadMB} MB, una volta sola).`);
  await download();
  setStatus({ state: "extracting", progress: 1 });
  await extract();
  fs.rmSync(ARCHIVE, { force: true });
  setStatus({ state: "ready", progress: 1, error: null });
  log("programma", "info", "Messaggi vocali pronti: tocca 🎤 nella chat e parla.");
}

function freeMB(dir) {
  try {
    const s = fs.statfsSync(dir);
    return (s.bavail * s.bsize) / 1048576;
  } catch {
    return null;
  }
}

async function download() {
  const res = await fetch(MODEL.url, { redirect: "follow", signal: AbortSignal.timeout(60 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Download del modello non riuscito (risposta ${res.status}). Riprova più tardi.`);
  const total = Number(res.headers.get("content-length")) || MODEL.downloadMB * 1048576;
  const hash = crypto.createHash("sha256");
  let got = 0;
  let lastEmit = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      hash.update(chunk);
      const now = Date.now();
      if (now - lastEmit > 1000) {
        lastEmit = now;
        setStatus({ progress: Math.min(0.99, got / total) });
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(ARCHIVE));
  } catch (err) {
    fs.rmSync(ARCHIVE, { force: true });
    throw new Error(`Download del modello interrotto (${err.message}). Riprova.`);
  }
  const digest = hash.digest("hex");
  if (MODEL.sha256 && digest !== MODEL.sha256) {
    fs.rmSync(ARCHIVE, { force: true });
    throw new Error("Il file scaricato non è quello atteso (controllo di integrità non superato). Riprova più tardi.");
  }
}

/** Estrae solo i 3 file che servono con "tar" (presente sul Mac e nell'immagine del server). */
async function extract() {
  const tmp = path.join(MODELS_DIR, `.${MODEL.name}-tmp`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const members = Object.values(MODEL.files).map((f) => `${MODEL.folder}/${f}`);
  const r = await run("tar", ["-xjf", ARCHIVE, "-C", tmp, ...members]);
  if (r.code !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`Estrazione del modello non riuscita: ${r.out.trim().slice(-300) || `codice ${r.code}`}`);
  }
  fs.rmSync(MODEL_DIR, { recursive: true, force: true });
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  for (const f of Object.values(MODEL.files)) fs.renameSync(path.join(tmp, MODEL.folder, f), path.join(MODEL_DIR, f));
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(READY_FILE, JSON.stringify({ model: MODEL.name, url: MODEL.url, at: new Date().toISOString() }, null, 2));
}

function run(cmd, args) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ code: -1, out: err.message });
    }
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ code: -1, out: err.message }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** Il motore (libreria nativa) funziona su questo computer? Si prova in un processo a parte, prima di scaricare. */
async function engineWorks() {
  const r = await new Promise((resolve) => {
    const child = fork(WORKER, ["--check"], { stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced" });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("message", (m) => m?.type === "check" && resolve(m));
    child.on("error", (e) => resolve({ ok: false, error: e.message }));
    child.on("exit", (code) => resolve({ ok: false, error: err.trim().split("\n").pop() || `codice ${code}` }));
  });
  if (r.ok) return r;
  return { ok: false, error: `Su questo computer il riconoscimento della voce non funziona (${r.error}). Puoi dettare con il microfono della tastiera.` };
}

// ---------- audio ----------

/** Legge un WAV PCM (16 bit o 32 bit float). Restituisce i campioni di un solo canale (media dei canali). */
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw badAudio("Audio non valido: serve un file WAV.");
  }
  let fmt = null;
  let data = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= buf.length) {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      data = buf.subarray(body, Math.min(buf.length, body + size));
      break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw badAudio("Audio non valido: file WAV incompleto.");
  const { format, channels, rate, bits } = fmt;
  const pcm16 = format === 1 && bits === 16;
  const float32 = format === 3 && bits === 32;
  if (!(pcm16 || float32) || channels < 1 || channels > 2 || rate < 8000 || rate > 96000) {
    throw badAudio("Formato audio non supportato.");
  }
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = (i * channels + c) * bytes;
      sum += pcm16 ? data.readInt16LE(at) / 32768 : data.readFloatLE(at);
    }
    const v = sum / channels;
    samples[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  }
  return { samples, rate };
}

const badAudio = (msg) => Object.assign(new Error(msg), { status: 400 });

/** Ricampiona (media dei campioni vicini: basta per la voce). */
export function resample(input, from, to = SAMPLE_RATE) {
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

/** Secondi in cui si sente qualcosa (finestre di 30 ms sopra una soglia bassa). */
export function voicedSeconds(samples, rate = SAMPLE_RATE) {
  const win = Math.round(rate * 0.03);
  let voiced = 0;
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += samples[j] * samples[j];
    if (Math.sqrt(sum / win) > 0.01) voiced++;
  }
  return (voiced * win) / rate;
}

/**
 * Divide i messaggi lunghi in pezzi da al massimo 28 secondi, tagliando nel punto più silenzioso degli ultimi
 * 8 secondi di ogni pezzo (di solito una pausa tra le parole).
 */
export function splitForWhisper(samples, rate = SAMPLE_RATE, windowSeconds = WINDOW_SECONDS) {
  const max = Math.round(windowSeconds * rate);
  if (samples.length <= max) return [samples];
  const parts = [];
  const step = Math.round(rate * 0.1);
  let start = 0;
  while (samples.length - start > max) {
    let cut = start + max;
    let best = Infinity;
    for (let at = start + max - Math.round(rate * 8); at + step <= start + max; at += step) {
      let sum = 0;
      for (let j = at; j < at + step; j++) sum += samples[j] * samples[j];
      if (sum < best) {
        best = sum;
        cut = at + Math.round(step / 2);
      }
    }
    parts.push(samples.slice(start, cut)); // copie: al processo a parte si manda solo il pezzo, non tutto l'audio
    start = cut;
  }
  parts.push(samples.slice(start));
  return parts.filter((p) => p.length >= rate * 0.2);
}

// Frasi che Whisper "inventa" sul silenzio o sul rumore (dai sottotitoli con cui è stato addestrato).
const HALLUCINATIONS = [
  /sottotitoli[^.!?\n]*?(amara\.org|qtss)[^.!?\n]*[.!?]?/gi,
  /sottotitoli (creati|a cura|e revisione)[^.!?\n]*[.!?]?/gi,
  /\b(grazie per la visione|grazie a tutti per la visione|iscriviti al canale)[.!?]?/gi,
  /\[[^\]]{0,40}\]|\((musica|applausi|risate|silenzio)\)/gi,
];

/** Ripulisce il testo trascritto: toglie le frasi inventate e gli spazi doppi. */
export function cleanTranscript(text) {
  let t = String(text ?? "");
  for (const re of HALLUCINATIONS) t = t.replace(re, " ");
  return t.replace(/\s+/g, " ").trim();
}

// ---------- trascrizione (processo a parte) ----------

let worker = null; // { child, ready: Promise, pending: Map, idle }
let queue = Promise.resolve();
let nextId = 1;

function startWorker() {
  const child = fork(WORKER, [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    serialization: "advanced",
    env: { ...env, VOICE_MODEL_DIR: MODEL_DIR },
  });
  const w = { child, pending: new Map(), idle: null };
  w.ready = new Promise((resolve, reject) => {
    w.readyResolve = resolve;
    w.readyReject = reject;
  });
  w.ready.catch(() => {});
  child.on("message", (m) => {
    if (m?.type === "ready") return w.readyResolve();
    if (m?.type === "fatal") return w.readyReject(new Error(m.error));
    const p = w.pending.get(m?.id);
    if (!p) return;
    w.pending.delete(m.id);
    if (m.type === "result") p.resolve(m.text);
    else p.reject(new Error(m.error || "trascrizione non riuscita"));
  });
  const gone = (why) => {
    if (worker === w) worker = null;
    clearTimeout(w.idle);
    const err = new Error(why);
    w.readyReject(err);
    for (const p of w.pending.values()) p.reject(err);
    w.pending.clear();
  };
  child.on("error", (e) => gone(`Il riconoscimento della voce non è partito (${e.message}).`));
  child.on("exit", (code, signal) => gone(signal === "SIGKILL" || code === 137 ? "Il riconoscimento della voce si è fermato: forse manca memoria. Riprova." : "Il riconoscimento della voce si è fermato. Riprova."));
  return w;
}

function stopWorker() {
  const w = worker;
  worker = null;
  if (!w) return;
  clearTimeout(w.idle);
  try {
    w.child.kill();
  } catch {
    // già chiuso
  }
}

async function decodeInWorker(parts, seconds) {
  if (!worker) worker = startWorker();
  const w = worker;
  clearTimeout(w.idle);
  try {
    await w.ready;
  } catch (err) {
    stopWorker();
    if (/addon|module|dlopen|symbol|GLIBC|macOS|darwin/i.test(err.message)) {
      setStatus({ state: "unsupported", error: `Su questo computer il riconoscimento della voce non funziona (${err.message}).` });
    }
    throw err;
  }
  const id = nextId++;
  const timeoutMs = 60_000 + seconds * 2000;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        w.pending.delete(id);
        reject(new Error("La trascrizione ci mette troppo: riprova con un messaggio più corto."));
        stopWorker();
      }, timeoutMs);
      w.pending.set(id, {
        resolve: (t) => (clearTimeout(timer), resolve(t)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      w.child.send({ type: "transcribe", id, parts });
    });
  } finally {
    if (worker === w) w.idle = setTimeout(stopWorker, IDLE_MS);
  }
}

/**
 * Da WAV a testo. Errori con status: 400 audio non valido, 409 modello non pronto, 422 non si è capito niente.
 * Una trascrizione per volta (due insieme raddoppierebbero la memoria).
 */
export async function transcribe(wav) {
  const { samples: raw, rate } = parseWav(wav);
  const samples = resample(raw, rate);
  const seconds = samples.length / SAMPLE_RATE;
  if (seconds < MIN_SECONDS) throw Object.assign(new Error("Messaggio troppo corto: parla per almeno un secondo."), { status: 422 });
  if (seconds > MAX_SECONDS) throw Object.assign(new Error("Messaggio troppo lungo: al massimo 2 minuti."), { status: 400 });
  if (voicedSeconds(samples) < 0.3) throw Object.assign(new Error("Non ho sentito la tua voce: avvicina il telefono e riprova."), { status: 422 });
  if (!modelReady()) throw Object.assign(new Error("Il riconoscimento della voce non è ancora pronto."), { status: 409 });
  const parts = splitForWhisper(samples);
  const job = queue.then(() => decodeInWorker(parts, seconds));
  queue = job.catch(() => {});
  return job.then((text) => {
    const clean = cleanTranscript(text);
    if (!clean) throw Object.assign(new Error("Non ho capito le parole: riprova parlando più vicino al telefono."), { status: 422 });
    return clean;
  });
}

/** Alla chiusura del programma. */
export const shutdownVoice = stopWorker;

/** Solo per le prove automatiche. */
export const _test = { stopWorker, setStatus, resetStatus: () => (status = { state: "missing", progress: 0, error: null }) };
