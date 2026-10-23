// Sistemi di trading in codice e banco di prova (lib/systems.js), agente a regole «sistema» (strategies/sistema.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "systems-test-"));
process.env.MARKET_MODE = "demo";
const sys = await import("../lib/systems.js");
const { getState } = await import("../lib/store.js");
const sistema = (await import("../strategies/sistema.js")).default;
const { runTool } = await import("../lib/tools.js");

const H = 3_600_000;
/** Candele orarie da una funzione del prezzo: f(i) → chiusura; aperture alla chiusura prima, escursione ±range. */
function series(n, f, range = 0.3) {
  const out = [];
  let prev = f(0);
  for (let i = 0; i < n; i++) {
    const close = f(i);
    out.push({ time: Date.UTC(2024, 0, 1) + i * H, date: new Date(Date.UTC(2024, 0, 1) + i * H).toISOString().slice(0, 10), open: prev, high: Math.max(prev, close) + range, low: Math.min(prev, close) - range, close });
    prev = close;
  }
  return out;
}
// Tendenze lunghe che si alternano (300 candele su, 300 giù) con un po' di rumore.
const trend = (n) => series(n, (i) => 300 + (i % 600 < 300 ? i % 600 : 600 - (i % 600)) * 0.5 + 3 * Math.sin(i / 6));
const flat = (n) => series(n, (i) => 100 + 4 * Math.sin(i / 3) + 2 * Math.sin(i * 1.7), 0.5);

test("indicatori: medie, RSI, canale delle candele precedenti, ATR", () => {
  assert.deepEqual(sys.smaSeries([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  assert.deepEqual(sys.highestBefore([5, 1, 7, 2, 3], 2), [null, null, 5, 7, 7]);
  assert.deepEqual(sys.lowestBefore([5, 1, 7, 2, 3], 2), [null, null, 1, 1, 2]);
  const up = sys.rsiSeries([1, 2, 3, 4, 5, 6], 2);
  assert.equal(up.at(-1), 100);
  const atr = sys.atrSeries([{ high: 2, low: 1, close: 1.5 }, { high: 3, low: 2, close: 2.5 }], 2);
  assert.equal(atr[1], 1.25, "la seconda candela conta anche il salto dalla chiusura prima");
});

test("tartarughe: guadagna in una tendenza pulita, i costi pesano, verdetto SUPERATO", () => {
  const candles = trend(3000);
  const r = sys.backtest(candles, "turtle", {}, { spread: 0.05 });
  assert.ok(r.trades >= 5, `operazioni: ${r.trades}`);
  assert.ok(r.expectancyR > 0.5, `guadagno medio ${r.expectancyR}`);
  assert.ok(r.trades === r.inSample.trades + r.outSample.trades);
  const costly = sys.backtest(candles, "turtle", {}, { spread: 3 });
  assert.ok(costly.expectancyR < r.expectancyR, "con spread più alto si guadagna meno");
  assert.equal(sys.verdict({ trades: 40, expectancyR: 0.3, profitFactor: 1.6 }, { trades: 10, expectancyR: 0.2 }).esito, "SUPERATO");
  assert.equal(sys.verdict({ trades: 40, expectancyR: 0.3, profitFactor: 1.6 }, { trades: 10, expectancyR: -0.1 }).esito, "BOCCIATO", "deve tenere anche sui dati più recenti");
  assert.equal(sys.verdict({ trades: 12 }, {}).esito, "POCHI DATI");
  const chop = sys.backtest(flat(3000), "turtle", {}, { spread: 0.2 });
  assert.notEqual(chop.verdict.esito, "SUPERATO", "in un mercato che va su e giù senza direzione la rottura non funziona");
});

test("prova onesta: entrata all'apertura dopo il segnale, stop prima dell'obiettivo nella stessa candela", () => {
  const candles = series(400, (i) => 100 + (i % 50 < 25 ? i % 50 : 50 - (i % 50)));
  const r = sys.backtest(candles, "squeeze", {}, {});
  for (const t of r.operations) {
    assert.equal(t.entry, candles[t.at].open, "entra all'apertura della candela dopo il segnale");
    if (t.why === "stop") assert.ok(t.r <= 0.01, "uno stop non può essere un guadagno pieno");
  }
  // Candela che tocca stop e obiettivo insieme: vale lo stop.
  const c = series(80, () => 100, 0.2);
  c.push({ time: c.at(-1).time + H, open: 100, high: 100.2, low: 99.8, close: 100 });
  const s = sys.stats([{ r: -1, bars: 1 }, { r: 2, bars: 3 }], 1);
  assert.equal(s.profitFactor, 2);
  assert.equal(s.winRate, 50);
  assert.equal(s.maxDrawdownR, 1);
});

test("chiusura del venerdì nella prova: nessuna posizione attraversa il fine settimana", () => {
  // Candele orarie dal lunedì al venerdì, poi un buco di due giorni.
  const c = [];
  let t = Date.UTC(2024, 0, 1); // lunedì
  let px = 100;
  for (let i = 0; c.length < 2500; i++) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      const close = (px += 0.2 + Math.sin(c.length / 5));
      c.push({ time: t, open: close - 0.2, high: close + 0.4, low: close - 0.6, close });
    }
    t += H;
  }
  const hold = sys.backtest(c, "momentum", {}, {});
  const flatWk = sys.backtest(c, "momentum", {}, { flatWeekend: true });
  const crosses = (tr) => tr.some((x) => {
    const span = c.slice(x.at, c.findIndex((k) => (k.time ?? 0) === x.out) + 1);
    return span.some((k, j) => j > 0 && k.time - span[j - 1].time > 36 * H);
  });
  assert.ok(crosses(hold.operations), "senza chiusura del venerdì le posizioni restano aperte nel weekend");
  assert.ok(!crosses(flatWk.operations), "con la chiusura del venerdì no");
  assert.ok(flatWk.operations.some((x) => x.why === "chiusura del venerdì"));
});

test("segnale dal vivo = segnale del banco di prova sulla stessa candela", () => {
  const candles = trend(600);
  const p = sys.systemParams("turtle");
  const s = sys.SYSTEMS.turtle.prepare(candles, p);
  let checked = 0;
  for (let i = 300; i < 600; i += 7) {
    const live = sys.liveSignal("turtle", candles.slice(0, i + 1)).entry;
    const bt = sys.SYSTEMS.turtle.entry(s, i, p);
    assert.deepEqual(live?.side ?? null, bt?.side ?? null);
    checked++;
  }
  assert.ok(checked > 10);
  assert.throws(() => sys.systemParams("magia"), /Sistema sconosciuto/);
  assert.deepEqual(sys.systemParams("turtle", { entry: "55", nonEsiste: 3, stopAtr: -1 }).entry, 55);
});

test("archivio delle prove: si opera solo con una prova SUPERATA e recente", () => {
  assert.equal(sys.passedBacktest("turtle", "XAUUSD", "H4"), false);
  sys.saveBacktest({ system: "turtle", symbol: "xauusd", period: "H4", verdict: { esito: "BOCCIATO" }, operations: [] });
  assert.equal(sys.passedBacktest("turtle", "XAUUSD", "H4"), false);
  const saved = sys.saveBacktest({ system: "turtle", symbol: "XAUUSD", period: "H4", verdict: { esito: "SUPERATO" }, operations: Array.from({ length: 30 }, (_, i) => ({ r: i })) });
  assert.equal(saved.lastTrades.length, 10, "si tengono solo le ultime operazioni");
  assert.equal(sys.passedBacktest("turtle", "XAU/USD", "H4"), true);
  assert.equal(sys.passedBacktest("turtle", "XAUUSD", "H1"), false, "altro periodo, altra prova");
  getState().backtests.at(-1).at = new Date(Date.now() - 60 * 86_400_000).toISOString();
  assert.equal(sys.passedBacktest("turtle", "XAUUSD", "H4"), false, "prova troppo vecchia");
});

function ctx({ candles, positions = [], saved = true, spread = 0.01, lots = 0.05, params = {} }) {
  const orders = [];
  const notes = [];
  if (saved) sys.saveBacktest({ system: "turtle", symbol: "XAUUSD", period: "H4", verdict: { esito: "SUPERATO" }, operations: [] });
  return {
    orders,
    notes,
    c: {
      agent: { id: "tartarughe", name: "Tartarughe", watchlist: ["XAUUSD"] },
      params: { system: "turtle", period: "H4", ...params },
      trading: { mode: "ctrader", accountId: 1 },
      market: {
        longHistory: async () => ({ candles }),
        getQuote: async () => ({ price: candles.at(-1).close, spread }),
        riskLots: async (symbol, stopDist, risk) => ({ lots, risk, currency: "EUR", stopDist, note: "minimo" }),
      },
      portfolio: async () => ({ account: { balance: 10_000 }, positions, myPositions: positions.map((p) => p.positionId) }),
      order: async (o) => {
        orders.push(o);
        return { status: "filled" };
      },
      notes: { post: (text, tags) => notes.push({ text, tags }) },
      log: () => {},
    },
  };
}

/** Candele che finiscono con una rottura del massimo di 20 candele. */
function breakout() {
  const c = series(400, (i) => 100 + 2 * Math.sin(i / 2));
  const last = c.at(-1);
  c.push({ time: last.time + 4 * H, open: last.close, high: 110, low: last.close - 0.1, close: 109 });
  return c;
}

test("agente «sistema»: apre con lo stop e i lotti dal rischio solo dopo una prova superata", async () => {
  getState().backtests = [];
  const no = ctx({ candles: breakout(), saved: false });
  const out = await sistema(no.c);
  assert.equal(no.orders.length, 0);
  assert.match(out, /prova sui prezzi passati non è superata/);

  const yes = ctx({ candles: breakout() });
  await sistema(yes.c);
  assert.equal(yes.orders.length, 1);
  const o = yes.orders[0];
  assert.equal(o.side, "buy");
  assert.equal(o.lots, 0.05);
  assert.ok(o.stop_loss_pct > 0, "lo stop c'è sempre");
  assert.match(o.reason, /^\[turtle\]/);
  assert.match(yes.notes[0].text, /^SISTEMA Tartarughe/);

  const wide = ctx({ candles: breakout(), spread: 50 });
  assert.match(await sistema(wide.c), /spread .* troppo alto/);
  assert.equal(wide.orders.length, 0);
  const news = ctx({ candles: breakout() });
  news.c.market.newsNear = async (symbol) => (symbol === "XAUUSD" ? ["gio 14:30 USD Non-Farm Payrolls, impatto alto"] : []);
  assert.match(await sistema(news.c), /notizia importante vicina/);
  assert.equal(news.orders.length, 0, "niente entrate a ridosso di una notizia forte");
  const tiny = ctx({ candles: breakout(), lots: 0 });
  await sistema(tiny.c);
  assert.equal(tiny.orders.length, 0, "se anche il minimo del broker rischia troppo non si opera");
});

test("agente «sistema»: chiude la sua posizione quando il sistema esce, non apre oltre il massimo", async () => {
  // Posizione al rialzo e ultima candela sotto il minimo di 10 candele: uscita delle tartarughe.
  const c = series(400, (i) => 100 + 2 * Math.sin(i / 2));
  const last = c.at(-1);
  c.push({ time: last.time + 4 * H, open: last.close, high: last.close + 0.1, low: 90, close: 90.5 });
  const t = ctx({ candles: c, positions: [{ positionId: 7, symbol: "XAUUSD", side: "buy", openedAt: new Date().toISOString() }] });
  await sistema(t.c);
  assert.deepEqual(t.orders, [{ action: "close", positionId: 7, reason: "[turtle] uscita del sistema" }]);

  const full = ctx({ candles: breakout(), positions: [{ positionId: 1, symbol: "EURUSD", side: "buy" }], params: { maxPositions: 1 } });
  await sistema(full.c);
  assert.equal(full.orders.length, 0);
  assert.match(await sistema({ ...full.c, params: { system: "boh" } }), /system mancante o sconosciuto/);
});

test("strumento backtest: elenco dei sistemi, prova su dati giornalieri, verdetto salvato", async () => {
  const agent = { id: "quant", name: "Quant", room: "trading", tools: ["backtest"], canTrade: false };
  const list = await runTool(agent, "backtest", { system: "elenco" });
  assert.equal(list.sistemi.length, sys.SYSTEM_NAMES.length);
  assert.ok(list.sistemi.every((x) => x.ispirato_a && x.come_funziona));
  const before = getState().backtests.length;
  const r = await runTool(agent, "backtest", { system: "tutti", symbols: ["SPY"], bars: 800 });
  assert.equal(r.risultati.length, sys.SYSTEM_NAMES.length);
  for (const x of r.risultati) {
    assert.equal(x.periodo, "D1", "azioni ed ETF: candele giornaliere");
    assert.match(x.verdetto, /^(SUPERATO|BOCCIATO|POCHI DATI)/);
  }
  assert.equal(getState().backtests.length, before + sys.SYSTEM_NAMES.length);
  await assert.rejects(runTool(agent, "backtest", { system: "boh", symbols: ["SPY"] }), /Sistema sconosciuto/);
  const h1 = await runTool(agent, "backtest", { system: "turtle", symbols: ["SPY"], period: "H1" });
  assert.match(h1.risultati[0].errore, /solo per gli strumenti del broker/);
});
