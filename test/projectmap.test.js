// Mappa del progetto (lib/projectmap.js): tutta la struttura e i risultati, mai chiavi o password.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "projectmap-test-"));
process.env.MARKET_MODE = "demo";
const { projectMap } = await import("../lib/projectmap.js");
const { office } = await import("../lib/office.js");
const { postNote, log } = await import("../lib/store.js");
const { updateSettings } = await import("../lib/settings.js");
const social = await import("../lib/social/index.js");

const SECRETS = ["sk-ant-SEGRETO-claude-123", "AIzaSEGRETOgemini456", "re_SEGRETOresend789", "GOCSPX-SEGRETO-google", "xi-SEGRETO-eleven"];

test("mappa: palazzi, piani, stanze, agenti con istruzioni e lavoro, note recenti, collegamenti, spesa", () => {
  const b = office.building();
  const agent = office.agents()[0];
  postNote(agent.room, agent, "Analisi del giorno: EURUSD in tendenza rialzista.", ["ANALISI"]);
  log(agent.id, "warn", "get_quote fallito: timeout");
  const m = projectMap();
  assert.equal(m.numeri.agenti, office.agents().length);
  assert.equal(m.numeri.palazzi, b.palaces.length);
  const rooms = m.palazzi.flatMap((p) => p.piani.flatMap((f) => f.stanze));
  assert.equal(rooms.length, b.rooms.length);
  const room = rooms.find((r) => r.id === agent.room);
  assert.equal(room.note_totali, 1);
  assert.match(room.ultime_note[0].testo, /EURUSD/);
  const a = room.agenti.find((x) => x.id === agent.id);
  assert.equal(a.instructions, agent.instructions, "istruzioni intere");
  assert.deepEqual(a.tools, agent.tools);
  assert.equal(a.lavoro.note.note7, 1);
  assert.equal(a.lavoro.avvisi_7_giorni.quanti, 1);
  assert.ok(Array.isArray(m.collegamenti));
  assert.equal(typeof m.spesa.mese_usd, "number");
  assert.ok("stop_attivo" in m.trading);
});

test("mappa: nessuna chiave, password o codice d'accesso nel file", () => {
  updateSettings({ apiKey: SECRETS[0], anthropicKey: SECRETS[0], geminiKey: SECRETS[1], resendKey: SECRETS[2], elevenKey: SECRETS[4], googleTtsKey: SECRETS[1] });
  social.setApp("youtube", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: SECRETS[3] });
  const text = JSON.stringify(projectMap());
  for (const s of SECRETS) assert.ok(!text.includes(s), `nella mappa c'è un segreto: ${s}`);
  assert.doesNotMatch(text, /clientSecret|refreshToken|"token"/);
});
