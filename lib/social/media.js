// Archivio dei file per i social: foto, video e musiche caricati dall'utente, grafiche disegnate dagli agenti
// (SVG → JPEG), immagini fatte con l'IA e video montati dagli agenti (video.js). Stanno in <dati>/media/ (non entrano nelle copie dei dati: possono essere grandi).
// Ogni file ha un indirizzo pubblico segreto (/m/<codice casuale>.<estensione>) da cui Instagram e Threads lo
// scaricano: senza il codice non si trova. Le foto diventano JPEG (l'unico formato che Instagram accetta).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, ROOT } from "../paths.js";
import { PUBLIC_URL } from "../env.js";
import { writeFileAtomic, readJsonSafe } from "../files.js";

export const MEDIA_DIR = path.join(DATA_DIR, "media");
const INDEX_FILE = path.join(MEDIA_DIR, "index.json");
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const KEEP_FREE = 300 * 1024 * 1024; // spazio da lasciare libero nel disco dei dati

/** Formati delle grafiche (pixel): quadrato e verticale per i feed, storia/reel, orizzontale per X e LinkedIn. */
export const FORMATS = {
  square: { w: 1080, h: 1080, label: "quadrato 1080×1080 (feed)" },
  portrait: { w: 1080, h: 1350, label: "verticale 4:5 1080×1350 (feed Instagram, il più visibile)" },
  story: { w: 1080, h: 1920, label: "storia/reel 9:16 1080×1920" },
  landscape: { w: 1200, h: 675, label: "orizzontale 16:9 1200×675 (X, LinkedIn)" },
  banner_x: { w: 1500, h: 500, label: "copertina del profilo X 1500×500" },
  banner_linkedin: { w: 1584, h: 396, label: "copertina del profilo LinkedIn 1584×396" },
};
export const FONTS = ["Montserrat", "Inter", "Bebas Neue", "Playfair Display"];

const VIDEO_TYPES = { "video/mp4": ".mp4", "video/quicktime": ".mov" };
// Musiche e audio (per i video montati dagli agenti): li carica l'utente, con i diritti per usarli.
const AUDIO_TYPES = { "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a", "audio/aac": ".aac", "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav" };
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/tiff", "image/heic", "image/heif"];

// ---------- caratteri delle grafiche ----------
// Le grafiche usano i caratteri inclusi nel programma (assets/fonts), uguali sul Mac e sul server.
function setupFonts() {
  if (process.env.FONTCONFIG_FILE) return;
  try {
    const dir = path.join(os.tmpdir(), "agenti-fonts");
    fs.mkdirSync(dir, { recursive: true });
    const conf = path.join(dir, "fonts.conf");
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const alias = (generic, family) => `<alias><family>${generic}</family><prefer><family>${family}</family></prefer></alias>`;
    fs.writeFileSync(
      conf,
      `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>` +
        `<dir>${esc(path.join(ROOT, "assets", "fonts"))}</dir><dir>/usr/share/fonts</dir><dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir>` +
        `<cachedir>${esc(path.join(dir, "cache"))}</cachedir>${alias("sans-serif", "Inter")}${alias("serif", "Playfair Display")}</fontconfig>`,
    );
    process.env.FONTCONFIG_FILE = conf;
  } catch {
    // senza la configurazione si usano i caratteri del sistema
  }
}
let sharpP = null;
/** sharp (elaborazione immagini) si carica solo quando serve. */
export function getSharp() {
  setupFonts();
  sharpP ??= import("sharp").then((m) => m.default).catch((err) => {
    sharpP = null;
    throw new Error(`Manca il componente per le immagini (sharp): ${err.message}. Sul Mac premi 🔄 Aggiorna o riapri il programma.`);
  });
  return sharpP;
}

// ---------- indice ----------

let items = load();
function load() {
  const r = readJsonSafe(INDEX_FILE);
  return Array.isArray(r.data) ? r.data.filter((m) => m && typeof m === "object" && m.id && m.file) : [];
}
function save() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  writeFileAtomic(INDEX_FILE, JSON.stringify(items, null, 2));
}
export const newId = () => `m${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
// Codice esadecimale: non può finire con "-t" (il nome delle anteprime è <codice>-t.jpg).
const newToken = () => crypto.randomBytes(16).toString("hex");

/** Ciò che vedono l'interfaccia e gli agenti (senza percorsi del disco). */
export function publicInfo(m) {
  return {
    id: m.id,
    kind: m.kind,
    mime: m.mime,
    title: m.title ?? "",
    description: m.description ?? "",
    origin: m.origin,
    by: m.by ?? null,
    at: m.at,
    size: m.size,
    width: m.width ?? null,
    height: m.height ?? null,
    ...(m.duration ? { duration: m.duration } : {}),
    src: `/m/${m.token}${m.ext}`,
    thumb: m.thumb ? `/m/${m.token}-t.jpg` : null,
    usedIn: m.usedIn ?? [],
  };
}

export function listMedia({ kind, limit = 200 } = {}) {
  return items
    .filter((m) => !m.hidden && (!kind || m.kind === kind))
    .slice()
    .reverse()
    .slice(0, limit)
    .map(publicInfo);
}

export function getMedia(id) {
  const m = items.find((x) => x.id === id && !x.hidden);
  if (!m) throw new Error(`file ${id} non trovato nell'archivio (usa media_list)`);
  return m;
}
export const mediaPath = (m) => path.join(MEDIA_DIR, m.file);
/** Indirizzo pubblico completo (solo sul server con l'indirizzo pubblico). */
export const publicUrl = (m) => (PUBLIC_URL ? `${PUBLIC_URL}/m/${m.token}${m.ext}` : null);

/** File da servire per /m/<nome>: null se il codice non esiste. */
export function fileForPublicName(name) {
  const main = items.find((x) => `${x.token}${x.ext}` === name);
  if (main) return { file: mediaPath(main), mime: main.mime };
  const thumb = name.endsWith("-t.jpg");
  const token = thumb ? name.slice(0, -6) : name.replace(/\.[a-z0-9]+$/, "");
  const m = items.find((x) => x.token === token);
  if (!m) return null;
  if (thumb) return m.thumb ? { file: path.join(MEDIA_DIR, m.thumb), mime: "image/jpeg" } : null;
  if (name !== `${m.token}${m.ext}`) return null;
  return { file: mediaPath(m), mime: m.mime };
}

export function updateMedia(id, { title, description } = {}) {
  const m = getMedia(id);
  if (title != null) m.title = String(title).trim().slice(0, 120);
  if (description != null) m.description = String(description).trim().slice(0, 1000);
  save();
  return publicInfo(m);
}

export function deleteMedia(id) {
  const m = getMedia(id);
  for (const x of items.filter((y) => y.id === id || y.parent === id)) {
    for (const f of [x.file, x.thumb].filter(Boolean)) fs.rmSync(path.join(MEDIA_DIR, f), { force: true });
  }
  items = items.filter((y) => y.id !== id && y.parent !== id);
  save();
  return { ok: true, deleted: m.id };
}

export function markUsed(ids, label) {
  for (const id of ids) {
    const m = items.find((x) => x.id === id);
    if (m) m.usedIn = [...(m.usedIn ?? []), label].slice(-10);
  }
  save();
}

export function mediaUsage() {
  const visible = items.filter((m) => !m.hidden);
  return { count: visible.length, bytes: items.reduce((n, m) => n + (m.size ?? 0) + (m.thumbSize ?? 0), 0) };
}

/** Spazio libero nel disco dei dati: un caricamento non deve riempirlo (servono anche palazzo e registro). */
export function assertSpace(bytes) {
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const s = fs.statfsSync(MEDIA_DIR);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free - bytes < KEEP_FREE) {
      throw Object.assign(new Error(`Spazio quasi finito sul disco dei dati (liberi ${Math.round(free / 1e6)} MB): elimina qualche video dall'archivio.`), { space: true });
    }
  } catch (err) {
    if (err.space) throw err;
  }
}

// ---------- aggiunta di file ----------

async function addImage(input, { title = "", description = "", origin, by = null, parent = null, hidden = false } = {}) {
  const sharp = await getSharp();
  const id = newId();
  const file = `${id}.jpg`;
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  let info;
  try {
    info = await sharp(input, { failOn: "error" })
      .rotate() // orientamento della foto del telefono
      .resize({ width: 2160, height: 2160, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }) // il JPEG non ha trasparenza
      .jpeg({ quality: 90, mozjpeg: true })
      .toFile(path.join(MEDIA_DIR, file));
  } catch (err) {
    const heic = /heif|heic/i.test(err.message);
    throw new Error(heic
      ? "Formato HEIC dell'iPhone non leggibile: sull'iPhone apri Impostazioni → Fotocamera → Formati → «Più compatibile», oppure condividi la foto come JPEG."
      : `immagine non valida: ${err.message}`);
  }
  const thumb = `${id}-t.jpg`;
  const t = await sharp(path.join(MEDIA_DIR, file)).resize({ width: 480, height: 480, fit: "inside" }).jpeg({ quality: 75 }).toFile(path.join(MEDIA_DIR, thumb));
  const m = {
    id, file, ext: ".jpg", kind: "image", mime: "image/jpeg", token: newToken(), thumb, thumbSize: t.size,
    title: String(title).slice(0, 120), description: String(description).slice(0, 1000), origin, by, at: new Date().toISOString(),
    size: info.size, width: info.width, height: info.height, ...(parent ? { parent } : {}), ...(hidden ? { hidden } : {}),
  };
  items.push(m);
  save();
  return m;
}

/** File caricato dall'utente (già salvato in un file temporaneo): foto → JPEG, video così com'è. */
export async function ingestUpload(tmpFile, { name = "", mime = "", by = "utente" } = {}) {
  const type = String(mime).toLowerCase().split(";")[0].trim();
  const title = path.basename(String(name)).replace(/\.[^.]+$/, "").slice(0, 120);
  try {
    if (VIDEO_TYPES[type]) {
      const size = fs.statSync(tmpFile).size;
      if (size > MAX_VIDEO_BYTES) throw new Error(`video troppo grande (massimo ${MAX_VIDEO_BYTES / 1024 / 1024} MB)`);
      const id = newId();
      const ext = VIDEO_TYPES[type];
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      fs.renameSync(tmpFile, path.join(MEDIA_DIR, `${id}${ext}`));
      const m = { id, file: `${id}${ext}`, ext, kind: "video", mime: type, token: newToken(), title, description: "", origin: "upload", by, at: new Date().toISOString(), size };
      items.push(m);
      save();
      return publicInfo(m);
    }
    if (AUDIO_TYPES[type]) {
      const size = fs.statSync(tmpFile).size;
      if (size > MAX_IMAGE_BYTES) throw new Error(`audio troppo grande (massimo ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`);
      const id = newId();
      const ext = AUDIO_TYPES[type];
      const mime = { ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav" }[ext];
      fs.mkdirSync(MEDIA_DIR, { recursive: true });
      fs.renameSync(tmpFile, path.join(MEDIA_DIR, `${id}${ext}`));
      const m = { id, file: `${id}${ext}`, ext, kind: "audio", mime, token: newToken(), title, description: "", origin: "upload", by, at: new Date().toISOString(), size };
      items.push(m);
      save();
      return publicInfo(m);
    }
    if (!IMAGE_TYPES.includes(type)) throw new Error("formato non supportato: carica foto (JPEG, PNG, WebP), video MP4/MOV o musiche MP3/M4A/WAV");
    return publicInfo(await addImage(tmpFile, { title, origin: "upload", by }));
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

/** Immagine pronta (es. fatta con l'IA). */
export async function addImageBuffer(buf, opts) {
  return publicInfo(await addImage(buf, opts));
}

// ---------- grafiche disegnate dagli agenti ----------

/**
 * Controlla l'SVG scritto da un agente: niente script, niente file o indirizzi esterni.
 * <image href="media:ID"> inserisce una foto dell'archivio.
 */
async function prepareSvg(svg) {
  let s = String(svg ?? "").trim();
  if (!/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(s)) throw new Error("svg: deve iniziare con <svg …>");
  if (s.length > 2_000_000) throw new Error("svg troppo grande (massimo 2 MB)");
  if (/<!(DOCTYPE|ENTITY)|<script|<foreignObject|<[^>]*\son[a-z]+\s*=|@import|url\(\s*['"]?(?!#)/i.test(s)) {
    throw new Error("svg: niente script, DOCTYPE, foreignObject, eventi o risorse esterne (usa solo forme, testo, gradienti e media:ID per le foto)");
  }
  // Fuori dalle scritte (<text>…</text>): niente file locali né caratteri di escape (anche negli stili CSS).
  if (/file:|\\[0-9a-f]/i.test(s.replace(/(<text\b[^>]*>)[\s\S]*?(<\/text>)/gi, "$1$2"))) throw new Error("svg: niente file locali né caratteri di escape nei tag e negli stili");
  // Solo gli href dentro i tag (il testo delle scritte non conta).
  const tags = s.match(/<[^>]+>/g) ?? [];
  const refs = tags.flatMap((t) => [...t.matchAll(/\s(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)].map((m) => m[2]));
  if (tags.some((t) => /\s(?:xlink:)?href\s*=\s*[^"'\s]/i.test(t))) throw new Error("svg: metti gli href tra virgolette");
  for (const r of refs) {
    if (!r.startsWith("#") && !r.startsWith("media:") && !/^data:image\/(png|jpeg|webp);base64,/i.test(r)) {
      throw new Error(`svg: riferimento non permesso "${r.slice(0, 60)}" (usa media:ID per le foto dell'archivio)`);
    }
  }
  const sharp = await getSharp();
  for (const id of new Set(refs.filter((r) => r.startsWith("media:")).map((r) => r.slice(6)))) {
    const m = getMedia(id);
    if (m.kind !== "image") throw new Error(`svg: ${id} è un video, nelle grafiche si possono usare solo foto`);
    const jpg = await sharp(mediaPath(m)).resize({ width: 1600, height: 1600, fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
    s = s.replaceAll(`media:${id}`, `data:image/jpeg;base64,${jpg.toString("base64")}`);
  }
  // Le emoji non hanno un carattere nelle grafiche (diventerebbero quadratini): si tolgono.
  return s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "");
}

/** Disegno SVG di un agente → PNG delle misure indicate (con la trasparenza, per le scritte sopra un video). */
export async function renderSvg(svg, w, h) {
  const sharp = await getSharp();
  const ready = await prepareSvg(svg);
  try {
    return await sharp(Buffer.from(ready), { density: 72, limitInputPixels: 50_000_000 }).resize(w, h, { fit: "cover" }).png().toBuffer();
  } catch (err) {
    throw new Error(`svg non valido: ${err.message}`);
  }
}

export async function createGraphic({ svg, format = "portrait", title = "", description = "", by = null } = {}) {
  const f = FORMATS[format];
  if (!f) throw new Error(`format: ${Object.keys(FORMATS).join(", ")}`);
  const png = await renderSvg(svg, f.w, f.h);
  return publicInfo(await addImage(png, { title: title || "Grafica", description, origin: "graphic", by }));
}

/** Video già pronto nella cartella dell'archivio (montato da video.js), con l'immagine di copertina (JPEG). */
export async function addVideoFile(id, { poster, title = "", description = "", origin = "video", by = null, width, height, duration } = {}) {
  const file = `${id}.mp4`;
  const size = fs.statSync(path.join(MEDIA_DIR, file)).size;
  let thumb = null;
  let thumbSize = 0;
  if (poster) {
    const sharp = await getSharp();
    thumb = `${id}-t.jpg`;
    thumbSize = (await sharp(poster).resize({ width: 480, height: 480, fit: "inside" }).jpeg({ quality: 75 }).toFile(path.join(MEDIA_DIR, thumb))).size;
  }
  const m = {
    id, file, ext: ".mp4", kind: "video", mime: "video/mp4", token: newToken(), ...(thumb ? { thumb, thumbSize } : {}),
    title: String(title).slice(0, 120), description: String(description).slice(0, 1000), origin, by, at: new Date().toISOString(),
    size, width, height, duration,
  };
  items.push(m);
  save();
  return publicInfo(m);
}

/** Foto da mandare all'agente perché la veda (JPEG piccolo in base64). */
export async function imageForModel(id) {
  const m = getMedia(id);
  // Dei video montati si vede la copertina (il primo fotogramma); gli altri video e le musiche non si possono guardare.
  if (m.kind !== "image" && !(m.kind === "video" && m.thumb)) throw new Error(`${id} è un ${m.kind === "audio" ? "audio" : "video"}: gli agenti non possono guardarlo, solo leggerne titolo e descrizione`);
  const sharp = await getSharp();
  const buf = await sharp(m.kind === "image" ? mediaPath(m) : path.join(MEDIA_DIR, m.thumb)).resize({ width: 1024, height: 1024, fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
  return { media: publicInfo(m), base64: buf.toString("base64") };
}

/**
 * File da pubblicare. Per il feed di Instagram una foto deve stare tra 4:5 (verticale) e 1,91:1 (orizzontale):
 * le foto dell'iPhone (3:4) si ritagliano al centro in 4:5, in una copia nascosta.
 */
export async function forPublishing(ids, { network, format } = {}) {
  const out = [];
  for (const id of ids) {
    let m = getMedia(id);
    if (network === "instagram" && format !== "story" && m.kind === "image" && m.width && m.height) {
      const r = m.width / m.height;
      if (r < 0.8 - 0.005 || r > 1.91 + 0.005) {
        const existing = items.find((x) => x.parent === m.id && x.variant === "ig");
        if (existing) m = existing;
        else {
          const sharp = await getSharp();
          const w = r < 0.8 ? m.width : Math.round(m.height * 1.91);
          const h = r < 0.8 ? Math.round(m.width / 0.8) : m.height;
          const buf = await sharp(mediaPath(m)).resize(Math.min(w, m.width), Math.min(h, m.height), { fit: "cover", position: "attention" }).toBuffer();
          m = await addImage(buf, { title: m.title, description: m.description, origin: "variant", parent: m.id, hidden: true });
          m.variant = "ig";
          save();
        }
      }
    }
    out.push({ id: m.id, kind: m.kind, mime: m.mime, path: mediaPath(m), url: publicUrl(m), title: m.title, description: m.description, size: m.size });
  }
  return out;
}

/** Per le prove: rilegge l'indice dal disco. */
export function _reload() {
  items = load();
}
