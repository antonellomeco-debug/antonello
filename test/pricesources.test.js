// Fonti di riserva per i prezzi (Twelve Data, Financial Modeling Prep) quando Yahoo non risponde.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const calls = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const q = Object.fromEntries(u.searchParams);
  calls.push({ path: u.pathname, ...q });
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (u.pathname === "/quote") {
    if (q.apikey === "td-wrong-key") return send(401, { code: 401, message: "**apikey** parameter is incorrect", status: "error" });
    if (q.symbol === "BROKEN") return send(200, { code: 404, message: "symbol not found", status: "error" });
    if (q.symbol === "USD/EUR") return send(200, { symbol: "USD/EUR", name: "US Dollar / Euro", currency: "EUR", datetime: "2026-10-19", close: "0.92", previous_close: "0.91", percent_change: "1.1" });
    const prices = { AAPL: "182.5", ENI: "14.85" };
    return send(200, { symbol: q.symbol, name: q.symbol === "ENI" ? "Eni S.p.A." : "Apple Inc", mic_code: q.mic_code ?? "XNAS", currency: q.mic_code === "XMIL" ? "EUR" : "USD", datetime: "2026-10-19", close: prices[q.symbol] ?? "10", previous_close: "10", percent_change: "0.5" });
  }
  if (u.pathname === "/stable/quote") {
    if (q.apikey === "fmp-wrong-key") return send(401, { "Error Message": "Invalid API KEY." });
    if (q.symbol === "BROKEN") return send(200, [{ symbol: "BROKEN", name: "Broken Corp", price: 42, changePercentage: -1.5, previousClose: 42.6, timestamp: 1792430000 }]);
    return send(200, [{ symbol: q.symbol, name: "Apple Inc.", price: 183, changePercentage: 0.4, previousClose: 182.3, timestamp: 1792430000 }]);
  }
  send(404, {});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
  AGENTI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "prices-test-")),
  MARKET_MODE: "demo",
  STOCK_YAHOO: "off",
  TWELVEDATA_BASE: base,
  FMP_BASE: base,
});
const src = await import("../lib/pricesources.js");
const { stockQuote } = await import("../lib/market.js");
const holdings = await import("../lib/holdings.js");
after(() => server.close());

test("simboli di Yahoo tradotti per le altre fonti", () => {
  assert.deepEqual(src.parseSymbol("ENI.MI"), { kind: "stock", base: "ENI", mic: "XMIL", currency: "EUR" });
  assert.deepEqual(src.parseSymbol("aapl"), { kind: "stock", base: "AAPL", mic: null, currency: "USD" });
  assert.equal(src.parseSymbol("VOD.L").currency, "GBp");
  assert.deepEqual(src.parseSymbol("USDEUR=X"), { kind: "fx", from: "USD", to: "EUR", currency: "EUR" });
});

test("senza fonti di riserva il prezzo manca e lo dice", async () => {
  await assert.rejects(stockQuote("AAPL"), /Fonti dei dati/);
});

test("chiavi: quella sbagliata non si salva, quella giusta sì (e non si vede intera)", async () => {
  await assert.rejects(src.setSourceKeys({ twelvedata: "td-wrong-key" }), /Twelve Data dice che la chiave non è valida/);
  await assert.rejects(src.setSourceKeys({ fmp: "fmp-wrong-key" }), /Financial Modeling Prep dice che la chiave non è valida/);
  const r = await src.setSourceKeys({ twelvedata: "td-good-key-123" });
  assert.equal(r.twelvedata.configured, true);
  assert.equal(r.twelvedata.hint, "…-123");
  assert.equal(r.fmp.configured, false);
  assert.match(r.notes[0], /funziona/);
});

test("Yahoo giù: prezzo da Twelve Data con borsa e valuta giuste", async () => {
  const q = await stockQuote("ENI.MI");
  assert.deepEqual([q.price, q.currency, q.source, q.name], [14.85, "EUR", "twelvedata", "Eni S.p.A."]);
  const call = calls.findLast((c) => c.path === "/quote");
  assert.deepEqual([call.symbol, call.mic_code], ["ENI", "XMIL"]);
});

test("se Twelve Data non ha il titolo si passa a Financial Modeling Prep", async () => {
  await src.setSourceKeys({ fmp: "fmp-good-key-456" });
  const q = await stockQuote("BROKEN");
  assert.deepEqual([q.price, q.source, q.currency], [42, "fmp", "USD"]);
});

test("portafoglio: valori in euro con il cambio dalla fonte di riserva", async () => {
  holdings.addBuy({ symbol: "AAPL", qty: 10, price: 150, currency: "USD" });
  const s = await holdings.snapshot();
  const p = s.positions[0];
  assert.equal(p.priceSource, "twelvedata");
  assert.equal(p.price, 182.5);
  assert.equal(p.valueEur, Math.round(182.5 * 10 * 0.92 * 100) / 100);
  assert.ok(calls.some((c) => c.symbol === "USD/EUR"), "cambio USD→EUR chiesto come USD/EUR");
});

test("togliere una chiave", async () => {
  const r = await src.setSourceKeys({ fmp: "" });
  assert.equal(r.fmp.configured, false);
  assert.equal(r.twelvedata.configured, true);
});
