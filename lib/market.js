// Dati di mercato. Se cTrader è collegato e lo strumento esiste sul conto, si usano i prezzi del broker
// (gli stessi a cui si opera). Altrimenti Yahoo Finance (endpoint pubblico "chart"), con fallback a dati
// simulati marcati `source: "demo"` così l'interfaccia lo mostra chiaramente.
import * as ctrader from "./ctrader/service.js";
import { fallbackQuote, hasFallback } from "./pricesources.js";
import { getSafety } from "./safety.js";

const cache = new Map(); // symbol -> { at, data }
const TTL_MS = 60_000;

export const DEMO = process.env.MARKET_MODE === "demo";

async function fetchYahoo(symbol, range = "6mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo ${res.status} per ${symbol}`);
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(`Nessun dato per ${symbol}`);
  const q = r.indicators.quote[0];
  const candles = r.timestamp
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i],
    }))
    .filter((c) => c.close != null);
  return { symbol, currency: r.meta.currency, name: r.meta.longName ?? r.meta.shortName ?? null, source: "yahoo", candles };
}

// Random walk deterministico per simbolo: utile offline e per i test.
function demoSeries(symbol, days = 130) {
  let seed = [...symbol].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let price = 50 + (seed % 400);
  const candles = [];
  const today = new Date();
  for (let i = days; i > 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const open = price;
    price = Math.max(1, price * (1 + (rand() - 0.48) * 0.04));
    candles.push({
      date: d.toISOString().slice(0, 10),
      open, high: Math.max(open, price) * 1.01, low: Math.min(open, price) * 0.99,
      close: price, volume: Math.round(1e6 * (0.5 + rand())),
    });
  }
  return { symbol, currency: "USD", source: "demo", candles };
}

/**
 * Conto cTrader da cui leggere lo strumento, oppure null se si usa Yahoo.
 * Con un conto esplicito (piano collegato a cTrader) gli errori di connessione non vengono nascosti.
 */
async function ctraderAccountFor(symbol, accountId) {
  if (accountId) {
    if (!ctrader.isReady() || !ctrader.account(accountId)) {
      throw new Error("Il conto cTrader di questo piano non è disponibile (cTrader scollegato o conto non più nell'elenco): controlla la sezione Broker.");
    }
    try {
      await ctrader.findSymbol(accountId, symbol);
      return accountId;
    } catch (err) {
      if (/non esiste su questo conto/.test(err.message)) return null; // es. un indice di Yahoo usato per l'analisi
      throw err;
    }
  }
  if (!ctrader.isReady()) return null;
  const id = ctrader.dataAccountId();
  if (!id || !ctrader.account(id)) return null;
  return (await ctrader.hasSymbol(id, symbol)) ? id : null;
}

export async function getHistory(symbol, { accountId, period = "D1", count = 200 } = {}) {
  const ct = await ctraderAccountFor(symbol, accountId);
  if (ct) {
    const candles = await ctrader.candles(ct, symbol, period, count);
    return { symbol: String(symbol).toUpperCase(), currency: "", source: ctrader.account(ct).isLive ? "ctrader-live" : "ctrader-demo", period, candles };
  }
  if (period !== "D1") throw new Error(`Candele ${period} disponibili solo per gli strumenti di cTrader.`);
  return yahooHistory(symbol);
}

/** Candele giornaliere di Yahoo Finance (dati demo se Yahoo non risponde), con 1 minuto di cache. */
async function yahooHistory(symbol) {
  symbol = String(symbol).toUpperCase();
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  let data;
  if (DEMO) data = demoSeries(symbol);
  else {
    try {
      data = await fetchYahoo(symbol);
    } catch (err) {
      console.warn(`[market] ${err.message} — uso dati demo`);
      data = demoSeries(symbol);
    }
  }
  cache.set(symbol, { at: Date.now(), data });
  return data;
}

export async function getQuote(symbol, { accountId } = {}) {
  const ct = await ctraderAccountFor(symbol, accountId);
  if (ct) return ctrader.quote(ct, symbol);
  const h = await getHistory(symbol);
  // Yahoo non ha risposto: prima di dare un prezzo di prova si tenta una fonte di riserva (se l'utente ne ha una).
  if (h.source === "demo" && !DEMO && hasFallback()) {
    const q = await fallbackQuote(symbol).catch(() => null);
    if (q) return { symbol: q.symbol, price: q.price, date: q.date, currency: q.currency, source: q.source, changePct: q.changePct };
  }
  const last = h.candles.at(-1);
  const prev = h.candles.at(-2) ?? last;
  return {
    symbol: h.symbol, price: last.close, date: last.date, currency: h.currency, source: h.source,
    changePct: ((last.close - prev.close) / prev.close) * 100,
  };
}

const longCache = new Map(); // simbolo:periodo:candele:conto -> { at, data }
const LONG_TTL_MS = 30 * 60_000;

/**
 * Storico lungo per il banco di prova e per i sistemi: cTrader (tutti i periodi, a pagine) se lo strumento è sul conto,
 * altrimenti Yahoo (solo giornaliero, fino a 10 anni). Solo candele chiuse. spread = spread attuale del broker (costo).
 */
export async function longHistory(symbol, { accountId, period = "D1", bars = 3000 } = {}) {
  const key = `${String(symbol).toUpperCase()}:${period}:${bars}:${accountId ?? ""}`;
  const hit = longCache.get(key);
  if (hit && Date.now() - hit.at < LONG_TTL_MS) return hit.data;
  let data;
  const ct = await ctraderAccountFor(symbol, accountId);
  if (ct) {
    const candles = await ctrader.history(ct, symbol, period, bars);
    const q = await ctrader.quote(ct, symbol).catch(() => null);
    data = { symbol: String(symbol).toUpperCase(), source: ctrader.account(ct).isLive ? "ctrader-live" : "ctrader-demo", period, candles, spread: q?.spread ?? null };
  } else {
    if (period !== "D1") throw new Error(`${symbol}: candele ${period} solo per gli strumenti del broker cTrader; per azioni ed ETF di Yahoo usa D1.`);
    if (DEMO) data = { ...demoSeries(String(symbol).toUpperCase(), Math.round(bars * 1.45)), period };
    else {
      const range = bars <= 240 ? "1y" : bars <= 480 ? "2y" : bars <= 1200 ? "5y" : "10y";
      data = { ...(await fetchYahoo(symbol, range, "1d")), period };
    }
    const today = new Date().toISOString().slice(0, 10);
    data.candles = data.candles.filter((c) => c.date < today).slice(-bars); // la giornata in corso non è ancora chiusa
    data.spread = null;
  }
  longCache.set(key, { at: Date.now(), data });
  return data;
}

/**
 * Lotti cTrader per rischiare riskMoney (valuta del conto) con lo stop a stopDist dal prezzo, mai oltre il massimo per
 * ordine di Broker → Sicurezza (in quel caso si rischia di meno, non di più).
 */
export async function riskLots(symbol, stopDist, riskMoney, { accountId } = {}) {
  const ct = await ctraderAccountFor(symbol, accountId);
  if (!ct) throw new Error(`${symbol} non è sul conto cTrader: i lotti si calcolano solo per gli strumenti del broker.`);
  const r = await ctrader.riskLots(ct, symbol, stopDist, riskMoney);
  const max = Number(getSafety().limits?.maxLotsPerOrder) || 0;
  if (max > 0 && r.lots > max) return { ...r, lots: max, risk: Math.round((r.risk * max / r.lots) * 100) / 100, note: `limitato a ${max} lotti dal massimo per ordine di Broker → Sicurezza` };
  return r;
}

/**
 * Prezzo di un'azione per il portafoglio dell'utente: sempre da Yahoo (ticker come AAPL, ENI.MI), con la valuta di
 * quotazione e il nome della società. Non usa cTrader: lì i nomi e le valute degli strumenti sono diversi.
 */
export async function stockQuote(symbol) {
  const yahooOff = process.env.STOCK_YAHOO === "off"; // solo per i test delle fonti di riserva
  const h = yahooOff ? { source: "demo" } : await yahooHistory(symbol);
  // Per i soldi veri niente prezzi inventati: senza Yahoo si prova una fonte di riserva (Twelve Data, Financial Modeling
  // Prep), altrimenti il prezzo manca.
  if (h.source === "demo" && (!DEMO || yahooOff)) {
    const sym = String(symbol).toUpperCase();
    if (!hasFallback()) throw new Error(`Prezzo di ${sym} non disponibile: controlla il simbolo (come su Yahoo Finance, es. AAPL, ENI.MI) o riprova più tardi. Per non restare senza prezzi aggiungi una fonte di riserva in 💼 Portafoglio → 🔌 Fonti dei dati.`);
    try {
      const q = await fallbackQuote(sym);
      return { symbol: sym, name: q.name, price: q.price, date: q.date, currency: q.currency, source: q.source, changePct: q.changePct };
    } catch (err) {
      throw new Error(`Prezzo di ${sym} non disponibile: Yahoo non risponde e le fonti di riserva neanche (${err.message}). Controlla il simbolo (es. AAPL, ENI.MI).`);
    }
  }
  const last = h.candles.at(-1);
  if (!last) throw new Error(`Nessun prezzo per ${symbol}`);
  const prev = h.candles.at(-2) ?? last;
  return { symbol: h.symbol, name: h.name ?? null, price: last.close, date: last.date, currency: h.currency ?? "", source: h.source, changePct: ((last.close - prev.close) / prev.close) * 100 };
}

/**
 * Elenco dei mercati del broker (cTrader) con la loro classe: per lo scanner. Senza cTrader collegato
 * restituisce null: lo scanner usa allora la sua watchlist.
 */
export async function symbolCatalog({ accountId } = {}) {
  const id = accountId ?? (ctrader.isReady() ? ctrader.dataAccountId() : null);
  if (!id || !ctrader.account(id)) return null;
  return ctrader.catalog(id);
}
