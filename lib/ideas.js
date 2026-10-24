// Sezione 💡 Idee: l'utente lascia idee per i contenuti (testo, link, foto, video, documenti) e dice SEMPRE perché
// (argomenti nuovi da usare, uno stile che gli piace, un formato da provare, cose da evitare). Gli agenti dei social le
// leggono con lo strumento `ideas` e segnano con `idea_used` quando ne usano una.
//
// I file stanno in <dati>/ideas/<id idea>/ e NON nell'archivio dei social: sono spunti, spesso contenuti di altri, e non
// devono finire pubblicati. Dei video si prepara un foglio con 6 fotogrammi e, se il riconoscimento vocale è pronto, la
// trascrizione del parlato; dei documenti (PDF, Word, testo) si estrae il testo.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import { DATA_DIR } from "./paths.js";
import { writeFileAtomic, readJsonSafe } from "./files.js";
import { bus } from "./store.js";
import { getSharp, assertSpace } from "./social/media.js";
import { ffmpegPath, run } from "./social/video.js";
import { pdfText } from "./reader.js";
import * as voice from "./voice.js";

export const IDEAS_FILE = path.join(DATA_DIR, "ideas.json");
export const IDEAS_DIR = path.join(DATA_DIR, "ideas");

export const MOTIVES = {
  argomenti: "Argomenti nuovi da usare",
  stile: "Mi piace questo stile: facciamo qualcosa di simile",
  formato: "Formato o struttura da provare",
  evitare: "Da evitare",
  altro: "Altro",
};
export const NETWORKS = ["instagram", "linkedin", "threads", "x", "youtube"];
export const STATUSES = ["nuova", "in_uso", "usata", "archiviata"];

const MAX_IDEAS = 500;
const MAX_FILES = 10;
const MAX_TEXT = 4000;
const MAX_REASON = 1500;
const MAX_DOC_CHARS = 200_000;
export const LIMITS = { image: 40 * 1024 * 1024, video: 300 * 1024 * 1024, document: 25 * 1024 * 1024 };

const IMAGE_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heif" };
const VIDEO_TYPES = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-m4v": ".m4v" };
const DOC_TYPES = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "text/plain": ".txt",
  "text/markdown": ".md",
};
const BY_EXT = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", txt: "text/plain", md: "text/markdown", mov: "video/quicktime", mp4: "video/mp4", m4v: "video/x-m4v", webm: "video/webm", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic" };

/** Tipo del file: quello dichiarato dal browser, o quello dell'estensione se il browser non lo dice. */
export function fileType(mime, name = "") {
  const t = String(mime ?? "").toLowerCase().split(";")[0].trim();
  if (IMAGE_TYPES[t] || VIDEO_TYPES[t] || DOC_TYPES[t]) return t;
  return BY_EXT[String(name).split(".").pop().toLowerCase()] ?? t;
}
export const kindOf = (type) => (IMAGE_TYPES[type] ? "image" : VIDEO_TYPES[type] ? "video" : DOC_TYPES[type] ? "document" : null);

// ---------- archivio ----------

let ideas = load();
function load() {
  const r = readJsonSafe(IDEAS_FILE);
  return Array.isArray(r.data?.ideas) ? r.data.ideas.filter((x) => x && typeof x === "object" && typeof x.id === "string") : [];
}
function save() {
  writeFileAtomic(IDEAS_FILE, JSON.stringify({ ideas }, null, 2));
}
const emit = (idea) => bus.emit("event", { type: "ideas", id: idea?.id ?? null });
const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
const ID = /^[a-z][a-z0-9]{8,30}$/;
const dirOf = (id) => path.join(IDEAS_DIR, id);

function find(id) {
  const idea = ID.test(String(id)) ? ideas.find((x) => x.id === id) : null;
  if (!idea) throw Object.assign(new Error("Idea non trovata (forse è stata eliminata)."), { status: 404 });
  return idea;
}
function findFile(idea, fileId) {
  const f = (idea.files ?? []).find((x) => x.id === fileId);
  if (!f) throw Object.assign(new Error("File non trovato in questa idea."), { status: 404 });
  return f;
}

function cleanNetworks(list) {
  const n = (Array.isArray(list) ? list : []).map((x) => String(x).toLowerCase()).filter((x) => NETWORKS.includes(x));
  return [...new Set(n)];
}

/** Nuova idea. Il motivo è obbligatorio: è quello che dice agli agenti cosa farne. */
export function addIdea({ text = "", motive = "altro", reason = "", networks = [] } = {}, { by = "utente" } = {}) {
  const t = String(text ?? "").trim().slice(0, MAX_TEXT);
  const r = String(reason ?? "").trim().slice(0, MAX_REASON);
  if (!MOTIVES[motive]) throw Object.assign(new Error(`Scegli il tipo di idea: ${Object.values(MOTIVES).join(", ")}.`), { status: 400 });
  if (r.length < 3) throw Object.assign(new Error("Scrivi il perché: per esempio «questi sono gli argomenti nuovi» o «mi piace questo video, facciamo qualcosa di simile»."), { status: 400 });
  if (ideas.length >= MAX_IDEAS) throw Object.assign(new Error(`Hai già ${MAX_IDEAS} idee: archivia o elimina quelle vecchie.`), { status: 400 });
  const idea = { id: newId("i"), at: new Date().toISOString(), by, text: t, motive, reason: r, networks: cleanNetworks(networks), status: "nuova", files: [], uses: [] };
  ideas.push(idea);
  save();
  emit(idea);
  return idea;
}

export function updateIdea(id, patch = {}) {
  const idea = find(id);
  if (patch.text !== undefined) idea.text = String(patch.text).trim().slice(0, MAX_TEXT);
  if (patch.reason !== undefined) {
    const r = String(patch.reason).trim().slice(0, MAX_REASON);
    if (r.length < 3) throw Object.assign(new Error("Il perché non può restare vuoto."), { status: 400 });
    idea.reason = r;
  }
  if (patch.motive !== undefined) {
    if (!MOTIVES[patch.motive]) throw Object.assign(new Error("Tipo di idea non valido."), { status: 400 });
    idea.motive = patch.motive;
  }
  if (patch.networks !== undefined) idea.networks = cleanNetworks(patch.networks);
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw Object.assign(new Error(`Stato non valido: ${STATUSES.join(", ")}.`), { status: 400 });
    idea.status = patch.status;
  }
  idea.updatedAt = new Date().toISOString();
  save();
  emit(idea);
  return idea;
}

export function deleteIdea(id) {
  const idea = find(id);
  ideas = ideas.filter((x) => x !== idea);
  fs.rmSync(dirOf(idea.id), { recursive: true, force: true });
  save();
  emit(idea);
  return { ok: true };
}

export function deleteFile(id, fileId) {
  const idea = find(id);
  const f = findFile(idea, fileId);
  for (const name of [f.file, f.sheet, f.thumb, f.textFile].filter(Boolean)) fs.rmSync(path.join(dirOf(idea.id), name), { force: true });
  idea.files = idea.files.filter((x) => x !== f);
  save();
  emit(idea);
  return idea;
}

/** Elenco per l'interfaccia, dalla più recente. */
export function listIdeas({ status } = {}) {
  const list = [...ideas].reverse();
  if (status === "da_usare") return list.filter((x) => x.status === "nuova" || x.status === "in_uso");
  if (STATUSES.includes(status)) return list.filter((x) => x.status === status);
  return list;
}
export const getIdea = (id) => find(id);

/** Percorso di un file (o della sua anteprima) per mostrarlo nell'interfaccia. */
export function filePath(id, fileId, variant = "") {
  const idea = find(id);
  const f = findFile(idea, fileId);
  const name = variant === "sheet" ? f.sheet : variant === "thumb" ? (f.thumb ?? f.sheet) : f.file;
  if (!name) throw Object.assign(new Error("Anteprima non ancora pronta."), { status: 404 });
  return { file: path.join(dirOf(idea.id), name), mime: variant ? "image/jpeg" : f.mime, name: f.name };
}

// ---------- file allegati ----------

/**
 * File caricato (già in un file temporaneo): foto ridotte a JPEG, video tenuti com'erano (fotogrammi e trascrizione
 * si preparano dopo, senza far aspettare l'utente), documenti con il testo estratto.
 */
export async function addFile(id, tmpFile, { name = "", mime = "" } = {}) {
  try {
    const idea = find(id);
    if ((idea.files ?? []).length >= MAX_FILES) throw Object.assign(new Error(`Al massimo ${MAX_FILES} file per idea.`), { status: 400 });
    const type = fileType(mime, name);
    const kind = kindOf(type);
    if (!kind) throw Object.assign(new Error("Formato non supportato: carica foto (JPEG, PNG, WebP, HEIC), video (MP4, MOV) o documenti (PDF, Word .docx, testo)."), { status: 415 });
    const size = fs.statSync(tmpFile).size;
    if (size > LIMITS[kind]) throw Object.assign(new Error(`File troppo grande: massimo ${LIMITS[kind] / 1024 / 1024} MB per ${kind === "image" ? "le foto" : kind === "video" ? "i video" : "i documenti"}.`), { status: 413 });
    assertSpace(size);
    const fid = newId("f");
    const dir = dirOf(idea.id);
    fs.mkdirSync(dir, { recursive: true });
    const clean = path.basename(String(name)).replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 120) || `${kind}`;
    const entry = { id: fid, kind, name: clean, mime: type, size, at: new Date().toISOString() };
    if (kind === "image") {
      const sharp = await getSharp();
      const file = `${fid}.jpg`;
      try {
        const img = sharp(tmpFile, { failOn: "none" }).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true });
        const info = await img.jpeg({ quality: 85 }).toFile(path.join(dir, file));
        Object.assign(entry, { file, mime: "image/jpeg", width: info.width, height: info.height, ready: true });
      } catch (err) {
        throw Object.assign(new Error(`Foto non leggibile (${err.message}). Dall'iPhone, se è HEIC, prova a condividerla come JPEG.`), { status: 415 });
      }
    } else if (kind === "video") {
      const file = `${fid}${VIDEO_TYPES[type]}`;
      fs.renameSync(tmpFile, path.join(dir, file));
      Object.assign(entry, { file, ready: false, state: "in lavorazione: preparo fotogrammi e trascrizione" });
    } else {
      const file = `${fid}${DOC_TYPES[type]}`;
      fs.renameSync(tmpFile, path.join(dir, file));
      const text = await documentText(path.join(dir, file), type);
      if (text.error) entry.state = text.error;
      if (text.text) {
        entry.textFile = `${fid}.txt`;
        entry.chars = text.text.length;
        entry.preview = text.text.slice(0, 600);
        fs.writeFileSync(path.join(dir, entry.textFile), text.text);
      }
      Object.assign(entry, { file, ready: true });
    }
    idea.files.push(entry);
    save();
    emit(idea);
    if (kind === "video") queueVideo(idea.id, fid);
    return idea;
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

async function documentText(file, type) {
  try {
    if (type === "application/pdf") {
      const r = await pdfText(fs.readFileSync(file));
      if (r.missing) return { error: "PDF salvato, ma su questo computer manca il programma per leggerlo (pdftotext): gli agenti vedono solo il nome" };
      if (r.error) return { error: `PDF non leggibile: ${r.error}` };
      return r.text?.trim() ? { text: r.text.slice(0, MAX_DOC_CHARS) } : { error: "PDF senza testo (forse è una scansione): gli agenti vedono solo il nome" };
    }
    if (type.includes("wordprocessingml")) {
      const xml = new AdmZip(file).readAsText("word/document.xml");
      const text = xml
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<\/w:p>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      return text ? { text: text.slice(0, MAX_DOC_CHARS) } : { error: "documento Word vuoto" };
    }
    return { text: fs.readFileSync(file, "utf8").slice(0, MAX_DOC_CHARS) };
  } catch (err) {
    return { error: `testo non leggibile: ${err.message}` };
  }
}

// ---------- video: fotogrammi e trascrizione (uno alla volta) ----------

let transcriber = (wav) => voice.transcribe(wav);
/** Solo per le prove automatiche. */
export const _setTranscriber = (fn) => (transcriber = fn);

let chain = Promise.resolve();
const pending = new Set();
function queueVideo(id, fid) {
  const key = `${id}/${fid}`;
  pending.add(key);
  chain = chain.then(() => processVideo(id, fid)).catch(() => {}).finally(() => pending.delete(key));
}
/** Le prove aspettano che i video in coda siano pronti. */
export const _idle = () => chain;

const FRAMES = 6;
async function processVideo(id, fid) {
  let idea;
  let f;
  try {
    idea = find(id);
    f = findFile(idea, fid);
  } catch {
    return; // eliminato nel frattempo
  }
  const dir = dirOf(id);
  const src = path.join(dir, f.file);
  const bin = await ffmpegPath();
  const tmp = fs.mkdtempSync(path.join(dir, ".lavoro-"));
  const notes = [];
  try {
    // Durata: ffmpeg legge le informazioni del file senza convertire niente (-t 0).
    const info = await run(bin, ["-hide_banner", "-i", src, "-t", "0", "-f", "null", "-"], tmp).catch((e) => e.message);
    const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info);
    const seconds = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
    if (seconds) f.seconds = Math.round(seconds);
    // Fotogrammi distribuiti su tutto il video, uniti in un foglio 3×2.
    const frames = [];
    for (let i = 0; i < FRAMES; i++) {
      const at = seconds ? ((i + 0.5) * seconds) / FRAMES : i;
      const out = path.join(tmp, `f${i}.jpg`);
      try {
        await run(bin, ["-hide_banner", "-loglevel", "error", "-y", "-ss", at.toFixed(2), "-i", src, "-frames:v", "1", "-vf", "scale=360:-2", out], tmp);
        if (fs.existsSync(out)) frames.push({ file: out, at });
      } catch {
        // un fotogramma in meno
      }
    }
    if (frames.length) {
      const sharp = await getSharp();
      const metas = await Promise.all(frames.map((x) => sharp(x.file).metadata()));
      const cellW = 360;
      const cellH = Math.max(...metas.map((x) => x.height ?? 640));
      const cols = 3;
      const rows = Math.ceil(frames.length / cols);
      f.sheet = `${fid}-fotogrammi.jpg`;
      await sharp({ create: { width: cols * cellW, height: rows * cellH, channels: 3, background: "#111111" } })
        .composite(frames.map((x, i) => ({ input: x.file, left: (i % cols) * cellW, top: Math.floor(i / cols) * cellH })))
        .jpeg({ quality: 80 })
        .toFile(path.join(dir, f.sheet));
      f.frameTimes = frames.map((x) => Math.round(x.at));
    } else notes.push("fotogrammi non estratti");
    // Parlato: i primi 2 minuti, a 16 kHz un canale come vuole il riconoscimento vocale.
    const wav = path.join(tmp, "audio.wav");
    try {
      await run(bin, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-t", "120", "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav], tmp);
      f.transcript = await transcriber(fs.readFileSync(wav));
    } catch (err) {
      if (err.status === 409) notes.push("trascrizione non fatta: il riconoscimento della voce non è ancora scaricato (si scarica dal 🎤 della chat di Orion)");
      else if (err.status === 422 || /stream|audio/i.test(err.message)) notes.push("nessun parlato da trascrivere");
      else notes.push(`trascrizione non riuscita: ${err.message}`);
    }
    f.ready = true;
    f.state = notes.length ? notes.join("; ") : "pronto";
  } catch (err) {
    f.ready = true;
    f.state = `video non elaborato: ${err.message}`;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (ideas.includes(idea)) {
      save();
      emit(idea);
    }
  }
}

/** All'avvio: i video rimasti a metà (programma chiuso durante il lavoro) si rifanno. */
export function resumePending() {
  for (const idea of ideas) for (const f of idea.files ?? []) if (f.kind === "video" && !f.ready && !pending.has(`${idea.id}/${f.id}`)) queueVideo(idea.id, f.id);
}

// ---------- per gli agenti ----------

const fileForAgent = (f) => ({
  file_id: f.id,
  tipo: { image: "foto", video: "video", document: "documento" }[f.kind],
  nome: f.name,
  ...(f.kind === "video" ? { secondi: f.seconds ?? null, pronto: Boolean(f.ready), ...(f.transcript ? { parlato: f.transcript.slice(0, 1500) } : {}) } : {}),
  ...(f.kind === "document" ? { caratteri: f.chars ?? 0, inizio: f.preview ?? null } : {}),
  ...(f.state && f.state !== "pronto" ? { nota: f.state } : {}),
});

const ideaForAgent = (x) => ({
  id: x.id,
  data: x.at.slice(0, 10),
  tipo: MOTIVES[x.motive],
  perche: x.reason,
  idea: x.text || null,
  social: x.networks.length ? x.networks : "tutti",
  stato: x.status,
  file: (x.files ?? []).map(fileForAgent),
  ...(x.uses?.length ? { gia_usata: x.uses.slice(-3).map((u) => `${u.at.slice(0, 10)} ${u.by}: ${u.note}`) } : {}),
});

/**
 * Strumento `ideas`: senza id l'elenco delle idee (di partenza quelle ancora da usare, per il social indicato), con id
 * l'idea intera, con id e file_id il file: la foto o il foglio dei fotogrammi da guardare, o il testo del documento.
 */
export async function ideasTool({ id, file_id, network, status = "da_usare", from = 0, limit = 15 } = {}) {
  if (!id) {
    const net = network ? String(network).toLowerCase() : null;
    let list = listIdeas({ status: status === "tutte" ? null : status === "usate" ? "usata" : "da_usare" });
    if (net) list = list.filter((x) => !x.networks.length || x.networks.includes(net));
    const avoid = listIdeas({ status: "da_usare" }).filter((x) => x.motive === "evitare" && (!net || !x.networks.length || x.networks.includes(net)));
    return {
      idee: list.slice(0, Math.min(Number(limit) || 15, 40)).map(ideaForAgent),
      totale: list.length,
      ...(avoid.length ? { da_evitare_sempre: avoid.map((x) => `${x.reason}${x.text ? ` (${x.text.slice(0, 200)})` : ""}`) } : {}),
      come_usarle: "Le idee sono dell'utente: rispetta il perché. «Argomenti» = temi da trattare; «stile» = prendi spunto da ritmo, struttura, grafica e tono, senza copiare né ripubblicare il contenuto di altri; «formato» = struttura da provare; «da evitare» = regola fissa. Guarda foto e video con ideas id + file_id. Quando ne usi una scrivi idea_used.",
    };
  }
  const idea = find(String(id));
  if (!file_id) return ideaForAgent(idea);
  const f = findFile(idea, String(file_id));
  const dir = dirOf(idea.id);
  if (f.kind === "document") {
    if (!f.textFile) return { ...fileForAgent(f), testo: null };
    const all = fs.readFileSync(path.join(dir, f.textFile), "utf8");
    const start = Math.max(0, Number(from) || 0);
    const piece = all.slice(start, start + 12_000);
    return { ...fileForAgent(f), testo: piece, ...(start + piece.length < all.length ? { continua_da: start + piece.length } : {}) };
  }
  const img = f.kind === "image" ? f.file : f.sheet;
  if (!img) return { ...fileForAgent(f), nota: f.state ?? "anteprima non ancora pronta: riprova più tardi" };
  const sharp = await getSharp();
  const buf = await sharp(path.join(dir, img)).resize({ width: 1500, height: 1500, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  const info = f.kind === "video"
    ? { ...fileForAgent(f), fotogrammi: `6 momenti del video, da sinistra a destra e dall'alto in basso, ai secondi ${(f.frameTimes ?? []).join(", ")}`, ...(f.transcript ? { parlato: f.transcript } : {}) }
    : fileForAgent(f);
  return {
    toolContent: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } },
      { type: "text", text: JSON.stringify({ idea: idea.id, perche: idea.reason, ...info }) },
    ],
  };
}

/** Strumento `idea_used`: l'agente dice cosa ha fatto con l'idea; finished = l'idea è esaurita. */
export function markUsed({ id, note = "", finished = false } = {}, { by = "agente" } = {}) {
  const idea = find(String(id));
  const n = String(note ?? "").trim().slice(0, 400);
  if (n.length < 5) throw new Error("note: scrivi in breve cosa hai fatto con l'idea (es. «Reel di martedì sul bando, stile del video di esempio»).");
  idea.uses = [...(idea.uses ?? []), { at: new Date().toISOString(), by, note: n }].slice(-30);
  if (idea.status !== "archiviata") idea.status = finished ? "usata" : "in_uso";
  save();
  emit(idea);
  return { ok: true, stato: idea.status };
}

/** Solo per le prove automatiche. */
export function _reload() {
  ideas = load();
}
