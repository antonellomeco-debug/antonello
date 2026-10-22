// «Ascolta la rete»: cosa dice la gente negli ultimi giorni su un argomento, da fonti pubbliche e gratuite.
// Idea presa da last30days (github.com/mvanhorn/last30days-skill, licenza MIT), ridotta alle fonti che non chiedono
// chiavi: Reddit (archivio pubblico arctic-shift), Polymarket (scommesse con soldi veri), Hacker News (Algolia),
// StockTwits (umore dei trader su un titolo) e YouTube (con il canale già collegato in 📣 Social).
// BUZZ_API_BASE (solo per le prove): https://host/percorso → <BUZZ_API_BASE>/host/percorso.
import * as social from "./social/index.js";

const FAKE = process.env.BUZZ_API_BASE?.replace(/\/+$/, "");
const UA = "Mozilla/5.0 (compatible; agenti-venturo/1.0)";
export const SOURCES = ["reddit", "polymarket", "hackernews", "stocktwits", "youtube"];
const CACHE_MS = 30 * 60_000;
const cache = new Map(); // chiave → { at, value }
// YouTube: ogni ricerca costa 100 delle 10.000 unità al giorno del progetto Google (che servono anche per caricare i video).
const YT_PER_DAY = 20;
const ytUse = { day: "", n: 0 };

async function getJson(url, query = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) if (v != null && v !== "") u.searchParams.set(k, String(v));
  const target = FAKE ? `${FAKE}/${u.host}${u.pathname}${u.search}` : u.toString();
  let res;
  try {
    res = await fetch(target, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(`${u.host} non raggiungibile (${err.name === "TimeoutError" ? "nessuna risposta in tempo" : err.cause?.code ?? err.message})`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // pagina HTML (blocco, captcha): sotto diventa un errore
  }
  if (!res.ok) throw new Error(`${u.host}: HTTP ${res.status}${res.status === 403 || res.status === 429 ? " (blocca le richieste dal server: riprova più tardi)" : ""}`);
  if (data == null || typeof data !== "object") throw new Error(`${u.host}: risposta non valida`);
  return data;
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const pct = (x) => Math.round(num(x) * 1000) / 10;
const parseList = (x) => {
  if (Array.isArray(x)) return x;
  try {
    const v = JSON.parse(x ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** Reddit dall'archivio pubblico arctic-shift (reddit.com blocca le richieste senza chiave dai server). */
async function reddit({ query, days, limit, subreddits }) {
  const after = isoDay(Date.now() - days * 86_400_000);
  const base = "https://arctic-shift.photon-reddit.com/api/posts/search";
  const rows = [];
  if (subreddits.length) {
    for (const sub of subreddits) rows.push(...((await getJson(base, { subreddit: sub, query, after, limit: 100, sort: "desc" })).data ?? []));
  } else {
    rows.push(...((await getJson(base, { title: query, after, limit: 100, sort: "desc" })).data ?? []));
  }
  const seen = new Set();
  const items = rows
    .filter((r) => r && r.id && !seen.has(r.id) && seen.add(r.id) && !["[removed]", "[deleted]"].includes(r.selftext))
    .sort((a, b) => num(b.score) + num(b.num_comments) - (num(a.score) + num(a.num_comments)))
    .slice(0, limit)
    .map((r) => ({
      titolo: clip(r.title, 200),
      subreddit: r.subreddit ? `r/${r.subreddit}` : undefined,
      punti: num(r.score),
      commenti: num(r.num_comments),
      data: r.created_utc ? isoDay(num(r.created_utc) * 1000) : undefined,
      testo: r.selftext ? clip(r.selftext, 300) : undefined,
      link: r.permalink ? `https://www.reddit.com${r.permalink}` : r.url,
    }));
  return { items, nota: "punti e commenti sono quelli registrati dall'archivio: per i post degli ultimi 2–3 giorni sono più bassi del vero" };
}

/** Polymarket: probabilità che il mercato dà a un evento (persone che scommettono soldi veri). */
async function polymarket({ query, limit }) {
  const r = await getJson("https://gamma-api.polymarket.com/public-search", { q: query, events_status: "active", keep_closed_markets: "0" });
  const events = (r.events ?? []).filter((e) => e && !e.closed && e.active !== false);
  events.sort((a, b) => num(b.volume1mo ?? b.volume) - num(a.volume1mo ?? a.volume));
  const items = events.slice(0, limit).map((e) => {
    const markets = (e.markets ?? []).filter((m) => m && !m.closed && m.active !== false).sort((a, b) => num(b.volume) - num(a.volume)).slice(0, 4);
    return {
      evento: clip(e.title, 160),
      mercati: markets.map((m) => {
        const outcomes = parseList(m.outcomes);
        return {
          domanda: clip(m.question ?? e.title, 160),
          probabilita: parseList(m.outcomePrices).map((p, i) => ({ esito: String(outcomes[i] ?? `esito ${i + 1}`), pct: pct(p) })),
          ...(m.oneWeekPriceChange != null ? { variazione_settimana_punti: pct(m.oneWeekPriceChange) } : {}),
          ...(m.endDate ? { scadenza: String(m.endDate).slice(0, 10) } : {}),
        };
      }),
      volume_mese_usd: Math.round(num(e.volume1mo)),
      link: e.slug ? `https://polymarket.com/event/${e.slug}` : undefined,
    };
  });
  return { items, nota: "probabilità = prezzo delle scommesse (0–100 %), non una certezza" };
}

/** Hacker News: tecnologia, IA, startup (in inglese). */
async function hackernews({ query, days, limit }) {
  const since = Math.floor((Date.now() - days * 86_400_000) / 1000);
  const r = await getJson("https://hn.algolia.com/api/v1/search", { query, tags: "story", numericFilters: `created_at_i>${since}`, hitsPerPage: 50 });
  const items = (r.hits ?? [])
    .sort((a, b) => num(b.points) - num(a.points))
    .slice(0, limit)
    .map((h) => ({
      titolo: clip(h.title, 200),
      punti: num(h.points),
      commenti: num(h.num_comments),
      data: h.created_at ? String(h.created_at).slice(0, 10) : undefined,
      link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      discussione: `https://news.ycombinator.com/item?id=${h.objectID}`,
    }));
  return { items };
}

/** StockTwits: messaggi dei trader su un simbolo (AAPL, TSLA, BTC.X…) con l'etichetta rialzo/ribasso. */
async function stocktwits({ symbol, days, limit }) {
  if (!symbol) throw new Error("serve symbol (es. AAPL, NVDA, BTC.X)");
  const r = await getJson(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(symbol)}.json`);
  const since = Date.now() - days * 86_400_000;
  const msgs = (r.messages ?? []).filter((m) => !m.created_at || Date.parse(m.created_at) >= since);
  let bull = 0;
  let bear = 0;
  for (const m of msgs) {
    const s = m.entities?.sentiment?.basic;
    if (s === "Bullish") bull++;
    else if (s === "Bearish") bear++;
  }
  const tagged = bull + bear;
  const items = msgs
    .sort((a, b) => num(b.likes?.total) - num(a.likes?.total))
    .slice(0, limit)
    .map((m) => ({
      testo: clip(m.body, 280),
      umore: m.entities?.sentiment?.basic === "Bullish" ? "rialzo" : m.entities?.sentiment?.basic === "Bearish" ? "ribasso" : undefined,
      mi_piace: num(m.likes?.total),
      autore: m.user?.username,
      data: m.created_at ? String(m.created_at).slice(0, 10) : undefined,
    }));
  return {
    simbolo: r.symbol?.symbol ?? symbol,
    messaggi_letti: msgs.length,
    ...(tagged ? { rialzo_pct: Math.round((bull / tagged) * 100), ribasso_pct: Math.round((bear / tagged) * 100) } : {}),
    items,
    nota: "umore di chi scrive su StockTwits (spesso piccoli trader): un indizio, non un segnale",
  };
}

/** YouTube: video più visti sull'argomento, con il canale collegato dall'utente (niente chiavi in più). */
async function youtube({ query, days, limit }) {
  const day = isoDay(Date.now());
  if (ytUse.day !== day) Object.assign(ytUse, { day, n: 0 });
  if (ytUse.n >= YT_PER_DAY) throw new Error(`limite di ${YT_PER_DAY} ricerche YouTube al giorno raggiunto (servono anche per caricare i video): riprova domani`);
  ytUse.n++;
  const items = await social.youtubeSearch(query, { after: new Date(Date.now() - days * 86_400_000).toISOString(), limit });
  return { items };
}

const RUN = { reddit, polymarket, hackernews, stocktwits, youtube };

/** Cerca l'argomento sulle fonti scelte, in parallelo; le fonti che non rispondono finiscono in «errori». */
export async function buzz(input = {}) {
  const query = String(input.query ?? "").trim().slice(0, 200);
  const symbol = String(input.symbol ?? "").trim().toUpperCase().replace(/^\$/, "").slice(0, 20);
  if (!query && !symbol) throw new Error("query: l'argomento da cercare (meglio in inglese per Polymarket, Hacker News e Reddit internazionale)");
  const days = Math.min(Math.max(Math.round(Number(input.days) || 30), 1), 30);
  const limit = Math.min(Math.max(Math.round(Number(input.limit) || 8), 1), 15);
  const subreddits = [].concat(input.subreddits ?? []).flatMap((s) => String(s).split(",")).map((s) => s.trim().replace(/^\/?r\//i, "")).filter((s) => /^[A-Za-z0-9_]{2,21}$/.test(s)).slice(0, 3);
  let sources = [].concat(input.sources ?? []).map((s) => String(s).toLowerCase()).filter((s) => SOURCES.includes(s));
  if (!sources.length) {
    sources = ["reddit", "polymarket", "hackernews"];
    if (symbol) sources.push("stocktwits");
    if (social.isConnected("youtube")) sources.push("youtube");
  }
  if (!query) sources = sources.filter((s) => s === "stocktwits");
  const out = { argomento: query || symbol, giorni: days, fonti: {}, errori: {} };
  await Promise.all(
    sources.map(async (s) => {
      const params = { query, symbol, days, limit, subreddits };
      const key = `${s}:${JSON.stringify(params)}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) return void (out.fonti[s] = hit.value);
      try {
        const value = await RUN[s](params);
        cache.set(key, { at: Date.now(), value });
        out.fonti[s] = value;
      } catch (err) {
        out.errori[s] = err.message;
      }
    }),
  );
  if (!Object.keys(out.errori).length) delete out.errori;
  out.attenzione = "Sono opinioni e scommesse di persone, non fatti: prima di pubblicare un numero verificalo su una fonte ufficiale.";
  return out;
}

/** Per le prove. */
export function _reset() {
  cache.clear();
  Object.assign(ytUse, { day: "", n: 0 });
}
