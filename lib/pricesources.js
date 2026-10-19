// Fonti di riserva per i prezzi delle azioni, quando Yahoo Finance non risponde: Twelve Data e Financial Modeling Prep,
// con le chiavi gratuite dell'utente (salvate in settings.json, mai mostrate per intero). I simboli restano quelli di
// Yahoo (AAPL, ENI.MI, USDEUR=X): qui si traducono nel formato di ogni servizio.
import { getSettings, updateSettings } from "./settings.js";

const TD_BASE = () => process.env.TWELVEDATA_BASE ?? "https://api.twelvedata.com";
const FMP_BASE = () => process.env.FMP_BASE ?? "https://financialmodelingprep.com";
const TTL_MS = 20 * 60_000; // i piani gratuiti hanno poche richieste al giorno: un prezzo vale 20 minuti
const cache = new Map(); // simbolo -> { at, data }

// Suffisso di Yahoo → borsa (codice MIC per Twelve Data) e valuta di quotazione.
const MARKETS = {
  MI: ["XMIL", "EUR"], AS: ["XAMS", "EUR"], PA: ["XPAR", "EUR"], DE: ["XETR", "EUR"], F: ["XFRA", "EUR"], MC: ["XMAD", "EUR"],
  BR: ["XBRU", "EUR"], LS: ["XLIS", "EUR"], VI: ["XWBO", "EUR"], HE: ["XHEL", "EUR"], IR: ["XDUB", "EUR"],
  L: ["XLON", "GBp"], SW: ["XSWX", "CHF"], CO: ["XCSE", "DKK"], ST: ["XSTO", "SEK"], OL: ["XOSL", "NOK"], TO: ["XTSE", "CAD"],
};

/** Dal simbolo di Yahoo: nome base, borsa e valuta (azioni USA senza suffisso; cambi come USDEUR=X). */
export function parseSymbol(symbol) {
  const s = String(symbol).toUpperCase();
  const fx = s.match(/^([A-Z]{3})([A-Z]{3})=X$/);
  if (fx) return { kind: "fx", from: fx[1], to: fx[2], currency: fx[2] };
  const m = s.match(/^(.+)\.([A-Z]{1,2})$/);
  if (m && MARKETS[m[2]]) return { kind: "stock", base: m[1], mic: MARKETS[m[2]][0], currency: MARKETS[m[2]][1] };
  return { kind: "stock", base: s, mic: null, currency: "USD" };
}

const num = (x) => (x == null || x === "" ? NaN : Number(x));

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`risposta non valida (${res.status})`);
  }
  return { status: res.status, json };
}

async function twelveData(symbol, key) {
  const p = parseSymbol(symbol);
  const q = new URLSearchParams({ apikey: key });
  if (p.kind === "fx") q.set("symbol", `${p.from}/${p.to}`);
  else {
    q.set("symbol", p.base);
    if (p.mic) q.set("mic_code", p.mic);
  }
  const { status, json } = await getJson(`${TD_BASE()}/quote?${q}`);
  if (json?.status === "error" || status >= 400) {
    const err = new Error(json?.message || `errore ${status}`);
    err.auth = json?.code === 401 || status === 401;
    throw err;
  }
  const price = num(json.close ?? json.price);
  if (!(price > 0)) throw new Error("nessun prezzo nella risposta");
  const prev = num(json.previous_close);
  const pct = num(json.percent_change);
  return {
    name: json.name ?? null,
    price,
    currency: json.currency || p.currency,
    date: String(json.datetime ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10),
    changePct: Number.isFinite(pct) ? pct : prev > 0 ? ((price - prev) / prev) * 100 : 0,
  };
}

async function fmp(symbol, key) {
  const p = parseSymbol(symbol);
  const sym = p.kind === "fx" ? `${p.from}${p.to}` : String(symbol).toUpperCase();
  const { status, json } = await getJson(`${FMP_BASE()}/stable/quote?${new URLSearchParams({ symbol: sym, apikey: key })}`);
  const row = Array.isArray(json) ? json[0] : null;
  if (!row || status >= 400) {
    const msg = json?.["Error Message"] || json?.error || json?.message || (Array.isArray(json) ? "simbolo non trovato (o non incluso nel piano gratuito)" : `errore ${status}`);
    const err = new Error(String(msg));
    err.auth = status === 401 || status === 403 || /api ?key/i.test(String(msg));
    throw err;
  }
  const price = num(row.price);
  if (!(price > 0)) throw new Error("nessun prezzo nella risposta");
  const prev = num(row.previousClose);
  const pct = num(row.changePercentage ?? row.changesPercentage);
  return {
    name: row.name ?? null,
    price,
    currency: p.currency,
    date: row.timestamp ? new Date(row.timestamp * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    changePct: Number.isFinite(pct) ? pct : prev > 0 ? ((price - prev) / prev) * 100 : 0,
  };
}

const FINNHUB_BASE = () => process.env.FINNHUB_BASE ?? "https://finnhub.io/api/v1";

async function finnhub(symbol, key) {
  const p = parseSymbol(symbol);
  if (p.kind === "fx") throw new Error("cambi non disponibili");
  const { status, json } = await getJson(`${FINNHUB_BASE()}/quote?${new URLSearchParams({ symbol: String(symbol).toUpperCase(), token: key })}`);
  if (status === 401 || status === 403) throw Object.assign(new Error("chiave rifiutata"), { auth: true });
  if (status >= 400) throw new Error(`errore ${status}`);
  const price = num(json?.c);
  if (!(price > 0)) throw new Error("simbolo non trovato (o non incluso nel piano gratuito)");
  const pct = num(json.dp);
  return { name: null, price, currency: p.currency, date: json.t ? new Date(json.t * 1000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10), changePct: Number.isFinite(pct) ? pct : 0 };
}

const SOURCES = [
  { id: "twelvedata", label: "Twelve Data", key: "twelveDataKey", fn: twelveData },
  { id: "fmp", label: "Financial Modeling Prep", key: "fmpKey", fn: fmp },
  { id: "finnhub", label: "Finnhub", key: "finnhubKey", fn: finnhub, managedElsewhere: true }, // chiave salvata da marketdata.js
];

export const hasFallback = () => SOURCES.some((s) => getSettings()[s.key]);

/**
 * Prezzo da una fonte di riserva (la prima che risponde). Errore con il motivo di ognuna se nessuna lo dà.
 */
export async function fallbackQuote(symbol) {
  const sym = String(symbol).toUpperCase();
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const why = [];
  for (const s of SOURCES) {
    const key = getSettings()[s.key];
    if (!key) continue;
    try {
      const data = { symbol: sym, ...(await s.fn(sym, key)), source: s.id };
      cache.set(sym, { at: Date.now(), data });
      return data;
    } catch (err) {
      why.push(`${s.label}: ${err.message}`);
    }
  }
  throw new Error(why.length ? why.join("; ") : "nessuna fonte di riserva impostata");
}

export function sourcesStatus() {
  const st = getSettings();
  return Object.fromEntries(SOURCES.filter((s) => !s.managedElsewhere).map((s) => [s.id, { label: s.label, configured: Boolean(st[s.key]), hint: st[s.key] ? `…${String(st[s.key]).slice(-4)}` : null }]));
}

/**
 * Salva (o toglie, con "") le chiavi delle fonti di riserva. Ogni chiave nuova si prova con un prezzo di Apple:
 * se il servizio dice che la chiave è sbagliata non si salva; se non risponde si salva lo stesso, con un avviso.
 */
export async function setSourceKeys(input = {}) {
  const notes = [];
  for (const s of SOURCES) {
    if (input[s.id] === undefined || s.managedElsewhere) continue;
    const k = String(input[s.id] ?? "").replace(/\s+/g, "");
    if (!k) {
      updateSettings({ [s.key]: null });
      continue;
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(k)) throw new Error(`La chiave di ${s.label} non sembra giusta: copiala di nuovo intera.`);
    try {
      await s.fn("AAPL", k);
      notes.push(`${s.label}: chiave provata, funziona.`);
    } catch (err) {
      if (err.auth) throw new Error(`${s.label} dice che la chiave non è valida (${err.message}). Copiala di nuovo dal tuo account.`);
      notes.push(`${s.label}: salvata, ma la prova non è riuscita (${err.message}).`);
    }
    updateSettings({ [s.key]: k });
  }
  cache.clear();
  return { ...sourcesStatus(), notes };
}
