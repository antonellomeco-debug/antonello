import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Cartella dati temporanea: i test non toccano mai data/ del programma.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "palazzo-test-"));
process.env.AGENTI_DATA_DIR = tmp;
const B = await import("../lib/building.js");

const building = () => ({
  name: "Test",
  floors: [
    { id: "terra", name: "Terra", level: 0, color: "#4f8cff" },
    { id: "azioni", name: "Azioni", level: 1, color: "#22b07d" },
    { id: "crypto", name: "Crypto", level: 2, color: "#e5534b" },
  ],
  rooms: [
    { id: "direzione", floor: "terra", name: "Direzione", color: "#a371f7" },
    { id: "ricerca", floor: "azioni", name: "Ricerca", color: "#4f8cff" },
    { id: "trading", floor: "azioni", name: "Trading", color: "#d29922" },
    { id: "btc", floor: "crypto", name: "BTC", color: "#e5534b" },
  ],
  links: [],
});

test("slugify crea codici leggibili", () => {
  assert.equal(B.slugify("2° Piano · Crypto & DeFi"), "2-piano-crypto-defi");
  assert.equal(B.slugify("Città è già"), "citta-e-gia");
});

test("senza collegamenti un agente legge solo il suo piano (e solo readsFrom)", () => {
  const b = building();
  const trader = { room: "trading", readsFrom: ["ricerca", "btc"] };
  assert.deepEqual(B.readableRooms(trader, b).map((r) => r.id).sort(), ["ricerca", "trading"]);
});

test("collegamento a senso unico: solo il piano di arrivo legge", () => {
  const b = building();
  B.setLink(b, { from: "azioni", to: "terra", direction: "one-way", active: true });
  const cio = { room: "direzione", readsFrom: [] };
  const trader = { room: "trading", readsFrom: [] };
  assert.deepEqual(B.readableRooms(cio, b).map((r) => r.id).sort(), ["direzione", "ricerca", "trading"]);
  assert.deepEqual(B.readableRooms(trader, b).map((r) => r.id), ["trading"]);
});

test("collegamento nei due sensi, spento e riacceso", () => {
  const b = building();
  B.setLink(b, { from: "crypto", to: "azioni", direction: "both", active: true });
  assert.ok(B.flowsInto(b, "crypto", "azioni") && B.flowsInto(b, "azioni", "crypto"));
  B.setLink(b, { from: "azioni", to: "crypto", direction: "both", active: false }); // stessa coppia: sostituisce
  assert.equal(b.links.length, 1);
  assert.ok(!B.flowsInto(b, "crypto", "azioni"));
  B.deleteLink(b, "crypto", "azioni");
  assert.equal(b.links.length, 0);
});

test("errori chiari su piani e stanze", () => {
  const b = building();
  assert.throws(() => B.setLink(b, { from: "terra", to: "terra" }), /sé stesso/);
  assert.throws(() => B.deleteFloor(b, "azioni"), /ancora 2 stanze/);
  assert.throws(() => B.deleteRoom(b, "btc", [{ name: "Analista", room: "btc" }]), /lavorano ancora/);
  assert.throws(() => B.upsertRoom(b, { name: "X", floor: "inesistente" }), /non esiste/);
});

test("nuovi piani e stanze ricevono codice, colore e livello", () => {
  const b = building();
  const f = B.upsertFloor(b, { name: "3° Piano · Materie prime", sector: "Commodities" });
  assert.equal(f.id, "3-piano-materie-prime");
  assert.equal(f.level, 3);
  const r1 = B.upsertRoom(b, { name: "Sala Oro", floor: f.id });
  const r2 = B.upsertRoom(b, { name: "Sala Oro", floor: f.id });
  assert.equal(r1.id, "sala-oro");
  assert.equal(r2.id, "sala-oro-2");
  B.deleteRoom(b, "sala-oro", []);
  B.deleteRoom(b, "sala-oro-2", []);
  B.deleteFloor(b, f.id);
  assert.ok(!b.floors.some((x) => x.id === f.id));
});

test("prima installazione: crea palazzo e agenti nella cartella dati", () => {
  B.ensureUserData();
  const b = B.loadBuilding();
  assert.ok(b.floors.length >= 1 && b.rooms.length >= 1);
  assert.ok(fs.readdirSync(path.join(tmp, "agents")).length > 0);
});
