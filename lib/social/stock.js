// Video e foto di repertorio per i video degli agenti: Pexels (pexels.com), gratis con la chiave dell'utente
// (www.pexels.com/api → «Your API Key»). Licenza Pexels: uso libero anche commerciale, senza obbligo di citare
// l'autore (lo scriviamo comunque nella descrizione del file). Gli agenti cercano (stock_search, con le anteprime
// da guardare) e scelgono cosa scaricare nell'archivio (stock_add): poi lo usano in create_video o nei post.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { call, endpoint } from "./http.js";
import { getSettings, updateSettings } from "../settings.js";
import { MEDIA_DIR, ingestUpload, assertSpace, getSharp, findBySource } from "./media.js";

const API = "https://api.pexels.com";
const MAX_DOWNLOAD = 250 * 1024 * 1024;
const NO_KEY = "I video di repertorio non sono attivi: l'utente deve mettere la chiave gratuita di Pexels in 📣 Social → Video e foto di repertorio.";

export function stockStatus() {
  const key = getSettings().pexelsKey;
  return { configured: Boolean(key), hint: key ? `…${String(key).slice(-4)}` : null };
}

/** Salva la chiave di Pexels dopo averla provata (una richiesta gratuita). Se Pexels non risponde si salva lo stesso. */
export async function setPexelsKey(key) {
  const k = String(key ?? "").replace(/\s+/g, "").replace(/^["'«]+|["'»]+$/g, "");
  if (!k) {
    updateSettings({ pexelsKey: null });
    return stockStatus();
  }
  if (!/^[A-Za-z0-9]{20,100}$/.test(k)) throw new Error("La chiave di Pexels non sembra giusta: copiala di nuovo intera da www.pexels.com/api (pulsante «Copy»).");
  let note = null;
  try {
    await call(`${API}/v1/curated`, { headers: { Authorization: k }, query: { per_page: 1 }, timeoutMs: 15_000 });
  } catch (err) {
    if (err.network) note = "Non ho potuto provarla adesso con Pexels: la proverò alla prima ricerca.";
    else if ([401, 403].includes(err.status)) throw new Error("Pexels dice che la chiave non è valida: copiala di nuovo intera da www.pexels.com/api.");
    else note = `Pexels ha risposto con un errore (${err.message}): la riproverò alla prima ricerca.`;
  }
  updateSettings({ pexelsKey: k });
  return { ...stockStatus(), note };
}

function key() {
  const k = getSettings().pexelsKey;
  if (!k) throw new Error(NO_KEY);
  return k;
}

async function pexels(pathname, query) {
  try {
    return await call(`${API}${pathname}`, { headers: { Authorization: key() }, query, timeoutMs: 30_000 });
  } catch (err) {
    if (err.status === 401 || err.status === 403) throw new Error("Pexels rifiuta la chiave: l'utente deve controllarla in 📣 Social → Video e foto di repertorio.");
    if (err.status === 429) throw new Error("Pexels: troppe ricerche in questo periodo (200 all'ora, 20.000 al mese). Riprova più tardi o usa i file dell'archivio.");
    throw new Error(`Pexels non risponde: ${err.message}`);
  }
}

/** Titolo leggibile dall'indirizzo della pagina (es. .../video/uomo-al-computer-1234/ → "uomo al computer"). */
const titleFromUrl = (u) => decodeURIComponent(String(u ?? "").split("/").filter(Boolean).pop() ?? "").replace(/-?\d+$/, "").replace(/-/g, " ").trim();

const found = new Map(); // id della ricerca (pv123 / pp123) → dettagli per lo scarico
function remember(id, item) {
  found.set(id, item);
  if (found.size > 500) found.delete(found.keys().next().value);
}

/**
 * Cerca video (kind "video") o foto ("photo") di repertorio. orientation: portrait (reel), landscape o square.
 * Restituisce { items, previews }: previews sono le anteprime piccole (JPEG base64) da far guardare all'agente.
 */
export async function searchStock({ query, kind = "video", orientation = "portrait", limit = 6 } = {}) {
  const q = String(query ?? "").trim();
  if (q.length < 2 || q.length > 100) throw new Error("query: scrivi cosa cerchi (2-100 caratteri, meglio in inglese: es. \"business meeting\", \"stock market chart\")");
  const orient = ["portrait", "landscape", "square"].includes(orientation) ? orientation : "portrait";
  const n = Math.min(Math.max(Number(limit) || 6, 1), 8);
  let items;
  if (kind === "photo") {
    const r = await pexels("/v1/search", { query: q, orientation: orient, per_page: n });
    items = (r.photos ?? []).map((p) => {
      const id = `pp${p.id}`;
      remember(id, { kind: "image", url: p.src?.large2x ?? p.src?.original, title: p.alt || titleFromUrl(p.url), author: p.photographer, page: p.url });
      return { id, kind: "photo", title: p.alt || titleFromUrl(p.url), width: p.width, height: p.height, author: p.photographer, preview: p.src?.medium ?? p.src?.small };
    });
  } else {
    const r = await pexels("/videos/search", { query: q, orientation: orient, size: "medium", per_page: n });
    items = (r.videos ?? []).map((v) => {
      const id = `pv${v.id}`;
      remember(id, { kind: "video", files: v.video_files ?? [], title: titleFromUrl(v.url), author: v.user?.name, page: v.url });
      return { id, kind: "video", title: titleFromUrl(v.url), seconds: v.duration, width: v.width, height: v.height, author: v.user?.name, preview: v.image };
    });
  }
  // Anteprime piccole: l'agente le guarda e sceglie (poche centinaia di token l'una).
  const sharp = await getSharp();
  const previews = [];
  for (const it of items) {
    if (!it.preview) continue;
    try {
      const res = await fetch(endpoint(it.preview), { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) continue;
      const buf = await sharp(Buffer.from(await res.arrayBuffer())).resize({ width: 320, height: 320, fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
      previews.push({ id: it.id, base64: buf.toString("base64") });
    } catch {
      // anteprima non disponibile: l'agente ha comunque il titolo
    }
  }
  return { items: items.map(({ preview, ...it }) => it), previews };
}

/** Il file video più adatto: mp4, lato lungo vicino a 1920 senza arrivare al 4K (più pesante e lento da montare). */
function bestFile(files) {
  const mp4 = files.filter((f) => /mp4/i.test(f.file_type ?? "") && f.link && f.width && f.height);
  const long = (f) => Math.max(f.width, f.height);
  const ok = mp4.filter((f) => long(f) <= 2048).sort((a, b) => long(b) - long(a));
  return ok[0] ?? mp4.sort((a, b) => long(a) - long(b))[0] ?? null;
}

async function download(url, file) {
  let res;
  try {
    res = await fetch(endpoint(url), { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  } catch {
    throw new Error("scaricamento da Pexels non riuscito: riprova più tardi");
  }
  if (!res.ok || !res.body) throw new Error(`scaricamento da Pexels non riuscito (HTTP ${res.status})`);
  const size = Number(res.headers.get("content-length")) || 0;
  if (size > MAX_DOWNLOAD) throw new Error("file troppo grande: scegli un video più corto");
  assertSpace(size || 50 * 1024 * 1024);
  let got = 0;
  await pipeline(Readable.fromWeb(res.body), async function* (src) {
    for await (const chunk of src) {
      got += chunk.length;
      if (got > MAX_DOWNLOAD) throw new Error("file troppo grande: scegli un video più corto");
      yield chunk;
    }
  }, fs.createWriteStream(file));
  return res.headers.get("content-type") ?? "";
}

/** Scarica nell'archivio un risultato di stock_search (id pv… o pp…). Se c'è già, restituisce quello. */
export async function addStock(id, { by = null } = {}) {
  const sid = String(id ?? "");
  const already = findBySource(`pexels:${sid}`);
  if (already) return { ...already, already: true };
  const it = found.get(sid);
  if (!it) throw new Error(`${sid}: non lo trovo tra le ricerche recenti, cercalo prima con stock_search`);
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const tmp = path.join(MEDIA_DIR, `.stock-${crypto.randomUUID()}`);
  try {
    const credit = `${it.kind === "video" ? "Video" : "Foto"} di ${it.author || "un autore"} su Pexels (licenza Pexels: uso libero)`;
    const title = (it.title || (it.kind === "video" ? "Video di repertorio" : "Foto di repertorio")).slice(0, 100);
    if (it.kind === "video") {
      const f = bestFile(it.files);
      if (!f) throw new Error(`${sid}: nessun file MP4 disponibile, scegline un altro`);
      await download(f.link, tmp);
      return await ingestUpload(tmp, { name: `${title}.mp4`, mime: "video/mp4", by, origin: "stock", source: `pexels:${sid}`, description: `${title}. ${credit}`, width: f.width, height: f.height });
    }
    await download(it.url, tmp);
    return await ingestUpload(tmp, { name: `${title}.jpg`, mime: "image/jpeg", by, origin: "stock", source: `pexels:${sid}`, description: `${title}. ${credit}` });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
