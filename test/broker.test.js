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
  id: "trader", name: "Trader", room: "trading", canTrade: true, watchlist: ["EURUSD", "XAUUSD", "AAPL", "ENI.IT"],
  limits: { requireApproval: false, onlyWatchlist: true, maxOrderPct: 10, maxPositionPct: 20 }, ...over,
});
const resetSafety = () => {
  safety.deactivateKill();
  safety.setLive(false);
  safety.updateLimits({ maxLotsPerOrder: 0.1, maxOpenPositions: 5, maxOrdersPerDay: 1000, maxDailyLossPct: 3, requireStopLoss: true, defaultStopLossPct: 2, closeOnStop: false });
};

test("collegamento al finto cTrader", async () => {
  ct.setCredentials({ clientId: "client-ok", clientSecret: "secret-ok" });
  ct.startAuth("http://localhost:3000/ctrader/callback");
  const st = await ct.finishAuth("code-ok");
  assert.equal(st.accounts.length, 2);
});

test("limiti di sicurezza: valori fuori intervallo rifiutati, frase per il conto reale", () => {
  assert.throws(() => safety.updateLimits({ maxLotsPerOrder: 0 }), /tra 0.01 e 100/);
  assert.throws(() => safety.updateLimits({ maxDailyLossPct: "abc" }), /Perdita massima del giorno.*tra 0.5 e 50/);
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

test("conto reale: l'approvazione resta obbligatoria anche per l'agente che non la chiede", async () => {
  resetSafety();
  safety.setLive(true, "SOLDI VERI");
  office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: live });
  const before = (await ct.positions(live)).length;
  const r = await broker.submitOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01, stop_loss_pct: 1, reason: "test" });
  assert.equal(r.status, "pending_approval", "sul conto reale niente ordini senza la tua approvazione");
  assert.equal((await ct.positions(live)).length, before, "nessuna posizione aperta");
  await broker.decide(r.approvalId, false);
  office.setFloorTrading(FLOOR, { mode: "paper" });
  resetSafety();
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

test("stop loss arrotondato ai decimali dello strumento (oro a 2 decimali)", async () => {
  resetSafety();
  office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: demo });
  const r = await broker.placeOrder(agent(), { symbol: "XAUUSD", side: "buy", lots: 0.01, stop_loss_pct: 1.37, take_profit_pct: 2.11 });
  assert.equal(r.status, "filled");
  const sent = fake.state.received.filter((m) => m.name === "ProtoOANewOrderReq").at(-1).data;
  assert.equal(sent.relativeStopLoss % 1000, 0);
  assert.equal(sent.relativeTakeProfit % 1000, 0);
  await broker.placeOrder(agent(), { action: "close", positionId: r.positionId });
});

test("stop loss negativo rifiutato; senza stop loss si usa quello predefinito anche sul demo", async () => {
  resetSafety();
  await assert.rejects(broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01, stop_loss_pct: -2 }), /Stop loss non valido/);
  await assert.rejects(broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01, stop_loss_pct: 80 }), /troppo lontano/);
  const r = await broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 });
  const p = (await ct.positions(demo)).find((x) => x.positionId === r.positionId);
  assert.ok(p.stopLoss > 0);
  await broker.placeOrder(agent(), { action: "close", positionId: r.positionId });
});

test("ordini in parallelo: i limiti valgono lo stesso", async () => {
  resetSafety();
  await ct.closeAgentPositions(demo);
  safety.updateLimits({ maxOpenPositions: 2 });
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.match(results.find((r) => r.status === "rejected").reason.message, /Troppe posizioni/);
  assert.equal((await ct.positions(demo)).filter((p) => p.label.startsWith("agenti")).length, 2);
  await ct.closeAgentPositions(demo);
  resetSafety();
});

test("STOP premuto mentre l'ordine è in viaggio: l'ordine non parte", async () => {
  resetSafety();
  safety.updateLimits({ maxLotsPerOrder: 1 }); // ENI.IT: minimo 1 lotto
  const before = fake.state.received.filter((m) => m.name === "ProtoOANewOrderReq").length;
  fake.state.hook = (name) => {
    if (name === "ProtoOASubscribeSpotsReq") safety.activateKill("prova in viaggio");
  };
  await assert.rejects(broker.placeOrder(agent(), { symbol: "ENI.IT", side: "buy", lots: 1 }), /STOP attivo/);
  fake.state.hook = null;
  assert.equal(fake.state.received.filter((m) => m.name === "ProtoOANewOrderReq").length, before);
  resetSafety();
});

test("proposte controllate subito: errori all'agente, chiusure con i dettagli della posizione", async () => {
  resetSafety();
  const a = agent({ limits: { ...agent().limits, requireApproval: true } });
  await assert.rejects(broker.submitOrder(a, { symbol: "EURUSD", side: "buy", qty: 1000 }), /lotti/);
  await assert.rejects(broker.submitOrder(a, { symbol: "US500", side: "buy", lots: 0.01 }), /watchlist/);
  await assert.rejects(broker.submitOrder(a, { symbol: "EURUSD", side: "buy", lots: 5 }), /troppo grande/);
  const r = await broker.placeOrder(agent(), { symbol: "EURUSD", side: "sell", lots: 0.02 });
  const p = await broker.submitOrder(a, { action: "close", positionId: r.positionId, reason: "basta" });
  const ap = getState().approvals.find((x) => x.id === p.approvalId);
  assert.equal(ap.order.symbol, "EURUSD");
  assert.equal(ap.order.side, "sell");
  assert.equal(ap.order.positionLots, 0.02);
  assert.equal((await broker.decide(p.approvalId, true)).status, "executed");
});

test("conti NETTED: gli agenti non possono operare", async () => {
  fake.state.accountType = "NETTED";
  await assert.rejects(broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 }), /HEDGED/);
  fake.state.accountType = "HEDGED";
});

test("perdita del giorno superata: il conto resta fermo anche dopo aver riattivato gli ordini", async () => {
  resetSafety();
  const acc = 7373;
  safety.checkDailyLoss(acc, 10_000);
  assert.equal(safety.checkDailyLoss(acc, 9_600).fresh, true);
  assert.equal(safety.isStopped(), true);
  safety.deactivateKill();
  assert.equal(safety.checkDailyLoss(acc, 9_600).fresh, false);
  assert.equal(safety.isStopped(), false, "lo STOP non si riaccende da solo dopo che l'utente l'ha tolto");
  assert.throws(() => safety.assertBrokerOrder({ accountId: acc, isLive: false, lots: 0.01, openAgentPositions: 0 }), /fino a domani/);
  safety.updateLimits({ maxDailyLossPct: 5 });
  safety.assertBrokerOrder({ accountId: acc, isLive: false, lots: 0.01, openAgentPositions: 0 });
  resetSafety();
});

test("depositi e prelievi non contano come guadagni o perdite", async () => {
  resetSafety();
  office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: demo });
  await ct.closeAgentPositions(demo);
  await broker.monitorAccounts(); // punto di partenza del giorno
  const before = safety.dailyAccount(demo).lossPct;
  fake.deposit(demo, -500); // prelievo del 5%: non è una perdita
  let [r] = await broker.monitorAccounts();
  assert.equal(r.breached, false);
  assert.ok(Math.abs(safety.dailyAccount(demo).lossPct - before) < 0.01);
  fake.deposit(demo, 800); // deposito: non nasconde le perdite
  [r] = await broker.monitorAccounts();
  assert.ok(Math.abs(safety.dailyAccount(demo).lossPct - before) < 0.01);
  assert.equal(safety.dailyAccount(demo).netFlow, 300);
  fake.deposit(demo, -300);
});

test("perdita: il blocco ricorda il livello che l'ha fatto scattare", () => {
  resetSafety();
  const acc = 8484;
  safety.checkDailyLoss(acc, 10_000);
  safety.checkDailyLoss(acc, 9_650); // 3.5%
  safety.deactivateKill();
  safety.checkDailyLoss(acc, 9_900); // recupera all'1%
  assert.throws(() => safety.assertBrokerOrder({ accountId: acc, isLive: false, lots: 0.01, openAgentPositions: 0 }), /3\.50%/);
  safety.updateLimits({ maxDailyLossPct: 3 }); // salvare senza alzare il limite non sblocca
  assert.throws(() => safety.assertBrokerOrder({ accountId: acc, isLive: false, lots: 0.01, openAgentPositions: 0 }), /fino a domani/);
  safety.updateLimits({ maxDailyLossPct: 4 });
  safety.assertBrokerOrder({ accountId: acc, isLive: false, lots: 0.01, openAgentPositions: 0 });
  resetSafety();
});

test("proposte rifiutate subito anche per conto NETTED o perdita del giorno", async () => {
  resetSafety();
  const a = agent({ limits: { ...agent().limits, requireApproval: true } });
  fake.state.accountType = "NETTED";
  await assert.rejects(broker.submitOrder(a, { symbol: "EURUSD", side: "buy", lots: 0.01 }), /HEDGED/);
  fake.state.accountType = "HEDGED";
});

test("chiusura automatica con lo STOP per perdita: riprova finché restano posizioni degli agenti", async () => {
  resetSafety();
  safety.updateLimits({ closeOnStop: true });
  await broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 });
  // perdita oltre il limite già registrata (es. la prima chiusura non era riuscita): il conto resta bloccato
  safety.checkDailyLoss(demo, safety.dailyAccount(demo).startEquity * 0.9);
  safety.deactivateKill();
  assert.equal(safety.dailyAccount(demo).breached, true);
  const [r] = await broker.monitorAccounts();
  assert.equal(r.fresh, false);
  assert.equal((await ct.positions(demo)).filter((p) => p.label.startsWith("agenti")).length, 0);
  safety.updateLimits({ maxDailyLossPct: 50 }); // sblocca il conto per i test successivi
  resetSafety();
});

test("P&L non disponibile: il controllo della perdita si salta invece di usare dati sbagliati", async () => {
  resetSafety();
  await broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 });
  fake.state.failPnl = true;
  const out = await broker.monitorAccounts();
  fake.state.failPnl = false;
  assert.equal(out.length, 0);
  assert.match(getState().log.at(-1).message, /P&L/);
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

test("chiusura delle posizioni degli agenti su tutti i conti (STOP e chiusura del venerdì)", async () => {
  resetSafety();
  const agentPositions = async () => {
    let n = 0;
    for (const id of [demo, live]) n += (await ct.positions(id)).filter((p) => p.label.startsWith("agenti")).length;
    return n;
  };
  await broker.placeOrder(agent(), { symbol: "EURUSD", side: "buy", lots: 0.01 });
  await broker.placeOrder(agent(), { symbol: "EURUSD", side: "sell", lots: 0.02 });
  const before = await agentPositions();
  assert.ok(before >= 2);
  const r = await broker.closeAgentPositionsEverywhere();
  assert.equal(r.closed + r.unconfirmed, before); // anche quelle rimaste sugli altri conti
  assert.deepEqual(r.failed, []);
  assert.equal(await agentPositions(), 0);
  // seconda volta: niente da chiudere (così la chiusura del venerdì sa di aver finito)
  assert.deepEqual(await broker.closeAgentPositionsEverywhere(), { closed: 0, unconfirmed: 0, failed: [] });
});

test("scanner dei mercati come agente a regole sul conto demo: tutti i mercati del broker tranne le azioni, nessun ordine", async () => {
  resetSafety();
  office.setFloorTrading(FLOOR, { mode: "ctrader", accountId: demo });
  const { runAgent } = await import("../lib/runner.js");
  const { readNotes } = await import("../lib/store.js");
  const before = (await ct.positions(demo)).length;
  const scan = { id: "scanner", name: "Scanner", room: "trading", mode: "rule", strategy: "scanner", params: { pauseMs: 0 }, watchlist: [], canTrade: false, limits: {} };
  await runAgent(scan, office.building());
  const note = readNotes("trading", 5).filter((n) => n.agentId === "scanner").at(-1);
  assert.match(note.text, /^CLASSIFICA SCANNER · H1 · .* — 3 mercati controllati \(forex, metalli, indici\)/, "EURUSD, XAUUSD, US500; non ENI.IT");
  assert.equal(note.tags[0], "SCANNER");
  assert.equal((await ct.positions(demo)).length, before, "lo scanner non apre posizioni");
  office.setFloorTrading(FLOOR, { mode: "paper" });
});

