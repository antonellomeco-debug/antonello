// Ordini degli agenti: portafoglio simulato o conto cTrader (finto server), approvazioni e regole di sicurezza.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFake, ACCOUNTS } from "./helpers/fake-ctrader.js";

const fake = await startFake();
Object.assign(process.env, {
  AGENTI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "broker-test-")),
  MARKET_MODE: "demo",
  CTRADER_TLS: "0",
  CTRADER_DEMO_HOST: "127.0.0.1",
  CTRADER_LIVE_HOST: "127.0.0.1",
  CTRADER_PORT: String(fake.port),
  CTRADER_AUTH_URL: "http://127.0.0.1/auth",
  CTRADER_TOKEN_URL: `http://127.0.0.1:${fake.tokenPort}/apps/token`,
});
const ct = await import("../lib/ctrader/service.js");
const safety = await import("../lib/safety.js");
const { office } = await import("../lib/office.js");
const broker = await import("../lib/broker.js");
const { getState } = await import("../lib/store.js");

after(() => fake.close());

const { demo, live } = ACCOUNTS;
const FLOOR = "piano-azioni"; // piano della stanza "trading" nel palazzo iniziale
const agent = (over = {}) => ({
  id: "trader", name: "Trader", room: "trading", canTrade: true, watchlist: ["EURUSD", "XAUUSD", "AAPL"],
  limits: { requireApproval: false, onlyWatchlist: true, maxOrderPct: 10, maxPositionPct: 20 }, ...over,
});
const resetSafety = () => {
  safety.deactivateKill();
  safety.setLive(false);
  safety.updateLimits({ maxLotsPerOrder: 0.1, maxOpenPositions: 5, maxOrdersPerDay: 20, maxDailyLossPct: 3, requireStopLossLive: true, defaultStopLossPct: 2, closeOnStop: false });
};

test("collegamento al finto cTrader", async () => {
  ct.setCredentials({ clientId: "client-ok", clientSecret: "secret-ok" });
  ct.startAuth("http://localhost:3000/ctrader/callback");
  const st = await ct.finishAuth("code-ok");
  assert.equal(st.accounts.length, 2);
});

test("limiti di sicurezza: valori fuori intervallo rifiutati, frase per il conto reale", () => {
  assert.throws(() => safety.updateLimits({ maxLotsPerOrder: 0 }), /tra 0.01 e 100/);
  assert.throws(() => safety.updateLimits({ maxDailyLossPct: "abc" }), /non valido/);
  assert.throws(() => safety.setLive(true, "soldi"), /SOLDI VERI/);
  safety.setLive(true, " soldi veri ");
  assert.equal(safety.getSafety().liveEnabled, true);
  resetSafety();
  assert.equal(safety.getSafety().liveEnabled, false);
});

test("piano simulato: l'ordine resta nel portafoglio dell'app", async () => {
  assert.equal(broker.tradingTarget(agent()).mode, "paper");
  const t = await broker.placeOrder(agent(), { symbol: "AAPL", side: "buy", qty: 1, reason: "test" });
  assert.equal(t.target, "paper");
  assert.equal(getState().portfolio.positions.AAPL.qty, 1);
  await assert.rejects(broker.placeOrder(agent(), { symbol: "AAPL", side: "buy", lots: 0.01 }), /qty/);
});

test("conto reale: si collega solo dall'interfaccia e solo dopo lo sblocco", () => {
  resetSafety();
  assert.throws(() => office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: live }), /bloccato/);
  safety.setLive(true, "SOLDI VERI");
  assert.throws(() => office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: live }, { source: "Orion" }), /Solo tu/);
  office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: live });
  assert.equal(broker.tradingTarget(agent()).isLive, true);
  office.setFloorTrading(FLOOR, { mode: "paper" });
  resetSafety();
  // Orion può invece usare i conti demo
  office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: demo }, { source: "Orion" });
  assert.deepEqual(office.building().floors.find((f) => f.id === FLOOR).trading, { mode: "ctrader", accountId: demo });
  assert.throws(() => office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: 999 }), /non trovato/);
});

test("piano su conto demo: ordine in lotti con etichetta dell'agente", async () => {
  resetSafety();
  office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: demo });
  const target = broker.tradingTarget(agent());
  assert.equal(target.mode, "ctrader");
  assert.equal(target.isLive, false);
  await assert.rejects(broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", qty: 1000 }), /lotti/);
  await assert.rejects(broker.placeOrder(agent(), { symbol: "XAUUSD", side: "buy", lots: 0.5 }), /troppo grande/);
  await assert.rejects(broker.placeOrder(agent(), { symbol: "US500", side: "buy", lots: 0.01 }), /watchlist/);
  const r = await broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.02, stop_loss_pct: 1, reason: "test" });
  assert.equal(r.lots, 0.02);
  const pos = await ct.positions(demo);
  const mine = pos.find((p) => p.positionId === r.positionId);
  assert.equal(mine.label, "agenti:trader");
  assert.ok(mine.stopLoss > 0);
  assert.equal(getState().brokerTrades.at(-1).action, "open");
  assert.equal(safety.getSafety().daily.accounts[String(demo)].orders, 1);
  const pf = await broker.portfolioFor(agent());
  assert.ok(pf.myPositions.includes(r.positionId));
});

test("un agente chiude solo le proprie posizioni", async () => {
  const other = agent({ id: "altro", name: "Altro" });
  const r = await broker.placeOrder(other, { symbol: "EURUSD", side: "sell", lots: 0.01 });
  await assert.rejects(broker.placeOrder(agent(), { action: "close", positionId: r.positionId }), /solo le posizioni che ha aperto/);
  const c = await broker.placeOrder(other, { action: "close", positionId: r.positionId, reason: "fine" });
  assert.equal(c.lots, 0.01);
  assert.ok(!(await ct.positions(demo)).some((p) => p.positionId === r.positionId));
});

test("limite di posizioni aperte e di ordini al giorno", async () => {
  safety.updateLimits({ maxOpenPositions: 1 });
  await assert.rejects(broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 }), /Troppe posizioni/);
  safety.updateLimits({ maxOpenPositions: 5, maxOrdersPerDay: 1 });
  await assert.rejects(broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 }), /massimo di ordini/);
  resetSafety();
});

test("STOP: blocca proposte ed esecuzioni", async () => {
  safety.activateKill("prova");
  await assert.rejects(broker.submitOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 }), /STOP attivo/);
  await assert.rejects(broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 }), /STOP attivo/);
  resetSafety();
});

test("approvazione: parte solo se il piano usa ancora lo stesso conto", async () => {
  const a = agent({ limits: { ...agent().limits, requireApproval: true } });
  const p1 = await broker.submitOrder(a, { symbol: "EURUSD", side: "buy", lots: 0.01, reason: "uno" });
  assert.equal(p1.status, "pending_approval");
  const ap1 = getState().approvals.find((x) => x.id === p1.approvalId);
  assert.equal(ap1.target.accountId, demo);
  assert.equal(ap1.order.lots, 0.01);
  const done = await broker.decide(p1.approvalId, true);
  assert.equal(done.status, "executed");

  const p2 = await broker.submitOrder(a, { symbol: "EURUSD", side: "buy", lots: 0.01, reason: "due" });
  office.setFloorTrading(FLOOR, { mode: "paper" });
  const failed = await broker.decide(p2.approvalId, true);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /conto diverso/);
  office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: demo });
});

test("conto reale: stop loss sempre presente e blocco se il conto viene ribloccato", async () => {
  resetSafety();
  safety.setLive(true, "SOLDI VERI");
  office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: live });
  const r = await broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 }); // senza stop loss
  const p = (await ct.positions(live)).find((x) => x.positionId === r.positionId);
  assert.ok(p.stopLoss > 0, "stop loss predefinito sul conto reale");
  safety.setLive(false);
  await assert.rejects(broker.submitOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 }), /REALE/);
  await assert.rejects(broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 }), /REALE/);
  office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: demo });
});

test("perdita del giorno oltre il limite: STOP automatico", () => {
  resetSafety();
  assert.equal(safety.checkDailyLoss(4242, 10_000).breached, false);
  assert.equal(safety.checkDailyLoss(4242, 9_800).breached, false);
  assert.equal(safety.isStopped(), false);
  const r = safety.checkDailyLoss(4242, 9_650);
  assert.equal(r.breached, true);
  assert.equal(safety.isStopped(), true);
  assert.match(safety.getSafety().killSwitch.reason, /perdita del giorno/);
  resetSafety();
});

test("controllo periodico e chiusura delle posizioni degli agenti", async () => {
  resetSafety();
  const out = await broker.monitorAccounts();
  assert.equal(out.length, 1);
  assert.equal(out[0].breached, false);
  const before = (await ct.positions(demo)).filter((p) => p.label.startsWith("agenti")).length;
  assert.ok(before > 0);
  const closed = await ct.closeAgentPositions(demo);
  assert.equal(closed.length, before);
  assert.equal((await ct.positions(demo)).filter((p) => p.label.startsWith("agenti")).length, 0);
});
