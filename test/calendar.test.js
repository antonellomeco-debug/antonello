// Calendario economico: lettura delle due fonti, orari italiani, filtri, fonti che non rispondono e cache.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Copia QuarkFX (come il file vero): orari UTC in "datetime", "time" anche "All Day" o "Tentative".
const QUARK = {
  source_file: "forexfactory_21days.json",
  updated_at: "2026-10-13T15:00:38Z",
  events: [
    { title: "CPI m/m", country: "USD", datetime: "2026-10-14T12:30:00Z", date: "2026-10-14", time: "12:30", timezone: "UTC", impact: "High", forecast: "0.6%", consensus: "0.6%", previous: "0.4%", actual: "" },
    { title: "Unemployment Claims", country: "USD", datetime: "2026-10-15T12:30:00Z", date: "2026-10-15", time: "12:30", timezone: "UTC", impact: "Medium", forecast: "199K", previous: "197K", actual: "" },
    { title: "Import Prices m/m", country: "USD", datetime: "2026-10-14T12:30:00Z", date: "2026-10-14", time: "12:30", timezone: "UTC", impact: "Low", forecast: "0.1%", previous: "0.3%", actual: "" },
    { title: "ZEW Economic Sentiment", country: "EUR", datetime: "2026-10-14T09:00:00Z", date: "2026-10-14", time: "09:00", timezone: "UTC", impact: "High", forecast: "40.1", previous: "39.5", actual: "" },
    { title: "ISM Services PMI", country: "USD", datetime: "2026-10-13T14:00:00Z", date: "2026-10-13", time: "14:00", timezone: "UTC", impact: "Medium", forecast: "55.1", previous: "55.4", actual: "54.9" },
    { title: "Treasury Currency Report", country: "USD", datetime: "2026-10-14T00:00:00Z", date: "2026-10-14", time: "Tentative", timezone: "UTC", impact: "Medium", forecast: "", previous: "", actual: "" },
    { title: "Bank Holiday", country: "CAD", datetime: "2026-10-12T00:00:00Z", date: "2026-10-12", time: "All Day", timezone: "UTC", impact: "Non-Economic", forecast: "", previous: "", actual: "" },
    { title: "OPEC Meetings", country: "All", datetime: "2026-10-14T00:00:00Z", date: "2026-10-14", time: "All Day", timezone: "UTC", impact: "Medium", forecast: "", previous: "", actual: "" },
    { title: "", country: "USD", datetime: "2026-10-14T12:30:00Z", time: "12:30", impact: "High" }, // senza titolo: scartato
  ],
};
// File ufficiale di Forex Factory: orari di New York con il fuso nella data.
const FF = [
  { title: "CPI m/m", country: "USD", date: "2026-10-14T08:30:00-04:00", impact: "High", forecast: "0.6%", previous: "0.4%" },
  { title: "Bank Holiday", country: "GBP", date: "2026-10-12T00:00:00-04:00", impact: "Holiday", forecast: "", previous: "" },
];

let mode = "ok"; // "ok" | "down"
const server = http.createServer((req, res) => {
  if (mode === "down" || req.url === "/bad") {
    res.statusCode = 500;
    return res.end("errore");
  }
  res.setHeader("content-type", "application/json");
  if (req.url === "/quark") return res.end(JSON.stringify(QUARK));
  if (req.url === "/ff") return res.end(JSON.stringify(FF));
  if (req.url === "/weird") return res.end(JSON.stringify({ hello: "world" }));
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

process.env.AGENTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "calendar-test-"));
process.env.CALENDAR_URLS = `${base}/bad,${base}/weird,${base}/quark`;
const cal = await import("../lib/calendar.js");
const { ALL_TOOLS, validate, normalize } = await import("../lib/config.js");
const { runTool } = await import("../lib/tools.js");

const tue = new Date("2026-10-13T08:00:00Z"); // martedì 13/10/2026, 10:00 in Italia

test("eventi della copia QuarkFX e del file ufficiale con orario italiano", () => {
  const q = cal.normalizeEvent(QUARK.events[0]);
  assert.deepEqual(
    { day: q.day, time: q.time, impact: q.impact, currency: q.currency, forecast: q.forecast, previous: q.previous },
    { day: "2026-10-14", time: "14:30", impact: "alto", currency: "USD", forecast: "0.6%", previous: "0.4%" },
  );
  const f = cal.normalizeEvent(FF[0]);
  assert.equal(f.at, "2026-10-14T12:30:00.000Z");
  assert.equal(f.time, "14:30");
  assert.equal(cal.normalizeEvent(QUARK.events[5]).time, null); // Tentative: senza orario preciso
  assert.equal(cal.normalizeEvent(QUARK.events[5]).day, "2026-10-14");
  assert.equal(cal.normalizeEvent(FF[1]).time, null); // mezzanotte nel file ufficiale = tutto il giorno
  assert.equal(cal.normalizeEvent(FF[1]).impact, "altro");
  assert.equal(cal.normalizeEvent(QUARK.events[8]), null);
  assert.equal(
    cal.eventLine(cal.normalizeEvent(QUARK.events[4])),
    "mar 13/10 16:00 · USD · ISM Services PMI · impatto medio · previsione 55.1 · precedente 55.4 · USCITO 54.9",
  );
});

test("periodi: oggi, domani, settimana (fino a domenica), weekend con la settimana che arriva", () => {
  assert.deepEqual(cal.periodDays("oggi", tue), ["2026-10-13", "2026-10-13"]);
  assert.deepEqual(cal.periodDays("domani", tue), ["2026-10-14", "2026-10-14"]);
  assert.deepEqual(cal.periodDays("ieri", tue), ["2026-10-12", "2026-10-12"]);
  assert.deepEqual(cal.periodDays("settimana", tue), ["2026-10-13", "2026-10-18"]);
  assert.deepEqual(cal.periodDays("settimana", new Date("2026-10-17T10:00:00Z")), ["2026-10-17", "2026-10-25"]);
  assert.deepEqual(cal.periodDays("7giorni", tue), ["2026-10-13", "2026-10-19"]);
});

test("scarica dalla prima fonte che risponde e filtra per valuta, impatto e giorno", async () => {
  const c = await cal.loadCalendar({ force: true });
  assert.equal(c.stale, false);
  assert.match(c.source, /127\.0\.0\.1/);
  assert.equal(c.events.length, 8);

  const tomorrow = await cal.calendarFor({ giorni: "domani" }, tue);
  assert.deepEqual(tomorrow.eventi, [
    "mer 14/10 (senza orario preciso) · USD · Treasury Currency Report · impatto medio",
    "mer 14/10 (senza orario preciso) · ALL · OPEC Meetings · impatto medio",
    "mer 14/10 14:30 · USD · CPI m/m · impatto alto · previsione 0.6% · precedente 0.4%",
  ]);
  assert.equal(tomorrow.orari, "ora italiana");
  assert.equal(tomorrow.periodo, "mer 14/10");

  const high = await cal.calendarFor({ giorni: "settimana", impatto_minimo: "alto", valute: ["TUTTE"] }, tue);
  assert.deepEqual(high.eventi.map((l) => l.split(" · ")[2]), ["ZEW Economic Sentiment", "CPI m/m"]);

  const all = await cal.calendarFor({ giorni: "domani", impatto_minimo: "basso" }, tue);
  assert.ok(all.eventi.some((l) => l.includes("Import Prices")));

  // Filtro delle notizie per i sistemi: CPI USD alle 12:30 UTC del 14/10, solo ad alto impatto e vicino all'ora.
  assert.equal((await cal.highImpactNear(["USD"], 30, new Date("2026-10-14T12:10:00Z"))).length, 1);
  assert.equal((await cal.highImpactNear(["USD"], 30, new Date("2026-10-14T11:30:00Z"))).length, 0);
  assert.equal((await cal.highImpactNear(["JPY"], 30, new Date("2026-10-14T12:30:00Z"))).length, 0);

  const none = await cal.calendarFor({ giorni: "domani", valute: ["JPY"], impatto_minimo: "alto" }, tue);
  assert.deepEqual(none.eventi, []);
  assert.match(none.nota, /Nessun evento/);
});

test("fonte irraggiungibile: usa il calendario salvato e lo dice", async () => {
  mode = "down";
  process.env.CALENDAR_TTL_MIN = "0"; // il calendario salvato è "vecchio": si prova a riscaricarlo
  const r = await cal.calendarFor({ giorni: "domani" }, tue);
  assert.match(r.avviso, /ultimo aggiornamento/);
  assert.equal(r.eventi.length, 3);
  const c = await cal.loadCalendar(); // dopo un errore non si riprova subito: si usa il salvato
  assert.equal(c.stale, true);
  assert.match(c.error, /non disponibile/);
  delete process.env.CALENDAR_TTL_MIN;
  mode = "ok";
});

test("nessuna fonte e nessun calendario salvato: errore chiaro", async () => {
  cal.resetCalendarCache();
  mode = "down";
  await assert.rejects(() => cal.loadCalendar({ force: true }), /Calendario economico non disponibile: .*ha risposto 500/);
  mode = "ok";
  await cal.loadCalendar({ force: true }); // di nuovo disponibile
});

test("il file ufficiale di Forex Factory funziona come riserva", async () => {
  cal.resetCalendarCache();
  process.env.CALENDAR_URLS = `${base}/bad,${base}/ff`;
  const r = await cal.calendarFor({ giorni: "domani" }, tue);
  assert.deepEqual(r.eventi, ["mer 14/10 14:30 · USD · CPI m/m · impatto alto · previsione 0.6% · precedente 0.4%"]);
  process.env.CALENDAR_URLS = `${base}/quark`;
  await cal.loadCalendar({ force: true });
});

test("get_calendar è uno strumento degli agenti", async () => {
  assert.ok(ALL_TOOLS.includes("get_calendar"));
  const agent = normalize({ id: "cal", room: "ricerca", mode: "llm", instructions: "x", tools: ["get_calendar", "post_note"] });
  assert.deepEqual(validate(agent, [{ id: "ricerca" }]), []);
  const out = await runTool(agent, "get_calendar", { giorni: "7giorni", valute: ["TUTTE"], impatto_minimo: "basso" });
  assert.ok(Array.isArray(out.eventi));
  assert.match(out.fonte, /Forex Factory/);
  await assert.rejects(() => runTool(normalize({ id: "x", room: "ricerca", tools: ["post_note"] }), "get_calendar", {}), /non abilitato/);
});

test("valute di uno strumento per il filtro delle notizie", () => {
  assert.deepEqual(cal.currenciesOf("EURUSD"), ["EUR", "USD"]);
  assert.deepEqual(cal.currenciesOf("XAUUSD"), ["USD"]);
  assert.deepEqual(cal.currenciesOf("US500"), ["USD"]);
  assert.deepEqual(cal.currenciesOf("GER40"), ["EUR"]);
  assert.deepEqual(cal.currenciesOf("GBPJPY"), ["GBP", "JPY"]);
});
