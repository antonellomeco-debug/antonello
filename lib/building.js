// L'universo: più palazzi (ognuno un settore: investimenti, social, ricerche…), ogni palazzo ha i suoi piani, ogni
// piano le sue stanze. I collegamenti sono tra piani, anche di palazzi diversi: un collegamento attivo permette agli
// agenti di un piano di leggere le bacheche dell'altro. Tutto sta in data/building.json (nome storico del file).
import fs from "node:fs";
import path from "node:path";
import { LEGACY_DIR, DATA_DIR, DEFAULTS_DIR, AGENTS_DIR, BUILDING_FILE } from "./paths.js";

export const COLORS = ["#4f8cff", "#22b07d", "#e5534b", "#d29922", "#a371f7", "#2fb7c4", "#f06292", "#8bc34a", "#ff8a3d", "#7986cb"];
const ID = /^[a-z0-9_-]+$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** "Sala Crypto & DeFi" → "sala-crypto-defi" */
export function slugify(name) {
  return (
    String(name ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "elemento"
  );
}

/** "" o spazi (capita che il modello li mandi) valgono come "nessun id": si crea un elemento nuovo. */
const cleanId = (id) => (typeof id === "string" && id.trim() ? id.trim() : undefined);

function uniqueId(base, taken) {
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// ---------- caricamento e prima installazione ----------

/**
 * Prepara la cartella data/ al primo avvio (o dopo l'aggiornamento da una versione vecchia).
 * - Installazione nuova: palazzo e agenti di partenza da defaults/.
 * - Versione vecchia (senza piani): tutte le stanze su un solo piano, così gli agenti continuano
 *   a leggere le stesse stanze di prima; gli agenti della vecchia cartella agents/ vengono importati.
 */
export function ensureUserData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const legacyRooms = path.join(LEGACY_DIR, "rooms.json");
  const legacyAgents = path.join(LEGACY_DIR, "agents");
  const isLegacy = fs.existsSync(legacyRooms) || fs.existsSync(legacyAgents) || fs.existsSync(path.join(DATA_DIR, "state.json"));

  if (!fs.existsSync(BUILDING_FILE)) {
    const defaults = JSON.parse(fs.readFileSync(path.join(DEFAULTS_DIR, "building.json"), "utf8"));
    let building = defaults;
    if (isLegacy) {
      const rooms = fs.existsSync(legacyRooms) ? JSON.parse(fs.readFileSync(legacyRooms, "utf8")) : defaults.rooms;
      building = {
        name: "Il mio palazzo",
        floors: [{ id: "piano-borsa", name: "Piano Borsa", sector: "Azioni e indici", description: "", color: "#4f8cff", level: 0 }],
        rooms: rooms.map((r) => ({ id: r.id, floor: "piano-borsa", name: r.name, description: r.description ?? "", color: r.color })),
        links: [],
      };
    }
    writeJsonAtomic(BUILDING_FILE, building);
  }

  const defaultAgents = path.join(DEFAULTS_DIR, "agents");
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    for (const f of jsonFiles(defaultAgents)) fs.copyFileSync(path.join(defaultAgents, f), path.join(AGENTS_DIR, f));
  }
  // Agenti della versione vecchia (cartella agents/ nel programma): li importa anche se il programma
  // nuovo è già stato avviato una volta. Un agente di partenza non ancora modificato viene sostituito
  // dalla versione vecchia (che potrebbe contenere le tue modifiche); poi la cartella viene rinominata.
  if (fs.existsSync(legacyAgents)) {
    for (const f of jsonFiles(legacyAgents)) {
      const dest = path.join(AGENTS_DIR, f);
      const untouchedDefault = fs.existsSync(dest) && sameFile(dest, path.join(defaultAgents, f));
      if (!fs.existsSync(dest) || untouchedDefault) fs.copyFileSync(path.join(legacyAgents, f), dest);
    }
    let target = path.join(LEGACY_DIR, "agents-importati");
    for (let i = 2; fs.existsSync(target); i++) target = path.join(LEGACY_DIR, `agents-importati-${i}`);
    fs.renameSync(legacyAgents, target);
  }
}

const jsonFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : []);
function sameFile(a, b) {
  try {
    return fs.readFileSync(a, "utf8") === fs.readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

export const DEFAULT_UNIVERSE = "Il mio universo";
const OLD_DEFAULT_NAME = "Il mio palazzo";

/**
 * Legge l'universo. I file di prima (un solo palazzo, senza "palaces") diventano un universo con un palazzo che
 * contiene tutti i piani: il vecchio nome del palazzo resta il nome del palazzo (quello di partenza diventa
 * «Palazzo Investimenti»), l'universo si chiama «Il mio universo». Il file si aggiorna alla prima modifica.
 */
export function loadBuilding() {
  const b = JSON.parse(fs.readFileSync(BUILDING_FILE, "utf8"));
  b.floors = (Array.isArray(b.floors) ? b.floors : []).slice().sort((x, y) => (x.level ?? 0) - (y.level ?? 0));
  b.rooms = Array.isArray(b.rooms) ? b.rooms : [];
  b.links = Array.isArray(b.links) ? b.links : [];
  let palaces = Array.isArray(b.palaces) ? b.palaces.filter((p) => p && typeof p.id === "string" && p.id) : [];
  if (!palaces.length) {
    const old = String(b.name ?? "").trim();
    const name = old && old !== OLD_DEFAULT_NAME ? old : "Palazzo Investimenti";
    palaces = [{ id: slugify(name), name, description: "Analisi dei mercati e trading", color: "#6f7dff" }];
    b.name = DEFAULT_UNIVERSE;
  }
  b.palaces = palaces.map((p) => ({
    id: p.id,
    name: String(p.name ?? "").trim() || p.id,
    description: String(p.description ?? "").trim(),
    color: HEX.test(p.color ?? "") ? p.color : "#6f7dff",
  }));
  b.name = String(b.name ?? "").trim() || DEFAULT_UNIVERSE;
  const ids = new Set(b.palaces.map((p) => p.id));
  for (const f of b.floors) if (!ids.has(f.palace)) f.palace = b.palaces[0].id; // piani senza palazzo: nel primo
  return b;
}

export function saveBuilding(b) {
  writeJsonAtomic(BUILDING_FILE, { name: b.name, palaces: b.palaces, floors: b.floors, rooms: b.rooms, links: b.links });
}

export const palaceOfFloor = (b, floorId) => b.floors.find((f) => f.id === floorId)?.palace;
export const palaceById = (b, id) => b.palaces.find((p) => p.id === id);

// ---------- palazzi ----------

const PALACE_COLORS = ["#6f7dff", "#f06292", "#2fb7c4", "#ffb84d", "#8bc34a", "#a371f7", "#ff8a3d", "#4f8cff"];

export function upsertPalace(b, input) {
  const errors = [];
  input = { ...input, id: cleanId(input.id) };
  const existing = input.id ? b.palaces.find((p) => p.id === input.id) : null;
  if (input.id && !existing) errors.push(`il palazzo "${input.id}" non esiste`);
  const name = String(input.name ?? existing?.name ?? "").trim();
  if (!name) errors.push("dai un nome al palazzo");
  if (name.length > 60) errors.push("nome del palazzo troppo lungo (al massimo 60 caratteri)");
  const color = input.color ?? existing?.color ?? PALACE_COLORS[b.palaces.length % PALACE_COLORS.length];
  if (!HEX.test(color)) errors.push("colore non valido (es. #f06292)");
  if (!existing && b.palaces.some((p) => p.name.toLowerCase() === name.toLowerCase())) errors.push(`esiste già un palazzo che si chiama "${name}"`);
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { errors });
  const palace = {
    id: existing?.id ?? uniqueId(slugify(name), new Set([...b.palaces.map((p) => p.id), ...b.floors.map((f) => f.id)])),
    name,
    description: String(input.description ?? existing?.description ?? "").trim().slice(0, 500),
    color,
  };
  b.palaces = existing ? b.palaces.map((p) => (p.id === palace.id ? palace : p)) : [...b.palaces, palace];
  return palace;
}

export function deletePalace(b, id) {
  const palace = b.palaces.find((p) => p.id === id);
  if (!palace) throw new Error(`il palazzo "${id}" non esiste`);
  if (b.palaces.length === 1) throw new Error("è l'unico palazzo dell'universo: non si può eliminare");
  const floors = b.floors.filter((f) => f.palace === id);
  if (floors.length) {
    throw new Error(`il palazzo ha ancora ${floors.length} piani (${floors.map((f) => f.name).join(", ")}): spostali o eliminali prima`);
  }
  b.palaces = b.palaces.filter((p) => p.id !== id);
}

// ---------- piani ----------

export function upsertFloor(b, input) {
  const errors = [];
  input = { ...input, id: cleanId(input.id) };
  const existing = input.id ? b.floors.find((f) => f.id === input.id) : null;
  if (input.id && !existing && !ID.test(input.id)) errors.push("id del piano non valido");
  const name = String(input.name ?? existing?.name ?? "").trim();
  if (!name) errors.push("dai un nome al piano");
  const color = input.color ?? existing?.color ?? COLORS[b.floors.length % COLORS.length];
  if (!HEX.test(color)) errors.push("colore non valido (es. #4f8cff)");
  const palace = cleanId(input.palace) ?? existing?.palace ?? b.palaces[0]?.id;
  if (!b.palaces.some((p) => p.id === palace)) errors.push(`il palazzo "${palace}" non esiste: crealo prima`);
  const samePalace = b.floors.filter((f) => f.palace === palace && f.id !== existing?.id);
  const level = input.level ?? (existing && existing.palace === palace ? existing.level : null) ?? Math.max(-1, ...samePalace.map((f) => f.level ?? 0)) + 1;
  if (!Number.isInteger(Number(level))) errors.push("il livello deve essere un numero intero");
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { errors });

  const floor = {
    id: existing?.id ?? input.id ?? uniqueId(slugify(name), new Set(b.floors.map((f) => f.id))),
    palace,
    name,
    sector: String(input.sector ?? existing?.sector ?? "").trim(),
    description: String(input.description ?? existing?.description ?? "").trim(),
    color,
    level: Number(level),
    // Dove operano gli agenti del piano: si cambia solo con setFloorTrading (con i controlli di sicurezza).
    trading: existing?.trading ?? { mode: "paper" },
  };
  b.floors = existing ? b.floors.map((f) => (f.id === floor.id ? floor : f)) : [...b.floors, floor];
  b.floors.sort((x, y) => x.level - y.level);
  return floor;
}

export function deleteFloor(b, id) {
  if (!b.floors.some((f) => f.id === id)) throw new Error(`il piano "${id}" non esiste`);
  const rooms = b.rooms.filter((r) => r.floor === id);
  if (rooms.length) {
    throw new Error(`il piano ha ancora ${rooms.length} stanze (${rooms.map((r) => r.name).join(", ")}): spostale o eliminale prima`);
  }
  b.floors = b.floors.filter((f) => f.id !== id);
  b.links = b.links.filter((l) => l.from !== id && l.to !== id);
}

/** trading: { mode: "paper" } (portafoglio simulato dell'app) oppure { mode: "ctrader", accountId }. */
export function setFloorTrading(b, floorId, trading) {
  const floor = b.floors.find((f) => f.id === floorId);
  if (!floor) throw new Error(`il piano "${floorId}" non esiste`);
  if (trading?.mode === "paper") floor.trading = { mode: "paper" };
  else if (trading?.mode === "ctrader" && trading.accountId) floor.trading = { mode: "ctrader", accountId: Number(trading.accountId) };
  else throw new Error('modalità non valida: "paper" oppure "ctrader" con un conto');
  return floor;
}

export const floorTrading = (b, floorId) => b.floors.find((f) => f.id === floorId)?.trading ?? { mode: "paper" };

// ---------- stanze ----------

export function upsertRoom(b, input) {
  const errors = [];
  input = { ...input, id: cleanId(input.id) };
  const existing = input.id ? b.rooms.find((r) => r.id === input.id) : null;
  if (input.id && !existing && !ID.test(input.id)) errors.push("id della stanza non valido");
  const name = String(input.name ?? existing?.name ?? "").trim();
  if (!name) errors.push("dai un nome alla stanza");
  const floor = input.floor ?? existing?.floor ?? b.floors[0]?.id;
  if (!b.floors.some((f) => f.id === floor)) errors.push(`il piano "${floor}" non esiste: crealo prima`);
  const color = input.color ?? existing?.color ?? COLORS[b.rooms.length % COLORS.length];
  if (!HEX.test(color)) errors.push("colore non valido (es. #22b07d)");
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { errors });

  const room = {
    id: existing?.id ?? input.id ?? uniqueId(slugify(name), new Set(b.rooms.map((r) => r.id))),
    floor,
    name,
    description: String(input.description ?? existing?.description ?? "").trim(),
    color,
  };
  b.rooms = existing ? b.rooms.map((r) => (r.id === room.id ? room : r)) : [...b.rooms, room];
  return room;
}

export function deleteRoom(b, id, agents) {
  if (!b.rooms.some((r) => r.id === id)) throw new Error(`la stanza "${id}" non esiste`);
  const inside = agents.filter((a) => a.room === id);
  if (inside.length) {
    throw new Error(`nella stanza lavorano ancora: ${inside.map((a) => a.name).join(", ")}. Spostali in un'altra stanza o eliminali prima`);
  }
  b.rooms = b.rooms.filter((r) => r.id !== id);
}

// ---------- collegamenti tra piani ----------

const samePair = (l, a, c) => (l.from === a && l.to === c) || (l.from === c && l.to === a);

/**
 * direction "both": i due piani si leggono a vicenda.
 * direction "one-way": le informazioni vanno da `from` a `to` (gli agenti di `to` leggono `from`).
 */
export function setLink(b, { from, to, direction = "both", active = true }) {
  const errors = [];
  if (!b.floors.some((f) => f.id === from)) errors.push(`il piano "${from}" non esiste`);
  if (!b.floors.some((f) => f.id === to)) errors.push(`il piano "${to}" non esiste`);
  if (from === to) errors.push("un piano non può essere collegato a sé stesso");
  if (!["both", "one-way"].includes(direction)) errors.push('direction deve essere "both" o "one-way"');
  if (errors.length) throw Object.assign(new Error(errors.join("; ")), { errors });
  const link = { from, to, direction, active: Boolean(active) };
  b.links = [...b.links.filter((l) => !samePair(l, from, to)), link];
  return link;
}

export function deleteLink(b, from, to) {
  const before = b.links.length;
  b.links = b.links.filter((l) => !samePair(l, from, to));
  if (b.links.length === before) throw new Error("collegamento non trovato");
}

/** true se gli agenti del piano `toFloor` possono leggere le bacheche del piano `fromFloor`. */
export function flowsInto(b, fromFloor, toFloor) {
  if (fromFloor === toFloor) return true;
  return b.links.some(
    (l) =>
      l.active &&
      ((l.direction === "both" && samePair(l, fromFloor, toFloor)) ||
        (l.direction === "one-way" && l.from === fromFloor && l.to === toFloor)),
  );
}

export const floorOfRoom = (b, roomId) => b.rooms.find((r) => r.id === roomId)?.floor;

/**
 * Stanze che un agente può leggere:
 * - la propria stanza;
 * - le stanze del proprio piano elencate in readsFrom;
 * - tutte le stanze dei piani collegati che "portano informazioni" al suo piano.
 */
export function readableRooms(agent, b) {
  const myFloor = floorOfRoom(b, agent.room);
  const reads = new Set(agent.readsFrom ?? []);
  return b.rooms.filter((r) => {
    if (r.id === agent.room) return true;
    if (r.floor === myFloor) return reads.has(r.id);
    return myFloor != null && flowsInto(b, r.floor, myFloor);
  });
}

/** Riepilogo leggibile dei collegamenti di un piano (per l'interfaccia e i prompt). */
export function floorConnections(b, floorId) {
  return b.floors
    .filter((f) => f.id !== floorId)
    .map((f) => ({ floor: f.id, receives: flowsInto(b, f.id, floorId), sends: flowsInto(b, floorId, f.id) }))
    .filter((c) => c.receives || c.sends);
}
