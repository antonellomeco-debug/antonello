// Report settimanali in PDF: strumenti weekly_report e week_notes, appuntamento fisso degli agenti (runDays/runAt),
// invio per email con Resend (finto server via RESEND_BASE) e pagine del server per vederli. PDF finto (REPORT_PDF=fake).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startServer, tempDir } from "./helpers/server.js";

// Finto Resend: registra le richieste, risponde come l'API vera (o con l'errore scelto).
const sent = [];
let reply = { status: 200, body: { id: "em_1" } };
const resend = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    sent.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply.body));
  });
});
await new Promise((r) => resend.listen(0, "127.0.0.1", r));
const RESEND_BASE = `http://127.0.0.1:${resend.address().port}`;
after(() => resend.close());

process.env.AGENTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "reports-test-"));
process.env.MARKET_MODE = "demo";
process.env.REPORT_PDF = "fake";
process.env.RESEND_BASE = RESEND_BASE;
const { postNote } = await import("../lib/store.js");
const { office } = await import("../lib/office.js");
const { normalize, validate } = await import("../lib/config.js");
const { runTool } = await import("../lib/tools.js");
const { appointmentDue, hasAppointment } = await import("../lib/schedule.js");
const reports = await import("../lib/reports.js");
const mailer = await import("../lib/mailer.js");
const costs = await import("../lib/costs.js");

const b = () => office.building();
const palace = () => b().palaces[0];
const roomsOf = (pid) => b().rooms.filter((r) => b().floors.find((f) => f.id === r.floor)?.palace === pid);
const reporter = (extra = {}) => normalize({ id: "reporter", name: "Reporter", room: roomsOf(palace().id)[0].id, tools: ["week_notes", "weekly_report"], instructions: "x", ...extra });
const INPUT = {
  title: "Report settimanale – <Palazzo> & co",
  summary: "Settimana buona.\n\n- 3 operazioni\n- **2 vinte**",
  kpis: [{ label: "Netto", value: "+120 €", change: "+12%" }],
  sections: [{ title: "Operazioni", text: "Testo", table: { columns: ["Simbolo", "Netto"], rows: [["XAUUSD", 80], ["EURUSD", -20]] } }],
  next_week: ["Ridurre il rischio sull'oro"],
  for_user: ["Controllare il conto demo"],
  include: ["spesa", "operazioni"],
};

test("appuntamento fisso: una volta nei suoi giorni, dopo l'ora, anche a palazzo chiuso", () => {
  const a = reporter({ runDays: [0], runAt: "18:00" });
  assert.equal(hasAppointment(a), true);
  const sun1805 = new Date("2026-11-01T17:05:00Z"); // domenica 18:05 in Italia (ora solare)
  assert.equal(appointmentDue(a, null, sun1805), true);
  assert.equal(appointmentDue(a, "2026-11-01", sun1805), false, "già fatto oggi");
  assert.equal(appointmentDue(a, "2026-10-25", sun1805), true, "fatto domenica scorsa");
  assert.equal(appointmentDue(a, null, new Date("2026-11-01T16:59:00Z")), false, "prima delle 18");
  assert.equal(appointmentDue(a, null, new Date("2026-10-31T17:05:00Z")), false, "sabato");
  assert.equal(appointmentDue(reporter({ runDays: [0] }), null, sun1805), true, "18:00 di partenza");
  assert.equal(hasAppointment(reporter({ runDays: [] })), false);
  assert.deepEqual(validate(a, b().rooms), []);
  assert.match(validate(reporter({ runDays: [7] }), b().rooms).join(), /runDays/);
  assert.match(validate(reporter({ runDays: [0, 0] }), b().rooms).join(), /runDays/);
  assert.match(validate(reporter({ runDays: [0], runAt: "25:00" }), b().rooms).join(), /runAt/);
  // Stima della spesa: una volta per giorno scelto (circa 4,3 al mese), non ogni everyMinutes.
  const row = costs.costReport([{ ...a, everyMinutes: 5 }], b()).agents[0];
  assert.equal(row.monthlyEstimate, 0, "nessun lavoro fatto: costo medio ancora 0");
});

test("week_notes: note di tutte le stanze del palazzo, anche quelle che l'agente non legge", async () => {
  const rooms = roomsOf(palace().id);
  assert.ok(rooms.length >= 2, "servono almeno 2 stanze nel palazzo di prova");
  postNote(rooms[0].id, { id: "a1", name: "Analista" }, "prima nota");
  postNote(rooms.at(-1).id, { id: "a2", name: "Trader" }, "x".repeat(2000));
  const r = await runTool(reporter(), "week_notes", {}, b());
  assert.equal(r.palazzo, palace().id);
  const ids = r.stanze.map((s) => s.id);
  assert.ok(ids.includes(rooms[0].id) && ids.includes(rooms.at(-1).id));
  const long = r.stanze.find((s) => s.id === rooms.at(-1).id).note[0];
  assert.ok(long.testo.length <= 701, "note lunghe accorciate");
  await assert.rejects(runTool(reporter(), "week_notes", { palace: "nessuno" }, b()), /non esiste/);
  await assert.rejects(runTool(reporter({ tools: [] }), "week_notes", {}, b()), /non abilitato/);
});

test("weekly_report senza email impostata: PDF salvato, niente email", async () => {
  const r = await runTool(reporter(), "weekly_report", INPUT, b());
  assert.equal(r.file, "pdf");
  assert.match(r.email, /non impostata/);
  assert.equal(sent.length, 0);
  const list = reports.listReports();
  assert.equal(list.length, 1);
  assert.equal(list[0].palace, palace().id);
  const f = reports.reportFile(list[0].id);
  assert.match(fs.readFileSync(f.file, "utf8"), /^%PDF/);
  assert.equal(reports.reportFile("../index"), null, "niente percorsi fuori dalla cartella");
  // Un report per volta: il secondo nelle 6 ore serve replace.
  await assert.rejects(runTool(reporter(), "weekly_report", INPUT, b()), /replace: true/);
  await assert.rejects(runTool(reporter(), "weekly_report", { title: "", summary: "x", sections: [], next_week: [] }, b()), /title/);
});

test("la pagina del report è escapata e ha le tabelle con i dati veri", () => {
  const html = reports.reportHtml({ ...INPUT, period: "Settimana", palaceName: "P", agentName: "<b>A</b>", atLabel: "oggi", auto: { spesa: reports.spesaHtml({ totale: 1.5, giorni: [{ giorno: "2026-10-19", spesa: 1.5 }], agenti: [], mese_in_corso: {} }) } });
  assert.ok(!html.includes("<Palazzo>") && html.includes("&lt;Palazzo&gt; &amp; co"));
  assert.ok(!html.includes("<b>A</b>") && html.includes("<b>2 vinte</b>"), "solo il **grassetto** diventa HTML");
  assert.match(html, /<td class="n">80<\/td>/);
  assert.match(html, /Totale ultimi 7 giorni: 1,50 \$/);
  assert.ok(!/<script/i.test(html));
  assert.match(html, /Cosa faremo la prossima settimana/);
});

test("Resend: impostazioni controllate, la chiave non si vede mai intera", () => {
  assert.throws(() => mailer.setMailSettings({ key: "sk-123" }), /re_/);
  assert.throws(() => mailer.setMailSettings({ to: "non-una-email" }), /Email/);
  assert.throws(() => mailer.setMailSettings({ from: "Io <x@y.z>\r\nBcc: a@b.it" }), /Mittente/);
  const s = mailer.setMailSettings({ key: " re_abcdefghij1234 ", to: "utente@example.com" });
  assert.equal(s.configured, true);
  assert.equal(s.keyHint, "…1234");
  assert.ok(!JSON.stringify(s).includes("re_abcdefghij1234"));
  assert.equal(s.from, mailer.DEFAULT_FROM);
});

test("weekly_report con l'email: il PDF arriva come allegato", async () => {
  const r = await runTool(reporter(), "weekly_report", { ...INPUT, replace: true }, b());
  assert.match(r.email, /inviato per email a utente@example\.com/);
  assert.equal(reports.listReports().length, 1, "replace sostituisce il report di prima");
  const m = sent.at(-1);
  assert.equal(m.url, "/emails");
  assert.equal(m.auth, "Bearer re_abcdefghij1234");
  assert.deepEqual(m.body.to, ["utente@example.com"]);
  assert.match(m.body.subject, /Report settimanale/);
  assert.match(m.body.html, /Ridurre il rischio/);
  assert.equal(m.body.attachments.length, 1);
  assert.match(m.body.attachments[0].filename, /\.pdf$/);
  assert.match(Buffer.from(m.body.attachments[0].content, "base64").toString(), /^%PDF/);
  assert.equal(reports.listReports()[0].email.status, "sent");
});

test("Resend rifiuta: messaggio chiaro, il report resta", async () => {
  reply = { status: 403, body: { statusCode: 403, message: "You can only send testing emails to your own email address (x@y.z)." } };
  const id = reports.listReports()[0].id;
  await assert.rejects(reports.mailReport(id), /solo all'email con cui ti sei registrato/);
  assert.equal(reports.listReports()[0].email.status, "failed");
  reply = { status: 401, body: { message: "API key is invalid" } };
  await assert.rejects(mailer.sendTestMail(), /chiave non è valida/);
  reply = { status: 200, body: { id: "em_2" } };
  const ok = await reports.mailReport(id);
  assert.equal(ok.email.status, "sent");
  assert.deepEqual(reports.deleteReport(id), { deleted: id });
  assert.equal(reports.listReports().length, 0);
});

test("server: elenco, PDF, impostazione dell'email, prova e invio", async () => {
  const dataDir = tempDir("reports-srv-");
  const dir = path.join(dataDir, "reports");
  fs.mkdirSync(dir, { recursive: true });
  const id = "r-20261101-reporter-abc123";
  fs.writeFileSync(path.join(dir, `${id}.pdf`), "%PDF-1.4\n%%EOF\n");
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify([{ id, at: new Date().toISOString(), title: "Report di prova", period: "Settimana", summary: "ok", palace: null, palaceName: null, agentId: "reporter", agentName: "Reporter", file: `${id}.pdf`, type: "pdf", bytes: 15, email: { status: "off" } }]));
  const srv = await startServer({ RESEND_BASE }, { dataDir });
  try {
    const list = await srv.req("GET", "/api/reports");
    assert.equal(list.json.reports.length, 1);
    assert.equal(list.json.mail.configured, false);
    const pdf = await srv.req("GET", `/api/reports/${id}/file`);
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers["content-type"], /application\/pdf/);
    assert.match(pdf.headers["content-disposition"], /^inline/);
    assert.match((await srv.req("GET", `/api/reports/${id}/file?download=1`)).headers["content-disposition"], /^attachment/);
    assert.equal((await srv.req("GET", "/api/reports/..%2Fsettings/file")).status, 404);
    assert.equal((await srv.req("PUT", "/api/reports/mail", { body: { key: "chiave" } })).status, 400);
    const set = await srv.req("PUT", "/api/reports/mail", { body: { key: "re_serverkey9876", to: "utente@example.com" } });
    assert.equal(set.status, 200);
    assert.ok(!set.body.includes("re_serverkey9876"));
    assert.equal(set.json.mail.keyHint, "…9876");
    const n = sent.length;
    assert.equal((await srv.req("POST", "/api/reports/mail/test")).status, 200);
    assert.equal(sent.length, n + 1);
    assert.equal(sent.at(-1).auth, "Bearer re_serverkey9876");
    const again = await srv.req("POST", `/api/reports/${id}/mail`);
    assert.equal(again.json.email.status, "sent");
    assert.equal(sent.at(-1).body.attachments[0].filename, `Report-di-prova-${new Date().toISOString().slice(0, 10)}.pdf`);
    const del = await srv.req("DELETE", `/api/reports/${id}`);
    assert.equal(del.json.reports.length, 0);
  } finally {
    await srv.stop();
  }
});
