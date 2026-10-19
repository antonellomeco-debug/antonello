// Scanner dei mercati: punteggio a regole fisse, gruppi del broker, classifica nella bacheca. Non usa Claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as indicators from "../lib/indicators.js";
import scanner, { scoreMarket, groupOf } from "../strategies/scanner.js";

/** Candele finte: tendenza costante (step per candela) con un'oscillazione, e uno strappo finale facoltativo. */
function series(n, { start = 100, step = 0, wave = 0.4, last = 0 } = {}) {
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p += step + Math.sin(i / 3) * wave * 0.1;
    if (i === n - 1) p += last;
    out.push({ time: i * 3_600_000, date: "2026-10-19", open: p - step / 2, high: p + 0.3, low: p - 0.3, close: p, volume: 1 });
  }
  return out;
}

/** La stessa serie capovolta: un ribasso identico al rialzo. */
const mirror = (candles) => candles.map((c) => ({ ...c, open: 300 - c.open, close: 300 - c.close, high: 300 - c.low, low: 300 - c.high }));

test("punteggio: rialzo con rottura del massimo, ribasso, mercato piatto", () => {
  const up = scoreMarket(series(120, { step: 0.05, wave: 3, last: 1 }), indicators);
  assert.equal(up.dir, "rialzo");
  assert.ok(up.score >= 55, `punteggio alto (${up.score})`);
  assert.ok(up.why.some((w) => /rottura del massimo/.test(w)));
  const down = scoreMarket(mirror(series(120, { step: 0.05, wave: 3, last: 1 })), indicators);
  assert.equal(down.dir, "ribasso");
  assert.ok(down.score >= 55);
  const flat = scoreMarket(series(120, { step: 0, wave: 0 }), indicators);
  assert.ok(flat.score < 40, `mercato fermo, punteggio basso (${flat.score})`);
  assert.equal(scoreMarket(series(30), indicators), null, "troppe poche candele");
});

test("gruppi dai nomi del broker (e dai simboli quando la categoria non basta)", () => {
  assert.equal(groupOf({ assetClass: "Forex", category: "Majors", symbol: "EURUSD" }), "forex");
  assert.equal(groupOf({ assetClass: "Metals", category: "Spot Metals", symbol: "XAGUSD" }), "metalli");
  assert.equal(groupOf({ assetClass: "Forex", category: "Spot", symbol: "XAUUSD" }), "metalli");
  assert.equal(groupOf({ assetClass: "Commodities", category: "Energies", symbol: "XBRUSD" }), "energia");
  assert.equal(groupOf({ assetClass: "Indices", category: "Cash Indices", symbol: "US500" }), "indici");
  assert.equal(groupOf({ assetClass: "Crypto", category: "Cryptocurrencies", symbol: "BTCUSD" }), "cripto");
  assert.equal(groupOf({ assetClass: "Stocks", category: "US Shares", symbol: "AAPL.US" }), "azioni");
});

function ctx({ catalog, history, params = {}, watchlist = [] }) {
  const posted = [];
  const asked = [];
  return {
    posted,
    asked,
    ctx: {
      agent: { id: "scanner", name: "Scanner", watchlist },
      params: { pauseMs: 0, ...params },
      market: {
        symbols: async () => catalog,
        getHistory: async (s, opts) => {
          asked.push([s, opts]);
          if (!history[s]) throw new Error("niente dati");
          return { candles: history[s] };
        },
        indicators,
      },
      notes: { post: (text, tags) => posted.push({ text, tags }) },
      log: () => {},
    },
  };
}

test("scanner: tutti i mercati del broker tranne le azioni, classifica con i migliori, niente ordini", async () => {
  const catalog = [
    { symbol: "EURUSD", assetClass: "Forex", category: "Majors" },
    { symbol: "GBPUSD", assetClass: "Forex", category: "Majors" },
    { symbol: "XAUUSD", assetClass: "Metals", category: "Spot Metals" },
    { symbol: "US500", assetClass: "Indices", category: "Cash Indices" },
    { symbol: "AAPL.US", assetClass: "Stocks", category: "US Shares" },
    { symbol: "SENZADATI", assetClass: "Forex", category: "Exotics" },
  ];
  const history = {
    EURUSD: series(120, { step: 0, wave: 0 }),
    GBPUSD: mirror(series(120, { step: 0.05, wave: 3, last: 1 })),
    XAUUSD: series(120, { step: 0.05, wave: 3, last: 1 }),
    US500: series(120, { step: 0, wave: 0 }),
    "AAPL.US": series(120, { step: 0.05, wave: 3, last: 1 }),
  };
  const { ctx: c, posted, asked } = ctx({ catalog, history });
  const out = await scanner(c);
  assert.ok(!asked.some(([s]) => s === "AAPL.US"), "le azioni non si controllano se non richieste");
  assert.deepEqual(asked[0][1], { period: "H1", count: 120 });
  assert.equal(posted.length, 1);
  const { text, tags } = posted[0];
  assert.match(text, /^CLASSIFICA SCANNER · H1 · /);
  assert.match(text, /4 mercati controllati \(forex, metalli, indici\), 1 senza dati/);
  assert.match(text, /1\. (XAUUSD · RIALZO|GBPUSD · RIBASSO)/);
  assert.ok(!/EURUSD ·/.test(text), "i mercati fermi non entrano in classifica");
  assert.deepEqual(tags.slice(0, 1), ["SCANNER"]);
  assert.ok(tags.includes("XAUUSD") && tags.includes("GBPUSD"));
  assert.match(out, /4 mercati controllati, 2 in classifica/);
});

test("scanner: gruppi scelti, include, exclude, limite e mercati a turno tra i gruppi", async () => {
  const catalog = [
    ...["EURUSD", "GBPUSD", "USDJPY", "AUDUSD"].map((s) => ({ symbol: s, assetClass: "Forex", category: "Majors" })),
    { symbol: "XAUUSD", assetClass: "Metals", category: "Spot" },
    { symbol: "US500", assetClass: "Indices", category: "Cash" },
  ];
  const history = Object.fromEntries([...catalog.map((m) => m.symbol), "AAPL.US"].map((s) => [s, series(120)]));
  const { ctx: c, asked } = ctx({ catalog, history, params: { maxSymbols: 4, include: ["AAPL.US"], exclude: ["USDJPY"] } });
  await scanner(c);
  assert.deepEqual(asked.map(([s]) => s), ["AAPL.US", "EURUSD", "XAUUSD", "US500"], "prima quelli scelti, poi un mercato per gruppo");
  const only = ctx({ catalog, history, params: { groups: ["metalli"] } });
  await scanner(only.ctx);
  assert.deepEqual(only.asked.map(([s]) => s), ["XAUUSD"]);
});

test("scanner senza cTrader: usa la watchlist con le candele giornaliere", async () => {
  const { ctx: c, asked, posted } = ctx({ catalog: null, history: { AAPL: series(120, { step: 0.05, wave: 3, last: 1 }) }, watchlist: ["AAPL"] });
  await scanner(c);
  assert.deepEqual(asked, [["AAPL", {}]]);
  assert.match(posted[0].text, /CLASSIFICA SCANNER · D1 .*1 mercati controllati \(watchlist\)/);
});
