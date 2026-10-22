// Orario di lavoro degli agenti (ora italiana, anche con il cambio dell'ora) e giorno/ora nei messaggi.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-test-"));
const { romeParts, clockLine, getSchedule, updateSchedule, isWorkingTime, resumeText, isFridayCloseTime, scheduleStatus } =
  await import("../lib/schedule.js");
const { firstMessage } = await import("../lib/runner.js");
const scheduleLib = await import("../lib/schedule.js");

const at = (iso) => new Date(iso);

test("giorno e ora italiana, prima e dopo il cambio dell'ora", () => {
  // 19/10/2026: ora legale (UTC+2); 26/10/2026: ora solare (UTC+1).
  assert.deepEqual(
    (({ weekday, date, time }) => ({ weekday, date, time }))(romeParts(at("2026-10-19T05:30:00Z"))),
    { weekday: 1, date: "2026-10-19", time: "07:30" },
  );
  assert.equal(romeParts(at("2026-10-26T06:30:00Z")).time, "07:30");
  assert.equal(romeParts(at("2026-10-24T21:59:00Z")).label, "sabato 24/10/2026, ore 23:59");
  assert.equal(clockLine(at("2026-10-19T05:45:00Z")), "Adesso è lunedì 19/10/2026, ore 07:45 (ora italiana; 2026-10-19 05:45 UTC).");
});

test("orario di partenza: dal lunedì al venerdì, 07:30–22:30", () => {
  const cfg = getSchedule();
  assert.deepEqual(cfg.days, [1, 2, 3, 4, 5]);
  assert.equal(isWorkingTime(cfg, at("2026-10-19T05:29:00Z")), false); // lunedì 07:29
  assert.equal(isWorkingTime(cfg, at("2026-10-19T05:30:00Z")), true); // lunedì 07:30
  assert.equal(isWorkingTime(cfg, at("2026-10-19T20:29:00Z")), true); // lunedì 22:29
  assert.equal(isWorkingTime(cfg, at("2026-10-19T20:30:00Z")), false); // lunedì 22:30
  assert.equal(isWorkingTime(cfg, at("2026-10-26T06:29:00Z")), false); // lunedì 07:29 con l'ora solare
  assert.equal(isWorkingTime(cfg, at("2026-10-26T06:30:00Z")), true);
  assert.equal(isWorkingTime(cfg, at("2026-10-17T08:00:00Z")), false); // sabato
  assert.equal(isWorkingTime({ ...cfg, enabled: false }, at("2026-10-17T08:00:00Z")), true); // orario spento
});

test("quando ripartono gli agenti", () => {
  const cfg = getSchedule();
  assert.equal(resumeText(cfg, at("2026-10-17T08:00:00Z")), "lunedì alle 07:30"); // sabato mattina
  assert.equal(resumeText(cfg, at("2026-10-16T21:00:00Z")), "lunedì alle 07:30"); // venerdì 23:00
  assert.equal(resumeText(cfg, at("2026-10-19T05:00:00Z")), "oggi alle 07:30"); // lunedì 07:00
  assert.equal(resumeText(cfg, at("2026-10-20T21:00:00Z")), "domani alle 07:30"); // martedì 23:00
  assert.equal(resumeText(cfg, at("2026-10-20T10:00:00Z")), null); // in orario
});

test("chiusura del venerdì", () => {
  const cfg = getSchedule();
  assert.equal(cfg.fridayClose.time, "21:45");
  assert.equal(isFridayCloseTime(cfg, at("2026-10-16T19:44:00Z")), false); // venerdì 21:44
  assert.equal(isFridayCloseTime(cfg, at("2026-10-16T19:45:00Z")), true); // venerdì 21:45
  assert.equal(isFridayCloseTime(cfg, at("2026-10-15T20:00:00Z")), false); // giovedì
  assert.equal(isFridayCloseTime({ ...cfg, fridayClose: { enabled: false, time: "21:45" } }, at("2026-10-16T20:00:00Z")), false);
});

test("salvataggio dell'orario: controlli e valori nuovi", () => {
  assert.throws(() => updateSchedule({ start: "22:00", end: "08:00" }), /fine deve venire dopo/);
  assert.throws(() => updateSchedule({ days: [] }), /almeno un giorno/);
  assert.throws(() => updateSchedule({ start: "7:30" }), /orari non validi/);
  assert.throws(() => updateSchedule({ fridayClose: { time: "25:00" } }), /venerdì non valido/);
  assert.deepEqual(getSchedule().days, [1, 2, 3, 4, 5]); // niente salvato dopo un errore

  const s = updateSchedule({ days: [5, 1, 3, 3], start: "08:00", end: "21:00", fridayClose: { enabled: false } });
  assert.deepEqual(s.days, [1, 3, 5]);
  assert.equal(s.start, "08:00");
  assert.equal(s.fridayClose.enabled, false);
  assert.equal(s.fridayClose.time, "21:45");
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.AGENTI_DATA_DIR, "settings.json"), "utf8"));
  assert.equal(saved.schedule.end, "21:00");
  assert.equal(isWorkingTime(getSchedule(), at("2026-10-20T10:00:00Z")), false); // martedì non è più un giorno di lavoro

  const st = scheduleStatus(at("2026-10-20T10:00:00Z"));
  assert.equal(st.working, false);
  assert.equal(st.resume, "domani alle 08:00");
  updateSchedule({ days: [1, 2, 3, 4, 5], start: "07:30", end: "22:30", fridayClose: { enabled: true } });
});

test("primo messaggio degli agenti con giorno e ora italiana", () => {
  const when = at("2026-10-16T13:05:00Z");
  assert.equal(firstMessage(undefined, when), "Esegui il tuo lavoro ora. Adesso è venerdì 16/10/2026, ore 15:05 (ora italiana; 2026-10-16 13:05 UTC).");
  assert.equal(
    firstMessage("Fai il rapporto della settimana passata.", when),
    "Adesso è venerdì 16/10/2026, ore 15:05 (ora italiana; 2026-10-16 13:05 UTC).\n\nFai il rapporto della settimana passata.",
  );
});

test("agenti settimanali e mensili: non ripartono a ogni apertura; quelli di giornata sì", () => {
  const { lastRunFor, LONG_EVERY_MIN } = scheduleLib;
  const now = new Date("2026-10-21T06:00:00Z"); // mercoledì 08:00 in Italia
  const yesterday = "2026-10-20T06:00:00Z";
  const today = "2026-10-21T05:45:00Z";
  assert.equal(LONG_EVERY_MIN, 1440);
  assert.equal(lastRunFor(60, yesterday, now), 0, "ogni ora: il lavoro di ieri non conta, all'apertura riparte");
  assert.equal(lastRunFor(60, today, now), Date.parse(today));
  assert.equal(lastRunFor(10080, yesterday, now), Date.parse(yesterday), "settimanale: conta il lavoro di ieri");
  assert.equal(lastRunFor(43200, "2026-10-01T06:00:00Z", now), Date.parse("2026-10-01T06:00:00Z"), "mensile");
  assert.equal(lastRunFor(1440, yesterday, now), Date.parse(yesterday), "ogni giorno: riparte dopo 24 ore, non prima");
  assert.equal(lastRunFor(10080, undefined, now), 0, "mai lavorato: parte subito");
  assert.equal(lastRunFor(10080, "non è una data", now), 0);
});
