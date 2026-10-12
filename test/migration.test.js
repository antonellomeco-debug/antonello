import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Simula una cartella della versione vecchia (rooms.json, agents/, data/state.json).
const base = fs.mkdtempSync(path.join(os.tmpdir(), "migrazione-"));
const legacy = path.join(base, "programma");
const data = path.join(legacy, "data");
fs.mkdirSync(path.join(legacy, "agents"), { recursive: true });
fs.mkdirSync(data, { recursive: true });
process.env.AGENTI_DATA_DIR = data;
process.env.AGENTI_LEGACY_DIR = legacy;

const { DEFAULTS_DIR } = await import("../lib/paths.js");
const B = await import("../lib/building.js");
const defaults = JSON.parse(fs.readFileSync(path.join(DEFAULTS_DIR, "building.json"), "utf8"));
const write = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");

test("versione vecchia: stanze su un solo piano, agenti importati con le loro letture", () => {
  fs.writeFileSync(path.join(data, "state.json"), "{}"); // portafoglio della versione vecchia
  write(path.join(legacy, "agents", "analista_news.json"), { id: "analista_news", room: "ricerca", readsFrom: ["direzione"], mode: "rule", strategy: "rsi_reversion" });
  B.ensureUserData();
  const b = B.loadBuilding();
  assert.equal(b.floors.length, 1);
  assert.deepEqual(b.rooms.map((r) => r.id).sort(), defaults.rooms.map((r) => r.id).sort());
  const agent = JSON.parse(fs.readFileSync(path.join(data, "agents", "analista_news.json"), "utf8"));
  assert.deepEqual(B.readableRooms(agent, b).map((r) => r.id).sort(), ["direzione", "ricerca"]);
  assert.ok(!fs.existsSync(path.join(legacy, "agents")), "la vecchia cartella agents/ viene rinominata");
  assert.ok(fs.existsSync(path.join(legacy, "agents-importati")));
});

test("agents/ copiata dopo il primo avvio: importa i nuovi e le versioni modificate degli agenti di partenza", () => {
  fs.mkdirSync(path.join(legacy, "agents"));
  write(path.join(legacy, "agents", "banche.json"), { id: "banche", room: "ricerca", mode: "rule", strategy: "sma_cross" });
  const trader = JSON.parse(fs.readFileSync(path.join(DEFAULTS_DIR, "agents", "trader.json"), "utf8"));
  write(path.join(legacy, "agents", "trader.json"), { ...trader, name: "Trader modificato" });
  B.ensureUserData();
  assert.ok(fs.existsSync(path.join(data, "agents", "banche.json")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, "agents", "trader.json"), "utf8")).name, "Trader modificato");
  assert.ok(fs.existsSync(path.join(legacy, "agents-importati-2")));
});
