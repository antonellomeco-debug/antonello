// Video e foto di repertorio per i video degli agenti, gratis con la chiave dell'utente:
// - Pixabay (pixabay.com/api/docs, la chiave compare dopo l'accesso) — licenza Pixabay: uso libero anche commerciale;
// - Pexels (www.pexels.com/api) — licenza Pexels: uso libero anche commerciale.
// Nessuna delle due obbliga a citare l'autore (lo scriviamo comunque nella descrizione del file). Con entrambe le chiavi
// i risultati si mescolano. Gli agenti cercano (stock_search, con le anteprime da guardare) e scelgono cosa scaricare
// nell'archivio (stock_add): poi lo usano in create_video o nei post. Le ricerche si ricordano per 24 ore (lo chiede
// Pixabay) e i file si scaricano sul nostro server (niente link diretti ai loro siti).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { call, endpoint } from "./http.js";
import { getSettings, updateSettings } from "../settings.js";
import { MEDIA_DIR, ingestUpload, assertSpace, getSharp, findBySource } from "./media.js";

const PEXELS = "https://api.pexels.com";
const PIXABAY = "https://pixabay.com/api";
const MAX_DOWNLOAD = 250 * 1024 * 1024;
const DAY = 24 * 3600_000;
const NO_KEY = "I video di repertorio non sono attivi: l'utente deve mettere la chiave gratuita di Pixabay (o di Pexels) in 📣 Social → Video e foto di repertorio.";
const PROVIDERS = {
  pixabay: { label: "Pixabay", setting: "pixabayKey", site: "pixabay.com/api/docs" },
  pexels: { label: "Pexels", setting: "pexelsKey", site: "www.pexels.com/api" },
};

const hint = (k) => (k ? `…${String(k).slice(-4)}` : null);
export function stockStatus() {
  const s = getSettings();
  const out = { configured: Boolean(s.pixabayKey || s.pexelsKey) };
  for (const [id, p] of Object.entries(PROVIDERS)) out[id] = { configured: Boolean(s[p.setting]), hint: hint(s[p.setting]) };
  return out;
}

/** Salva la chiave di un servizio dopo averla provata (una ricerca gratuita). Se il servizio non risponde si salva lo stesso. */
export async function setStockKey(provider, key) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error("servizio sconosciuto: pixabay o pexels");
  const k = String(key ?? "").replace(/\s+/g, "").replace(/^["'«]+|["'»]+$/g, "");
  if (!k) {
    updateSettings({ [p.setting]: null });
    return stockStatus();
  }
  if (!/^[A-Za-z0-9-]{20,100}$/.test(k)) throw new Error(`La chiave di ${p.label} non sembra giusta: copiala di nuovo intera da ${p.site}.`);
  let note = null;
  try {
    if (provider === "pexels") await call(`${PEXELS}/v1/curated`, { headers: { Authorization: k }, query: { per_page: 1 }, timeoutMs: 15_000 });
    else await call(`${PIXABAY}/`, { query: { key: k, q: "office", per_page: 3 }, timeoutMs: 15_000 });
  } catch (err) {
    if (err.network) note = `Non ho potuto provarla adesso con ${p.label}: la proverò alla prima ricerca.`;
    else if ([400, 401, 403].includes(err.status)) throw new Error(`${p.label} dice che la chiave non è valida: copiala di nuovo intera da ${p.site}.`);
    else note = `${p.label} ha risposto con un errore (${err.message}): la riproverò alla prima ricerca.`;
  }
  updateSettings({ [p.setting]: k });
  return { ...stockStatus(), note };
}
export const setPexelsKey = (key) => setStockKey("pexels", key);
export const setPixabayKey = (key) => setStockKey("pixabay", key);

async function ask(provider, url, opts) {
  const p = PROVIDERS[provider];
  try {
    return await call(url, { ...opts, timeoutMs: 30_000 });
  } catch (err) {
    if ([400, 401, 403].includes(err.status) && (provider === "pexels" || /key/i.test(err.message))) {
      throw new Error(`${p.label} rifiuta la chiave: l'utente deve controllarla in 📣 Social → Video e foto di repertorio.`);
    }
    if (err.status === 429) throw new Error(`${p.label}: troppe ricerche in questo momento. Riprova tra qualche minuto o usa i file dell'archivio.`);
    throw new Error(`${p.label} non risponde: ${err.message}`);
  }
}

/** Titolo leggibile dall'indirizzo della pagina (es. .../video/uomo-al-computer-1234/ → "uomo al computer"). */
const titleFromUrl = (u) => decodeURIComponent(String(u ?? "").split("/").filter(Boolean).pop() ?? "").replace(/-?\d+$/, "").replace(/-/g, " ").trim();

const found = new Map(); // id della ricerca (pv123, pp123, xv123, xp123) → dettagli per lo scarico
function remember(id, item) {
  found.set(id, item);
  if (found.size > 1000) found.delete(found.keys().next().value);
}
const cache = new Map(); // ricerche delle ultime 24 ore
async function cached(keyParts, fn) {
  const k = JSON.stringify(keyParts);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < DAY) return hit.items;
  const items = await fn();
  cache.set(k, { at: Date.now(), items });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return items;
}

async function searchPexels(q, kind, orient, n, k) {
  if (kind === "photo") {
    const r = await ask("pexels", `${PEXELS}/v1/search`, { headers: { Authorization: k }, query: { query: q, orientation: orient, per_page: n } });
    return (r.photos ?? []).map((p) => ({
      id: `pp${p.id}`, kind: "photo", title: p.alt || titleFromUrl(p.url), width: p.width, height: p.height, author: p.photographer, source: "Pexels",
      preview: p.src?.medium ?? p.src?.small, get: { kind: "image", url: p.src?.large2x ?? p.src?.original },
    }));
  }
  const r = await ask("pexels", `${PEXELS}/videos/search`, { headers: { Authorization: k }, query: { query: q, orientation: orient, size: "medium", per_page: n } });
  return (r.videos ?? []).map((v) => ({
    id: `pv${v.id}`, kind: "video", title: titleFromUrl(v.url), seconds: v.duration, width: v.width, height: v.height, author: v.user?.name, source: "Pexels",
    preview: v.image, get: { kind: "video", files: (v.video_files ?? []).map((f) => ({ link: f.link, width: f.width, height: f.height, type: f.file_type })) },
  }));
}

async function searchPixabay(q, kind, orient, n, k) {
  if (kind === "photo") {
    const orientation = orient === "portrait" ? "vertical" : orient === "landscape" ? "horizontal" : "all";
    const r = await ask("pixabay", `${PIXABAY}/`, { query: { key: k, q, image_type: "photo", orientation, safesearch: "true", per_page: Math.max(3, n) } });
    return (r.hits ?? []).slice(0, n).map((h) => ({
      id: `xp${h.id}`, kind: "photo", title: h.tags ?? "", width: h.imageWidth, height: h.imageHeight, author: h.user, source: "Pixabay",
      preview: h.webformatURL ?? h.previewURL, get: { kind: "image", url: h.largeImageURL ?? h.webformatURL },
    }));
  }
  // I video di Pixabay non si filtrano per orientamento: se ne chiedono di più e si mettono prima quelli adatti.
  const r = await ask("pixabay", `${PIXABAY}/videos/`, { query: { key: k, q, video_type: "film", safesearch: "true", per_page: Math.min(50, Math.max(20, n * 3)) } });
  const fits = (w, h) => (orient === "portrait" ? h > w : orient === "landscape" ? w > h : Math.abs(w - h) < Math.min(w, h) * 0.3);
  return (r.hits ?? [])
    .map((h) => {
      const sizes = Object.values(h.videos ?? {}).filter((f) => f?.url);
      const big = sizes.sort((a, b) => b.width - a.width)[0] ?? {};
      return {
        id: `xv${h.id}`, kind: "video", title: h.tags ?? "", seconds: h.duration, width: big.width, height: big.height, author: h.user, source: "Pixabay",
        preview: sizes.find((f) => f.thumbnail)?.thumbnail ?? (h.picture_id ? `https://i.vimeocdn.com/video/${h.picture_id}_640x360.jpg` : null),
        get: { kind: "video", files: sizes.map((f) => ({ link: f.url, width: f.width, height: f.height, type: "video/mp4" })) },
      };
    })
    .sort((a, b) => Number(fits(b.width, b.height)) - Number(fits(a.width, a.height)))
    .slice(0, n);
}

/**
 * Cerca video (kind "video") o foto ("photo") di repertorio. orientation: portrait (reel), landscape o square.
 * Restituisce { items, previews }: previews sono le anteprime piccole (JPEG base64) da far guardare all'agente.
 */
export async function searchStock({ query, kind = "video", orientation = "portrait", limit = 6 } = {}) {
  const q = String(query ?? "").trim();
  if (q.length < 2 || q.length > 100) throw new Error("query: scrivi cosa cerchi (2-100 caratteri, meglio in inglese: es. \"business meeting\", \"stock market chart\")");
  const s = getSettings();
  const keys = { pixabay: s.pixabayKey, pexels: s.pexelsKey };
  const active = Object.keys(keys).filter((p) => keys[p]);
  if (!active.length) throw new Error(NO_KEY);
  const orient = ["portrait", "landscape", "square"].includes(orientation) ? orientation : "portrait";
  const k2 = kind === "photo" ? "photo" : "video";
  const n = Math.min(Math.max(Number(limit) || 6, 1), 8);
  const lists = [];
  const errors = [];
  for (const p of active) {
    try {
      lists.push(await cached([p, k2, q.toLowerCase(), orient, n], () => (p === "pexels" ? searchPexels : searchPixabay)(q, k2, orient, n, keys[p])));
    } catch (err) {
      errors.push(err);
    }
  }
  if (!lists.length) throw errors[0];
  // Con due servizi i risultati si alternano (più varietà).
  const all = [];
  for (let i = 0; all.length < n && lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i] && all.length < n) all.push(l[i]);
  for (const it of all) remember(it.id, { ...it.get, title: it.title, author: it.author, source: it.source });
  // Anteprime piccole: l'agente le guarda e sceglie (poche centinaia di token l'una).
  const sharp = await getSharp();
  const previews = [];
  for (const it of all) {
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
  return { items: all.map(({ preview, get, ...it }) => it), previews };
}

/** Il file video più adatto: mp4, lato lungo vicino a 1920 senza arrivare al 4K (più pesante e lento da montare). */
function bestFile(files) {
  const mp4 = files.filter((f) => /mp4/i.test(f.type ?? "") && f.link && f.width && f.height);
  const long = (f) => Math.max(f.width, f.height);
  const ok = mp4.filter((f) => long(f) <= 2048).sort((a, b) => long(b) - long(a));
  return ok[0] ?? mp4.sort((a, b) => long(a) - long(b))[0] ?? null;
}

async function download(url, file, label) {
  let res;
  try {
    res = await fetch(endpoint(url), { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  } catch {
    throw new Error(`scaricamento da ${label} non riuscito: riprova più tardi`);
  }
  if (!res.ok || !res.body) throw new Error(`scaricamento da ${label} non riuscito (HTTP ${res.status})`);
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
}

/** Scarica nell'archivio un risultato di stock_search (id pv…, pp…, xv…, xp…). Se c'è già, restituisce quello. */
export async function addStock(id, { by = null } = {}) {
  const sid = String(id ?? "");
  const tag = (sid.startsWith("x") ? "pixabay:" : "pexels:") + sid;
  const already = findBySource(tag);
  if (already) return { ...already, already: true };
  const it = found.get(sid);
  if (!it) throw new Error(`${sid}: non lo trovo tra le ricerche recenti, cercalo prima con stock_search`);
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const tmp = path.join(MEDIA_DIR, `.stock-${crypto.randomUUID()}`);
  try {
    const credit = `${it.kind === "video" ? "Video" : "Foto"} di ${it.author || "un autore"} su ${it.source} (licenza ${it.source}: uso libero)`;
    const title = (it.title || (it.kind === "video" ? "Video di repertorio" : "Foto di repertorio")).slice(0, 100);
    if (it.kind === "video") {
      const f = bestFile(it.files);
      if (!f) throw new Error(`${sid}: nessun file MP4 disponibile, scegline un altro`);
      await download(f.link, tmp, it.source);
      return await ingestUpload(tmp, { name: `${title}.mp4`, mime: "video/mp4", by, origin: "stock", source: tag, description: `${title}. ${credit}`, width: f.width, height: f.height });
    }
    await download(it.url, tmp, it.source);
    return await ingestUpload(tmp, { name: `${title}.jpg`, mime: "image/jpeg", by, origin: "stock", source: tag, description: `${title}. ${credit}` });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
