import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFake, ACCOUNTS } from "./helpers/fake-ctrader.js";

const fake = await startFake();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ctrader-test-"));
Object.assign(process.env, {
  AGENTI_DATA_DIR: dataDir,
  CTRADER_TLS: "0",
  CTRADER_DEMO_HOST: "127.0.0.1",
  CTRADER_LIVE_HOST: "127.0.0.1",
  CTRADER_PORT: String(fake.port),
  CTRADER_AUTH_URL: "http://127.0.0.1/auth",
  CTRADER_TOKEN_URL: `http://127.0.0.1:${fake.tokenPort}/apps/token`,
});
const ct = await import("../lib/ctrader/service.js");
const REDIRECT = "http://localhost:3000/ctrader/callback";
const demo = ACCOUNTS.demo;

after(() => fake.close());

test("credenziali sbagliate: errore chiaro", async () => {
  ct.setCredentials({ clientId: "client-bad", clientSecret: "secret-bad" });
  ct.startAuth(REDIRECT);
  await assert.rejects(ct.finishAuth("code-ok"), /rifiutato l'accesso/);
});

test("accesso OAuth: URL corretto, codice scambiato, conti elencati", async () => {
  ct.setCredentials({ clientId: "client-ok", clientSecret: "secret-ok" });
  const url = new URL(ct.startAuth(REDIRECT));
  assert.equal(url.searchParams.get("client_id"), "client-ok");
  assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(url.searchParams.get("scope"), "trading");
  await assert.rejects(ct.finishAuth("code-wrong"), /Invalid code/);
  ct.startAuth(REDIRECT);
  const st = await ct.finishAuth("code-ok");
  assert.equal(st.linked, true);
  assert.deepEqual(st.accounts.map((a) => [a.ctidTraderAccountId, a.isLive]), [[ACCOUNTS.demo, false], [ACCOUNTS.live, true]]);
  assert.equal(st.dataAccountId, ACCOUNTS.demo, "per i dati si usa il conto demo");
  assert.equal(JSON.stringify(st).includes("secret-ok"), false, "lo stato non espone il secret");
  assert.equal(JSON.stringify(st).includes("tok-1"), false, "lo stato non espone i token");
  const mode = fs.statSync(path.join(dataDir, "ctrader.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("accesso OAuth: lo state del ritorno deve essere quello dell'ultima richiesta e vale una volta sola", async () => {
  const state = new URL(ct.startAuth(REDIRECT)).searchParams.get("state");
  assert.match(state, /^[A-Za-z0-9_-]{20,}$/, "lo state è un codice casuale");
  assert.equal(ct.pendingStateMatches(state), true);
  assert.equal(ct.pendingStateMatches("sbagliato"), false);
  const other = new URL(ct.startAuth(REDIRECT)).searchParams.get("state");
  assert.notEqual(other, state, "ogni «Collega cTrader» ha uno state nuovo");
  assert.equal(ct.pendingStateMatches(state), false, "lo state vecchio non vale più");
  await assert.rejects(ct.finishAuth("code-ok", REDIRECT, { state }), /non corrisponde/);
  assert.equal(ct.pendingStateMatches(other), false, "dopo un tentativo lo state è consumato");
  const fresh = new URL(ct.startAuth(REDIRECT)).searchParams.get("state");
  const st = await ct.finishAuth("code-ok", REDIRECT, { state: fresh });
  assert.equal(st.linked, true);
  await assert.rejects(ct.finishAuth("code-ok", REDIRECT, { state: fresh }), /non corrisponde|già stato usato/);
  // incollando l'indirizzo a mano (senza state) il collegamento resta possibile
  ct.startAuth(REDIRECT);
  assert.equal((await ct.finishAuth("code-ok", REDIRECT)).linked, true);
});

test("informazioni sul conto: saldo, valuta, leva", async () => {
  const info = await ct.accountInfo(demo);
  assert.equal(info.balance, 10000);
  assert.equal(info.currency, "EUR");
  assert.equal(info.leverage, 30);
  assert.equal(info.accountType, "HEDGED");
});

test("ricerca strumenti per nome e descrizione", async () => {
  assert.deepEqual((await ct.search(demo, "eur")).map((s) => s.symbol), ["EURUSD"]);
  assert.deepEqual((await ct.search(demo, "gold")).map((s) => s.symbol), ["XAUUSD"]);
  assert.equal(await ct.hasSymbol(demo, "eur/usd"), true);
  assert.equal(await ct.hasSymbol(demo, "AAPL"), false);
});

test("elenco dei mercati del broker con categoria e classe (per lo scanner)", async () => {
  const list = await ct.catalog(demo);
  assert.deepEqual(list.map((m) => [m.symbol, m.category, m.assetClass]), [
    ["EURUSD", "Majors", "Forex"], ["XAUUSD", "Spot Metals", "Metals"], ["US500", "Cash Indices", "Indices"], ["ENI.IT", "Italian Shares", "Stocks"],
  ]);
  const { groupOf } = await import("../strategies/scanner.js");
  assert.deepEqual(list.map(groupOf), ["forex", "metalli", "indici", "azioni"]);
});

test("candele: ordinate, OHLC convertiti, limite di velocità rispettato", async () => {
  const t0 = Date.now();
  const bars = await ct.candles(demo, "EURUSD", "D1", 10);
  assert.ok(Date.now() - t0 >= 900, "dopo BLOCKED_PAYLOAD_TYPE aspetta retryAfter");
  assert.equal(bars.length, 10);
  assert.ok(bars.every((b, i) => i === 0 || b.time > bars[i - 1].time));
  const b = bars[0];
  const pts = (x) => Math.round(x * 100000); // confronto in punti interi, senza errori di arrotondamento
  assert.equal(pts(b.open), pts(b.low) + 20);
  assert.equal(pts(b.high), pts(b.low) + 80);
  assert.equal(pts(b.close), pts(b.low) + 50);
});

test("prezzo: denaro/lettera e prezzo medio", async () => {
  const q = await ct.quote(demo, "EURUSD");
  assert.equal(q.symbol, "EURUSD");
  assert.ok(q.bid >= 1.085 && q.bid <= 1.08501);
  assert.equal(q.ask, 1.08502);
  assert.equal(q.source, "ctrader-demo");
});

test("conversione lotti → volume del protocollo", () => {
  const d = { lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000, maxVolume: 10_000_000_000 };
  assert.equal(ct.lotsToVolume(0.01, d), 100_000);
  assert.equal(ct.lotsToVolume(0.015, d), 100_000);
  assert.equal(ct.lotsToVolume(1, d), 10_000_000);
  assert.throws(() => ct.lotsToVolume(0.001, d), /troppo piccola/);
  assert.throws(() => ct.lotsToVolume(2000, d), /troppo grande/);
});

test("ordine a mercato con stop loss relativo, posizione, chiusura parziale e totale", async () => {
  const r = await ct.placeOrder(demo, { symbol: "EURUSD", side: "buy", lots: 0.1, stopLossPct: 1, label: "agenti:test", comment: "prova" });
  assert.equal(r.status, "filled");
  assert.equal(r.lots, 0.1);
  assert.ok(r.positionId);
  const sent = fake.state.received.filter((m) => m.name === "ProtoOANewOrderReq").at(-1).data;
  assert.equal(sent.orderType, "MARKET");
  assert.equal(sent.volume, 1_000_000);
  assert.equal(sent.stopLoss, undefined, "niente SL assoluto sugli ordini a mercato");
  assert.equal(sent.relativeStopLoss, Math.round(1.0852 * 0.01 * 100000));
  let pos = await ct.positions(demo);
  assert.equal(pos.length, 1);
  assert.equal(pos[0].lots, 0.1);
  assert.equal(pos[0].label, "agenti:test");
  assert.equal(pos[0].pnl, -15);
  const part = await ct.closePosition(demo, r.positionId, 0.05);
  assert.equal(part.status, "closed");
  pos = await ct.positions(demo);
  assert.equal(pos[0].lots, 0.05);
  const all = await ct.closeAgentPositions(demo);
  assert.equal(all.length, 1);
  assert.equal((await ct.positions(demo)).length, 0);
});

test("errore del broker tradotto (quantità non valida)", async () => {
  await assert.rejects(ct.placeOrder(demo, { symbol: "EURUSD", side: "sell", lots: 0.001 }), /troppo piccola/);
});

test("riconnessione dopo la caduta della linea", async () => {
  fake.dropConnections();
  await new Promise((r) => setTimeout(r, 100));
  const q = await ct.quote(demo, "XAUUSD");
  assert.equal(q.symbol, "XAUUSD");
});

test("rinnovo dei token: il nuovo refresh token viene salvato", async () => {
  const file = path.join(dataDir, "ctrader.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.token.expiresAt = Date.now() + 1000; // sta per scadere
  fs.writeFileSync(file, JSON.stringify(cfg));
  // Il modulo tiene la configurazione in memoria: si forza la scadenza ricaricandolo tramite setDataAccount+status.
  const mod = await import(`../lib/ctrader/service.js?reload=${Date.now()}`);
  await mod.accountInfo(demo).catch(() => {}); // il modulo ricaricato legge il file e rinnova
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.token.refreshToken, "ref-2");
  assert.equal(after.token.accessToken, "tok-2");
});
