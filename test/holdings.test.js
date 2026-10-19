// Il portafoglio vero dell'utente: segnali degli agenti in Approvazioni, acquisti e vendite scritti dall'utente,
// valori in euro, controllo di stop loss e obiettivi.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "holdings-test-"));
process.env.AGENTI_DATA_DIR = dir;
process.env.MARKET_MODE = "demo";
const holdings = await import("../lib/holdings.js");
const { getState } = await import("../lib/store.js");
const { stockQuote } = await import("../lib/market.js");
const { runTool, toolsFor } = await import("../lib/tools.js");
const safety = await import("../lib/safety.js");
const { validate } = await import("../lib/config.js");

const RISKS = "Rischi: dazi sulla Cina e rallentamento degli smartphone; cambierei idea se i margini scendono sotto il 40%.";
const analyst = { id: "capo_azioni", name: "Capo Azioni", room: "azioni-direzione", tools: ["my_portfolio", "send_signal"], canTrade: false, watchlist: [], limits: {} };

test("profilo d'investimento: valori controllati", () => {
  assert.throws(() => holdings.setProfile({ capital: "tanti" }), /Capitale/);
  assert.throws(() => holdings.setProfile({ risk: "folle" }), /Rischio/);
  const p = holdings.setProfile({ capital: "10.000".replace(".", ""), risk: "medio", horizon: "lungo", markets: "Italia, USA", sectors: "tecnologia" });
  assert.equal(p.capital, 10000);
  assert.equal(p.horizon, "lungo");
});

test("segnale d'acquisto: in Approvazioni con le dimensioni suggerite; approvare = scrivere quante azioni e a che prezzo", async () => {
  const q = await stockQuote("AAPL");
  await assert.rejects(holdings.proposeSignal(analyst, { side: "buy", symbol: "AAPL", reason: "troppo corto" }), /reason/);
  await assert.rejects(holdings.proposeSignal(analyst, { side: "buy", symbol: "AAPL", reason: "Utili sopra le attese per 4 trimestri, valutazione sotto la media.", risks: RISKS }), /stop_loss/);
  await assert.rejects(holdings.proposeSignal(analyst, { side: "buy", symbol: "AAPL", reason: "Utili sopra le attese per 4 trimestri, valutazione sotto la media.", risks: RISKS, stop_loss: q.price * 1.1 }), /sotto il prezzo/);
  const r = await runTool(analyst, "send_signal", {
    side: "buy", symbol: "aapl", reason: "Utili sopra le attese per 4 trimestri, valutazione sotto la media del settore (fonte: trimestrale 30/07/2026).",
    stop_loss: round(q.price * 0.9), target: round(q.price * 1.25), entry_min: round(q.price * 0.98), entry_max: round(q.price * 1.01), suggested_pct: 5, horizon: "medio", risks: RISKS, sources: ["10-Q Apple, 31/07/2026"],
  });
  assert.equal(r.status, "pending_approval");
  await assert.rejects(holdings.proposeSignal(analyst, { side: "buy", symbol: "AAPL", reason: "Di nuovo lo stesso titolo, stessa tesi di prima.", stop_loss: q.price * 0.9, suggested_pct: 2, risks: RISKS }), /già un segnale/);
  const a = getState().approvals.find((x) => x.id === r.approvalId);
  assert.equal(a.kind, "signal");
  assert.equal(a.signal.symbol, "AAPL");
  assert.equal(a.signal.suggestedEur, 500, "5% di 10.000 €");
  assert.equal(a.signal.risks, RISKS);
  assert.deepEqual(a.signal.sources, ["10-Q Apple, 31/07/2026"]);
  assert.equal(a.signal.maxWeight, 12, "rischio medio: massimo 12% per azione");
  assert.ok(a.signal.suggestedQty >= 0);
  // L'utente approva scrivendo quante azioni ha comprato.
  assert.throws(() => holdings.decideSignal(a.id, { approve: true, qty: "", price: "100" }), /Quantità/);
  const done = holdings.decideSignal(a.id, { approve: true, qty: "3", price: "100,50", fees: "2" });
  assert.equal(done.status, "executed");
  assert.throws(() => holdings.decideSignal(a.id, { approve: true, qty: "3", price: "100" }), /già deciso/);
  const s = await holdings.snapshot();
  const pos = s.positions.find((p) => p.symbol === "AAPL");
  assert.equal(pos.qty, 3);
  assert.equal(pos.avgPrice, 100.5);
  assert.equal(pos.agentName, "Capo Azioni");
  assert.equal(pos.stopLoss, a.signal.stopLoss, "stop loss e obiettivo del segnale restano sulla posizione");
  assert.ok(pos.valueEur > 0, "valore in euro con il cambio del giorno");
  // Gli agenti vedono il portafoglio e i segnali decisi.
  const mine = await runTool(analyst, "my_portfolio", {});
  assert.equal(mine.posizioni[0].quantita, 3);
  assert.equal(mine.segnali_decisi.at(-1).stato, "executed");
  assert.equal(mine.segnali_decisi.at(-1).quantita, 3);
  assert.equal(mine.profilo.capital, 10000);
});

test("vendita: segnale solo su azioni possedute, risultato tra le operazioni chiuse", async () => {
  await assert.rejects(holdings.proposeSignal(analyst, { side: "sell", symbol: "MSFT", reason: "Non la possiede, il segnale va rifiutato subito." }), /non è nel portafoglio/);
  const pos = (await holdings.snapshot()).positions.find((p) => p.symbol === "AAPL");
  const r = await holdings.proposeSignal(analyst, { side: "sell", symbol: "AAPL", position_id: pos.id, sell_pct: 50, reason: "Obiettivo vicino e RSI oltre 75: incassare metà della posizione." });
  const a = getState().approvals.find((x) => x.id === r.approvalId);
  assert.equal(a.signal.suggestedQty, 1.5);
  assert.throws(() => holdings.decideSignal(a.id, { approve: true, qty: "5", price: "120" }), /non puoi venderne 5/);
  const done = holdings.decideSignal(a.id, { approve: true, qty: "1", price: "120" });
  assert.equal(done.fill.pnl, Math.round(((120 - 100.5) * 1 - 2 / 3) * 100) / 100, "risultato con la parte delle commissioni d'acquisto");
  const s = await holdings.snapshot();
  assert.equal(s.positions.find((p) => p.symbol === "AAPL").qty, 2);
  assert.equal(s.closed[0].symbol, "AAPL");
  assert.equal(s.totals.wins, 1);
});

test("scartare un segnale non cambia il portafoglio; con lo STOP niente segnali", async () => {
  const q = await stockQuote("ENI.MI");
  const r = await holdings.proposeSignal(analyst, { side: "buy", symbol: "ENI.MI", stop_loss: q.price * 0.9, suggested_pct: 4, risks: RISKS, reason: "Dividendo coperto dai flussi di cassa, valutazione bassa rispetto ai concorrenti." });
  assert.equal(holdings.decideSignal(r.approvalId, { approve: false }).status, "rejected");
  assert.ok(!(await holdings.snapshot()).positions.some((p) => p.symbol === "ENI.MI"));
  safety.activateKill("prova");
  await assert.rejects(holdings.proposeSignal(analyst, { side: "buy", symbol: "ENI.MI", stop_loss: q.price * 0.9, suggested_pct: 4, risks: RISKS, reason: "Stesso segnale ma con lo STOP attivo: deve essere rifiutato." }), /STOP/);
  safety.deactivateKill();
});

test("azioni aggiunte a mano, modifica, vendita totale e rimozione", async () => {
  assert.throws(() => holdings.addBuy({ symbol: "??", qty: 1, price: 1 }), /Simbolo/);
  const p = holdings.addBuy({ symbol: "isp.mi", qty: "100", price: "3,20", stopLoss: "2,9" });
  holdings.addBuy({ symbol: "ISP.MI", qty: "100", price: "3,40" });
  const merged = (await holdings.snapshot()).positions.find((x) => x.symbol === "ISP.MI");
  assert.equal(merged.qty, 200);
  assert.equal(merged.avgPrice, 3.3, "prezzo medio ricalcolato");
  holdings.updatePosition(p.id, { target: "4" });
  holdings.addSell(p.id, { qty: "200", price: "3,5" });
  assert.ok(!(await holdings.snapshot()).positions.some((x) => x.symbol === "ISP.MI"), "venduta tutta: non è più in portafoglio");
  const q = await holdings.addManual({ symbol: "enel.mi", qty: 10, price: "7" });
  assert.equal(q.currency, "USD", "valuta presa da Yahoo (nei test: dati demo)");
  holdings.removePosition(q.id);
  assert.ok(!(await holdings.snapshot()).positions.some((x) => x.symbol === "ENEL.MI"));
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "holdings.json"), "utf8")).closed.length >= 2, "salvato su file");
});

test("stop loss raggiunto: segnale di vendita automatico, una volta sola", async () => {
  const q = await stockQuote("MSFT");
  const p = holdings.addBuy({ symbol: "MSFT", qty: 2, price: q.price * 1.2, stopLoss: q.price * 1.05 });
  const first = await holdings.checkLevels();
  assert.equal(first.length, 1);
  const a = getState().approvals.find((x) => x.id === first[0].approvalId);
  assert.equal(a.agentName, "Controllo portafoglio");
  assert.equal(a.signal.positionId, p.id);
  assert.match(a.signal.reason, /stop loss/);
  holdings.decideSignal(a.id, { approve: false });
  assert.equal((await holdings.checkLevels()).length, 0, "scartato: non si ripete per lo stesso livello");
});

test("strumenti: validi per gli agenti e i segnali in attesa non spariscono dalle Approvazioni", async () => {
  assert.deepEqual(validate({ id: "x", name: "X", room: "r", mode: "llm", model: "claude-haiku-5-5", effort: "low", instructions: "Segue le azioni.", tools: ["my_portfolio", "send_signal"], watchlist: [] }, [{ id: "r" }]), []);
  assert.deepEqual(toolsFor(analyst).map((t) => t.name).sort(), ["my_portfolio", "send_signal"]);
  const { addApproval } = await import("../lib/store.js");
  const q = await stockQuote("NVDA");
  const r = await holdings.proposeSignal(analyst, { side: "buy", symbol: "NVDA", stop_loss: q.price * 0.9, suggested_pct: 3, risks: RISKS, reason: "Segnale che deve restare in attesa anche con molte altre proposte." });
  for (let i = 0; i < 120; i++) addApproval({ id: "post", name: "Post" }, null, { kind: "post" }).status = "rejected";
  assert.ok(getState().approvals.some((x) => x.id === r.approvalId && x.status === "pending"));
  assert.ok(getState().approvals.length <= 100);
});

test("controllo del rischio nel programma: peso massimo per azione e massimo 3 segnali d'acquisto a settimana", async () => {
  const q = await stockQuote("META");
  const base = { side: "buy", symbol: "META", stop_loss: q.price * 0.9, risks: RISKS, reason: "Pubblicità in crescita del 20% e margini in aumento (trimestrale 07/2026)." };
  await assert.rejects(holdings.proposeSignal(analyst, { ...base }), /suggested_pct/);
  await assert.rejects(holdings.proposeSignal(analyst, { ...base, suggested_pct: 13 }), /BLOCCATO.*massimo per una sola azione è 12%/);
  holdings.setProfile({ ...holdings.getProfile(), risk: "basso" });
  await assert.rejects(holdings.proposeSignal(analyst, { ...base, suggested_pct: 9 }), /BLOCCATO.*8%/);
  holdings.setProfile({ ...holdings.getProfile(), risk: "medio" });
  // AAPL, ENI.MI e NVDA sono già stati proposti questa settimana: il quarto si blocca.
  await assert.rejects(holdings.proposeSignal(analyst, { ...base, suggested_pct: 5 }), /negli ultimi 7 giorni/);
});

function round(x) {
  return Math.round(x * 100) / 100;
}
