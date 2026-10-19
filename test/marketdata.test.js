// Dati ufficiali per gli agenti: bilanci e 13F dalla SEC, IPO, risultati e notizie da Finnhub; diario delle operazioni.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const seen = [];
const fact = (val, start, end, form, filed) => ({ val, start, end, form, filed, fy: 2025, fp: "FY" });
const infoTable = (rows) => `<?xml version="1.0"?><informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">${rows
  .map(([n, cusip, v, sh]) => `<infoTable><nameOfIssuer>${n}</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>${cusip}</cusip><value>${v}</value><shrsOrPrnAmt><sshPrnamt>${sh}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>`)
  .join("")}</informationTable>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  seen.push({ path: u.pathname, ua: req.headers["user-agent"], token: u.searchParams.get("token") });
  const json = (body, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (u.pathname === "/files/company_tickers.json") return json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, 1: { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" } });
  if (u.pathname === "/api/xbrl/companyfacts/CIK0000320193.json") {
    return json({
      entityName: "Apple Inc.",
      facts: {
        dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ val: 15e9, end: "2026-07-18", form: "10-Q", filed: "2026-08-01" }] } } },
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
            fact(391e9, "2023-10-01", "2024-09-28", "10-K", "2024-11-01"), fact(416e9, "2024-09-29", "2025-09-27", "10-K", "2025-10-31"),
            fact(94e9, "2026-03-29", "2026-06-27", "10-Q", "2026-08-01"), fact(416e9, "2024-09-29", "2025-09-27", "10-K", "2025-10-30"),
          ] } },
          NetIncomeLoss: { units: { USD: [fact(112e9, "2024-09-29", "2025-09-27", "10-K", "2025-10-31")] } },
          NetCashProvidedByUsedInOperatingActivities: { units: { USD: [fact(118e9, "2024-09-29", "2025-09-27", "10-K", "2025-10-31")] } },
          PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [fact(12e9, "2024-09-29", "2025-09-27", "10-K", "2025-10-31")] } },
          CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ val: 30e9, end: "2026-06-27", form: "10-Q", filed: "2026-08-01" }] } },
        },
      },
    });
  }
  if (u.pathname === "/submissions/CIK0001067983.json") {
    return json({ name: "BERKSHIRE HATHAWAY INC", filings: { recent: { form: ["10-Q", "13F-HR", "13F-HR"], accessionNumber: ["0001-26-1", "0000950123-26-000200", "0000950123-26-000100"], filingDate: ["2026-08-03", "2026-08-14", "2026-05-15"], reportDate: ["2026-06-30", "2026-06-30", "2026-03-31"] } } });
  }
  const idx = u.pathname.match(/^\/Archives\/edgar\/data\/1067983\/(\d+)\/index\.json$/);
  if (idx) return json({ directory: { item: [{ name: "primary_doc.xml" }, { name: `infotable${idx[1].slice(-3)}.xml` }] } });
  if (u.pathname.endsWith("infotable200.xml")) { res.end(infoTable([["APPLE INC", "037833100", 60e9, 300e6], ["APPLE INC", "037833100", 1e9, 5e6], ["CHUBB LTD", "H1467J104", 8e9, 27e6], ["OCCIDENTAL PETE", "674599105", 12e9, 260e6]])); return; }
  if (u.pathname.endsWith("infotable100.xml")) { res.end(infoTable([["APPLE INC", "037833100", 70e9, 400e6], ["OCCIDENTAL PETE", "674599105", 12e9, 255e6], ["PARAMOUNT", "92556H206", 1e9, 60e6]])); return; }
  if (u.pathname === "/calendar/ipo") return json({ ipoCalendar: [{ date: "2026-11-05", exchange: "NASDAQ Global", name: "Prova Spa", numberOfShares: 1e7, price: "18-20", status: "expected", symbol: "PRVA", totalSharesValue: 2e8 }] });
  if (u.pathname === "/calendar/earnings") return json({ earningsCalendar: [{ date: "2026-10-30", epsActual: null, epsEstimate: 1.6, hour: "amc", quarter: 4, revenueActual: null, revenueEstimate: 1.2e11, symbol: "AAPL", year: 2026 }] });
  if (u.pathname === "/company-news") return json([{ datetime: 1792430000, headline: "Apple presenta i risultati", source: "Reuters", summary: "Ricavi in crescita", url: "https://example.com/a" }]);
  if (u.pathname === "/quote") return json(u.searchParams.get("token") === "fh-wrong-key-0" ? {} : { c: 182, dp: 1, pc: 180, t: 1792430000 }, u.searchParams.get("token") === "fh-wrong-key-0" ? 401 : 200);
  json({ error: "not found" }, 404);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
  AGENTI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "marketdata-test-")),
  MARKET_MODE: "demo", SEC_WWW_BASE: base, SEC_DATA_BASE: base, FINNHUB_BASE: base,
});
const md = await import("../lib/marketdata.js");
const { runTool } = await import("../lib/tools.js");
const { tradeJournal } = await import("../lib/journal.js");
const holdings = await import("../lib/holdings.js");
after(() => server.close());

const analyst = { id: "dcf", name: "Valutazione DCF", room: "r", tools: ["company_financials", "fund_holdings", "ipo_calendar", "earnings_calendar", "company_news", "trade_journal"], canTrade: false, watchlist: [], limits: {} };

test("senza nome ed email la SEC non si usa (e lo dice)", async () => {
  await assert.rejects(md.companyFinancials("AAPL"), /nome ed email/);
  assert.throws(() => md.setSecContact("solo nome"), /nome ed email/);
  md.setSecContact("Mario Rossi mario@esempio.it");
});

test("bilanci ufficiali dalla SEC: annuali, trimestri, cassa e flusso di cassa libero", async () => {
  const f = await runTool(analyst, "company_financials", { ticker: "aapl" });
  assert.equal(f.societa, "Apple Inc.");
  const r = f.voci.ricavi;
  assert.equal(r.concept, "RevenueFromContractWithCustomerExcludingAssessedTax");
  assert.deepEqual(r.annuali.map((x) => x.valore), [416e9, 391e9]);
  assert.equal(r.annuali[0].depositato, "2025-10-31", "per lo stesso periodo vale il documento più recente");
  assert.equal(r.trimestri[0].valore, 94e9);
  assert.equal(f.voci.cassa.latest[0].valore, 30e9);
  assert.equal(f.voci.azioni_in_circolazione.latest[0].valore, 15e9);
  assert.equal(f.voci.flusso_cassa_libero.annuali[0].valore, 106e9);
  assert.ok(seen.some((s) => s.ua === "Mario Rossi mario@esempio.it"), "la SEC riceve nome ed email");
  await assert.rejects(md.companyFinancials("ENI.MI"), /solo per le società quotate negli USA/);
});

test("13F di un grande fondo: pesi e cambi rispetto al trimestre prima", async () => {
  const h = await runTool(analyst, "fund_holdings", { fund: "Berkshire" });
  assert.equal(h.fondo, "BERKSHIRE HATHAWAY INC");
  assert.equal(h.trimestre, "2026-06-30");
  const apple = h.principali[0];
  assert.equal(apple.titolo, "APPLE INC");
  assert.equal(apple.valore_usd, 61e9, "righe dello stesso titolo sommate");
  assert.match(apple.rispetto_al_trimestre_prima, /ridotta/);
  assert.equal(h.principali.find((x) => x.titolo === "CHUBB LTD").rispetto_al_trimestre_prima, "NUOVA");
  assert.equal(h.principali.find((x) => x.titolo === "OCCIDENTAL PETE").rispetto_al_trimestre_prima, "invariata");
  assert.deepEqual(h.vendute_del_tutto, ["PARAMOUNT"]);
  await assert.rejects(md.fundHoldings({ fund: "fondo inventato" }), /Fondo non riconosciuto/);
});

test("Finnhub: senza chiave lo dice; con la chiave IPO, risultati e notizie", async () => {
  await assert.rejects(md.ipoCalendar(), /Finnhub non è attivo/);
  await assert.rejects(md.setFinnhubKey("fh-wrong-key-0"), /non è valida/);
  const st = await md.setFinnhubKey("fh-good-key-123");
  assert.equal(st.finnhub.configured, true);
  const ipo = await runTool(analyst, "ipo_calendar", {});
  assert.deepEqual([ipo.ipo[0].nome, ipo.ipo[0].prezzo, ipo.ipo[0].borsa], ["Prova Spa", "18-20", "NASDAQ Global"]);
  const earn = await runTool(analyst, "earnings_calendar", { symbol: "aapl" });
  assert.deepEqual([earn.risultati[0].quando, earn.risultati[0].trimestre, earn.risultati[0].eps_stimato], ["dopo la chiusura", "T4 2026", 1.6]);
  const news = await runTool(analyst, "company_news", { symbol: "AAPL" });
  assert.equal(news.notizie[0].fonte, "Reuters");
  assert.ok(seen.filter((s) => s.path === "/calendar/ipo").every((s) => s.token === "fh-good-key-123"));
});

test("diario delle operazioni: segnali per agente e vendite del portafoglio", async () => {
  holdings.setProfile({ capital: 10000, risk: "medio", horizon: "medio" });
  const ag = { id: "capo", name: "Capo Investimenti", room: "r", canTrade: false, watchlist: [], limits: {} };
  const { stockQuote } = await import("../lib/market.js");
  const q = await stockQuote("MSFT");
  const r = await holdings.proposeSignal(ag, { side: "buy", symbol: "MSFT", stop_loss: q.price * 0.9, suggested_pct: 5, risks: "Rischio di rallentamento del cloud e concorrenza sui prezzi dell'IA.", reason: "Cloud in crescita e margini in aumento nell'ultimo trimestre." });
  holdings.decideSignal(r.approvalId, { approve: true, qty: 2, price: q.price });
  const p = (await holdings.snapshot()).positions.find((x) => x.symbol === "MSFT");
  const s = await holdings.proposeSignal(ag, { side: "sell", symbol: "MSFT", position_id: p.id, reason: "Tesi cambiata dopo la guidance tagliata dalla società." });
  holdings.decideSignal(s.approvalId, { approve: true, qty: 2, price: q.price * 1.1 });
  const j = await runTool(analyst, "trade_journal", { days: 30 });
  assert.equal(j.conto_ctrader, "non collegato");
  assert.equal(j.portafoglio_vero.vendite_chiuse[0].simbolo, "MSFT");
  const a = j.segnali_per_agente["Capo Investimenti"];
  assert.deepEqual([a.proposti, a.approvati, a.acquisti, a.vendite], [2, 2, 1, 1]);
  assert.ok(a.risultato_vendite > 0);
});
