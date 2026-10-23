// Leggere il web senza chiavi: notizie dai feed RSS/Atom (strumento read_feeds) e il testo pulito di una pagina o di un
// PDF (strumento read_page). Idea presa da Agent Reach (github.com/Panniantong/agent-reach, licenza MIT), fatta qui in
// Node senza programmi esterni (per i PDF serve pdftotext, nel Dockerfile).
// Sicurezza: gli indirizzi li scelgono gli agenti, quindi niente indirizzi interni (localhost, reti private, metadati del
// cloud), solo http/https, redirect controllati uno per uno, risposte con un limite di dimensione.
// READER_API_BASE (solo per le prove): https://host/percorso → <READER_API_BASE>/host/percorso.
import dns from "node:dns/promises";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const FAKE = process.env.READER_API_BASE?.replace(/\/+$/, "");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CACHE_MS = 15 * 60_000;
const cache = new Map(); // chiave → { at, value }

/** Fonti già pronte (nome → indirizzo). Le pagine principali si leggono cercando il loro link RSS. Da verificare dal vero. */
export const FEED_PRESETS = {
  "ansa-economia": "https://www.ansa.it/sito/notizie/economia/economia_rss.xml",
  "sole24ore-economia": "https://www.ilsole24ore.com/rss/economia.xml",
  "sole24ore-finanza": "https://www.ilsole24ore.com/rss/finanza.xml",
  "sole24ore-norme-tributi": "https://www.ilsole24ore.com/rss/norme-e-tributi.xml",
  invitalia: "https://www.invitalia.it",
  mimit: "https://www.mimit.gov.it",
  "gazzetta-ufficiale": "https://www.gazzettaufficiale.it",
  "agenzia-entrate": "https://www.agenziaentrate.gov.it",
};

// ------------------------------------------------------------------ scaricare in sicurezza

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateIp(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || /^fe[89ab]/.test(v);
}

async function checkUrl(u) {
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("solo indirizzi http o https");
  if (u.username || u.password) throw new Error("indirizzo con nome utente o password: non permesso");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|arpa)$/.test(host) || !host.includes(".") && !net.isIP(host)) {
    throw new Error("indirizzi interni non permessi");
  }
  if (net.isIP(host)) {
    if (privateIp(host)) throw new Error("indirizzi interni non permessi");
    return;
  }
  if (FAKE) return; // nelle prove i nomi non si risolvono
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`${host}: sito inesistente o non raggiungibile`);
  }
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error("indirizzi interni non permessi");
}

/** GET con redirect controllati e limite di dimensione. Restituisce { url, type, buf }. */
export async function safeFetch(url, { maxBytes = 3_000_000, accept = "*/*" } = {}) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    throw new Error("url: indirizzo non valido (deve iniziare con https://)");
  }
  for (let hop = 0; hop < 6; hop++) {
    await checkUrl(u);
    const target = FAKE ? `${FAKE}/${u.host}${u.pathname}${u.search}` : u.toString();
    let res;
    try {
      res = await fetch(target, { redirect: "manual", headers: { "user-agent": UA, accept, "accept-language": "it-IT,it;q=0.9,en;q=0.6" }, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new Error(`${u.host} non raggiungibile (${err.name === "TimeoutError" ? "nessuna risposta in tempo" : err.cause?.code ?? err.message})`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`${u.host}: redirect senza indirizzo`);
      u = new URL(loc, u);
      continue;
    }
    if (!res.ok) throw new Error(`${u.host}: HTTP ${res.status}${res.status === 403 || res.status === 429 ? " (il sito blocca le richieste automatiche)" : ""}`);
    const chunks = [];
    let size = 0;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        if (!chunks.length) throw new Error("file troppo grande");
        break;
      }
      chunks.push(value);
    }
    return { url: u.toString(), type: res.headers.get("content-type") ?? "", buf: Buffer.concat(chunks), truncated: size > maxBytes };
  }
  throw new Error("troppi redirect");
}

/** Testo con la codifica giusta (molti siti italiani usano ancora ISO-8859-1 o Windows-1252). */
function decode(buf, type) {
  const head = buf.subarray(0, 2048).toString("latin1");
  const cs = (type.match(/charset=([\w-]+)/i)?.[1] ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? head.match(/encoding=["']([\w-]+)/i)?.[1] ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

// ------------------------------------------------------------------ HTML → testo

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", egrave: "è", eacute: "é", agrave: "à", aacute: "á", igrave: "ì", ograve: "ò", oacute: "ó", ugrave: "ù", Egrave: "È", Eacute: "É", Agrave: "À", euro: "€", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", deg: "°", copy: "©", reg: "®", middot: "·", bull: "•", times: "×", sect: "§", ordm: "º", ordf: "ª" };
export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

const tidy = (s) => s.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** Testo leggibile di un pezzo di HTML: a capo dove servono, elenchi con il trattino, niente tag. */
export function htmlToText(html) {
  let s = String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|form|button|select|canvas)\b[\s\S]*?<\/\1>/gi, " ");
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<h[1-6]\b[^>]*>/gi, "\n\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|ul|ol|table|blockquote|dd|dt|figcaption)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  return tidy(decodeEntities(s));
}

const attr = (tag, name) => decodeEntities(tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(2).find((x) => x != null) ?? "");
const meta = (html, key) => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const k = (attr(tag, "property") || attr(tag, "name") || attr(tag, "itemprop")).toLowerCase();
    if (k === key) return attr(tag, "content").trim();
  }
  return "";
};

/** Parte principale della pagina: <article> più lungo, poi <main>, poi il corpo senza menu, testate e piè di pagina. */
function mainHtml(html) {
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const clean = body.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const articles = [...clean.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map((m) => m[1]);
  const best = articles.sort((a, b) => b.length - a.length)[0];
  if (best && htmlToText(best).length > 400) return best;
  const main = clean.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (main && htmlToText(main).length > 200) return main;
  return clean;
}

const DOC_LINK = /\.(pdf|docx?|xlsx?|odt|zip)(\?|#|$)|bando|decreto|avviso|allegat|scarica|download|modulistica|faq|graduatori|circolare|regolamento/i;

function pageLinks(html, base) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(`<a ${m[1]}>`, "href");
    if (!href || href.startsWith("#") || /^(javascript|mailto|tel):/i.test(href)) continue;
    let abs;
    try {
      abs = new URL(href, base).toString();
    } catch {
      continue;
    }
    const text = htmlToText(m[2]).replace(/\s+/g, " ").slice(0, 120);
    if (!DOC_LINK.test(abs) && !DOC_LINK.test(text)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ testo: text || path.basename(new URL(abs).pathname), url: abs });
    if (out.length >= 15) break;
  }
  return out;
}

// ------------------------------------------------------------------ PDF

function pdfText(buf) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agenti-pdf-"));
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, buf);
    execFile(process.env.PDFTOTEXT_PATH || "pdftotext", ["-enc", "UTF-8", "-l", "40", file, "-"], { timeout: 30_000, maxBuffer: 20_000_000 }, (err, stdout) => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (err) resolve(err.code === "ENOENT" ? { missing: true } : { error: err.message });
      else resolve({ text: tidy(String(stdout).replace(/\f/g, "\n\n")) });
    });
  });
}

// ------------------------------------------------------------------ read_page

/** Testo pulito di una pagina web o di un PDF, a pezzi (max_chars, from) per le pagine lunghe. */
export async function readPage(input = {}) {
  const url = String(input.url ?? "").trim();
  if (!url) throw new Error("url: l'indirizzo della pagina o del PDF (https://…)");
  const max = Math.min(Math.max(Math.round(Number(input.max_chars) || 8000), 1000), 20_000);
  const from = Math.max(Math.round(Number(input.from) || 0), 0);
  const key = `page:${url}`;
  let doc = cache.get(key)?.at > Date.now() - CACHE_MS ? cache.get(key).value : null;
  if (!doc) {
    const r = await safeFetch(url, { maxBytes: 15_000_000, accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5" });
    const isPdf = /application\/pdf/i.test(r.type) || r.buf.subarray(0, 5).toString("latin1") === "%PDF-";
    if (isPdf) {
      const p = await pdfText(r.buf);
      if (p.missing) throw new Error("è un PDF, ma su questo server manca il programma per leggerlo (pdftotext)");
      if (p.error || !p.text) throw new Error(`PDF non leggibile${p.error ? ` (${p.error.slice(0, 120)})` : ": forse è una scansione senza testo"}`);
      doc = { tipo: "pdf", url: r.url, titolo: path.basename(new URL(r.url).pathname), testo: p.text, collegamenti: [] };
    } else if (/html|xml|text\/plain/i.test(r.type) || !r.type) {
      const html = decode(r.buf, r.type);
      if (/text\/plain/i.test(r.type)) {
        doc = { tipo: "testo", url: r.url, titolo: "", testo: tidy(html), collegamenti: [] };
      } else {
        const titolo = (meta(html, "og:title") || decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")).replace(/\s+/g, " ").trim();
        const timeTag = html.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1] ?? "";
        doc = {
          tipo: "pagina",
          url: r.url,
          titolo,
          sito: meta(html, "og:site_name") || new URL(r.url).hostname,
          pubblicato: (meta(html, "article:published_time") || meta(html, "datepublished") || timeTag).slice(0, 25) || undefined,
          aggiornato: (meta(html, "article:modified_time") || meta(html, "datemodified")).slice(0, 25) || undefined,
          descrizione: meta(html, "description") || meta(html, "og:description") || undefined,
          testo: htmlToText(mainHtml(html)),
          collegamenti: pageLinks(html, r.url),
        };
      }
    } else {
      throw new Error(`tipo di file non leggibile (${r.type.split(";")[0]}): solo pagine web, testo e PDF`);
    }
    if (r.truncated) doc.avviso = "file molto grande: letto solo l'inizio";
    cache.set(key, { at: Date.now(), value: doc });
  }
  const { testo, ...rest } = doc;
  const piece = testo.slice(from, from + max);
  return {
    ...rest,
    testo: piece || "(nessun testo leggibile: la pagina forse si costruisce con JavaScript; prova il suo PDF o un'altra fonte)",
    caratteri_totali: testo.length,
    ...(from + max < testo.length ? { continua_da: from + max, nota: `testo accorciato: per il resto richiama read_page con from ${from + max}` } : {}),
    ...(rest.collegamenti?.length ? {} : { collegamenti: undefined }),
  };
}

// ------------------------------------------------------------------ read_feeds

const inner = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1") : "";
};

/** Elementi di un feed RSS 2.0, RSS 1.0 (RDF) o Atom. */
export function parseFeed(xml) {
  const isAtom = /<feed\b/i.test(xml) && !/<rss\b/i.test(xml);
  const title = htmlToText(inner(xml.replace(/<(item|entry)\b[\s\S]*$/i, ""), "title"));
  const blocks = [...xml.matchAll(isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const items = blocks.map((b) => {
    let link = "";
    if (isAtom) {
      const links = b.match(/<link\b[^>]*>/gi) ?? [];
      const alt = links.find((l) => !/rel=/i.test(l) || /rel=["']alternate["']/i.test(l)) ?? links[0] ?? "";
      link = attr(alt, "href");
    } else {
      link = htmlToText(inner(b, "link")) || attr(b.match(/<link\b[^>]*>/i)?.[0] ?? "", "href") || htmlToText(inner(b, "guid"));
    }
    const dateRaw = htmlToText(inner(b, "pubDate") || inner(b, "dc:date") || inner(b, "published") || inner(b, "updated"));
    const t = Date.parse(dateRaw);
    const summary = htmlToText(inner(b, "description") || inner(b, "summary") || inner(b, "content:encoded") || inner(b, "content"));
    return { titolo: htmlToText(inner(b, "title")), link: link.trim(), data: Number.isNaN(t) ? null : new Date(t).toISOString(), sommario: summary };
  });
  return { title, items };
}

/** Link al feed RSS/Atom dichiarato nella pagina principale di un sito. */
function discoverFeed(html, base) {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (/rel=["']?alternate/i.test(tag) && /application\/(rss|atom)\+xml/i.test(tag)) {
      const href = attr(tag, "href");
      if (href) return new URL(href, base).toString();
    }
  }
  return null;
}

async function loadFeed(source) {
  const url = FEED_PRESETS[source] ?? source;
  const key = `feed:${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let r = await safeFetch(url, { accept: "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,text/html;q=0.5" });
  let text = decode(r.buf, r.type);
  if (!/<(rss|feed|rdf:RDF)\b/i.test(text)) {
    const found = discoverFeed(text, r.url);
    if (!found) throw new Error("nessun feed RSS trovato in questa pagina: serve l'indirizzo del feed (spesso finisce con /rss o .xml)");
    r = await safeFetch(found, { accept: "application/rss+xml,application/atom+xml,application/xml,text/xml" });
    text = decode(r.buf, r.type);
    if (!/<(rss|feed|rdf:RDF)\b/i.test(text)) throw new Error("il link RSS della pagina non porta a un feed valido");
  }
  const value = { ...parseFeed(text), url: r.url };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Ultime notizie di uno o più feed (nomi delle fonti pronte o indirizzi), più recenti prima, filtrate per parole. */
export async function readFeeds(input = {}) {
  const feeds = [...new Set([].concat(input.feeds ?? []).flatMap((f) => String(f).split(/[\s,]+/)).map((f) => f.trim()).filter(Boolean))];
  if (!feeds.length) throw new Error(`feeds: nomi delle fonti pronte (${Object.keys(FEED_PRESETS).join(", ")}) o indirizzi di feed RSS`);
  if (feeds.length > 8) throw new Error("feeds: al massimo 8 fonti per volta");
  const days = Math.min(Math.max(Math.round(Number(input.days) || 7), 1), 60);
  const limit = Math.min(Math.max(Math.round(Number(input.limit) || 15), 1), 40);
  const words = String(input.query ?? "").toLowerCase().split(/[\s,]+/).filter((w) => w.length > 2);
  const since = Date.now() - days * 86_400_000;
  const all = [];
  const errori = {};
  const fonti = {};
  await Promise.all(
    feeds.map(async (f) => {
      try {
        const feed = await loadFeed(f);
        fonti[f] = feed.title || new URL(feed.url).hostname;
        for (const it of feed.items) {
          if (it.data && Date.parse(it.data) < since) continue;
          const hay = `${it.titolo} ${it.sommario}`.toLowerCase();
          if (words.length && !words.some((w) => hay.includes(w))) continue;
          all.push({ fonte: fonti[f], titolo: it.titolo, data: it.data ?? undefined, link: it.link, sommario: it.sommario.length > 300 ? `${it.sommario.slice(0, 300)}…` : it.sommario });
        }
      } catch (err) {
        errori[f] = err.message;
      }
    }),
  );
  all.sort((a, b) => (Date.parse(b.data ?? 0) || 0) - (Date.parse(a.data ?? 0) || 0));
  return {
    giorni: days,
    ...(words.length ? { filtro: words.join(" ") } : {}),
    notizie: all.slice(0, limit),
    ...(all.length > limit ? { altre: all.length - limit } : {}),
    ...(Object.keys(errori).length ? { errori } : {}),
    come_continuare: "Per leggere un articolo o un bando per intero usa read_page con il suo link.",
  };
}

/** Per le prove. */
export function _resetReader() {
  cache.clear();
}
