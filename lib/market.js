// Dati di mercato: Yahoo Finance (endpoint pubblico "chart") con fallback a dati simulati.
// I dati simulati sono marcati `source: "demo"` così l'interfaccia lo mostra chiaramente.

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
  return { symbol, currency: r.meta.currency, source: "yahoo", candles };
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

export async function getHistory(symbol) {
  symbol = symbol.toUpperCase();
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

export async function getQuote(symbol) {
  const h = await getHistory(symbol);
  const last = h.candles.at(-1);
  const prev = h.candles.at(-2) ?? last;
  return {
    symbol: h.symbol, price: last.close, date: last.date, currency: h.currency, source: h.source,
    changePct: ((last.close - prev.close) / prev.close) * 100,
  };
}
