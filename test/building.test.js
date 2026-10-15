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
  palaces: [{ id: "investimenti", name: "Investimenti", description: "", color: "#6f7dff" }],
  floors: [
    { id: "terra", palace: "investimenti", name: "Terra", level: 0, color: "#4f8cff" },
    { id: "azioni", palace: "investimenti", name: "Azioni", level: 1, color: "#22b07d" },
    { id: "crypto", palace: "investimenti", name: "Crypto", level: 2, color: "#e5534b" },
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

// ---------- universo: più palazzi ----------

test("file di prima (un solo palazzo): diventa un universo con un palazzo che contiene tutti i piani", () => {
  const file = path.join(tmp, "building.json");
  const keep = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, JSON.stringify({ name: "Il mio palazzo", floors: [{ id: "a", name: "A", level: 0, color: "#4f8cff" }], rooms: [], links: [] }));
  let b = B.loadBuilding();
  assert.equal(b.name, "Il mio universo");
  assert.deepEqual(b.palaces.map((p) => [p.id, p.name]), [["palazzo-investimenti", "Palazzo Investimenti"]]);
  assert.equal(b.floors[0].palace, "palazzo-investimenti");
  // Un nome scelto dall'utente resta il nome del palazzo.
  fs.writeFileSync(file, JSON.stringify({ name: "Torre Gold", floors: [{ id: "a", name: "A", level: 0, color: "#4f8cff" }] }));
  b = B.loadBuilding();
  assert.deepEqual([b.name, b.palaces[0].name, b.floors[0].palace], ["Il mio universo", "Torre Gold", "torre-gold"]);
  // Nome molto lungo: si accorcia, così il palazzo resta modificabile.
  fs.writeFileSync(file, JSON.stringify({ name: "X".repeat(90), floors: [] }));
  assert.equal(B.loadBuilding().palaces[0].name.length, 60);
  // File riscritto da una versione vecchia dopo l'universo (rollback): i piani hanno il palazzo ma l'elenco manca.
  // I palazzi tornano dai piani, senza unirli, e il nome dell'universo resta.
  fs.writeFileSync(file, JSON.stringify({
    name: "Il mio universo",
    floors: [{ id: "a", name: "A", level: 0, palace: "palazzo-investimenti" }, { id: "s", name: "S", level: 0, palace: "palazzo-social" }],
  }));
  const back = B.loadBuilding();
  assert.equal(back.name, "Il mio universo");
  assert.deepEqual(back.palaces.map((p) => [p.id, p.name]), [["palazzo-investimenti", "Palazzo Investimenti"], ["palazzo-social", "Palazzo Social"]]);
  assert.deepEqual(back.floors.map((f) => f.palace), ["palazzo-investimenti", "palazzo-social"]);
  // Universo vuoto riscritto senza piani né palazzi: il nome dell'universo non diventa il nome di un palazzo.
  fs.writeFileSync(file, JSON.stringify({ name: "Il mio universo", floors: [] }));
  assert.deepEqual(B.loadBuilding().palaces.map((p) => p.name), ["Palazzo Investimenti"]);
  fs.writeFileSync(file, JSON.stringify({ name: "Torre Gold", floors: [{ id: "a", name: "A", level: 0, color: "#4f8cff" }] }));
  b = B.loadBuilding();
  // Salvato e riletto: resta uguale.
  B.saveBuilding(b);
  const again = B.loadBuilding();
  assert.deepEqual(again.palaces, b.palaces);
  assert.equal(again.name, "Il mio universo");
  fs.writeFileSync(file, keep);
});

test("palazzi: creazione, nomi doppi, piani nel palazzo giusto con i loro livelli, eliminazione", () => {
  const b = building();
  const social = B.upsertPalace(b, { name: "Palazzo Social", description: "Monitora i miei social" });
  assert.equal(social.id, "palazzo-social");
  assert.match(social.color, /^#[0-9a-f]{6}$/i);
  assert.throws(() => B.upsertPalace(b, { name: "palazzo social" }), /esiste già/);
  assert.throws(() => B.upsertPalace(b, { name: " " }), /nome/);
  const f = B.upsertFloor(b, { name: "Piano Instagram", palace: social.id });
  assert.equal(f.palace, social.id);
  assert.equal(f.level, 0, "primo piano del palazzo nuovo: livello 0, non dopo i piani degli altri palazzi");
  assert.equal(B.upsertFloor(b, { name: "Piano TikTok", palace: social.id }).level, 1);
  assert.throws(() => B.upsertFloor(b, { name: "Senza palazzo" }), /indica in quale palazzo/, "con più palazzi va indicato");
  assert.equal(B.upsertFloor(b, { name: "Piano Reels", palace: "palazzo social" }).palace, social.id, "va bene anche il nome");
  B.deleteFloor(b, "piano-reels");
  assert.throws(() => B.upsertFloor(b, { name: "X", palace: "inesistente" }), /palazzo "inesistente" non esiste/);
  assert.throws(() => B.deletePalace(b, social.id), /ancora 2 piani/);
  B.deleteFloor(b, f.id);
  B.deleteFloor(b, "piano-tiktok");
  B.deletePalace(b, social.id);
  assert.deepEqual(b.palaces.map((p) => p.id), ["investimenti"]);
  assert.throws(() => B.deletePalace(b, "investimenti"), /unico palazzo/);
  const other = B.upsertPalace(b, { name: "Palazzo Ricerche" });
  assert.throws(() => B.upsertPalace(b, { id: other.id, name: "investimenti" }), /esiste già/, "anche rinominando");
  B.deletePalace(b, other.id);
  const renamed = B.upsertPalace(b, { id: "investimenti", name: "Palazzo Borsa" });
  assert.deepEqual([renamed.id, renamed.name], ["investimenti", "Palazzo Borsa"], "rinominare non cambia il codice");
});

test("palazzi diversi comunicano con i collegamenti tra i loro piani", () => {
  const b = building();
  const social = B.upsertPalace(b, { name: "Social" });
  const f = B.upsertFloor(b, { name: "Monitor", palace: social.id });
  B.upsertRoom(b, { name: "Sala Trend", floor: f.id });
  B.setLink(b, { from: f.id, to: "terra", direction: "one-way", active: true });
  const cio = { room: "direzione", readsFrom: [] };
  assert.ok(B.readableRooms(cio, b).some((r) => r.id === "sala-trend"), "la Direzione legge il palazzo Social");
  const trend = { room: "sala-trend", readsFrom: [] };
  assert.ok(!B.readableRooms(trend, b).some((r) => r.id === "direzione"), "a senso unico: il Social non legge la Direzione");
});
