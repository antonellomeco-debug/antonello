// Stato condiviso del palazzo (piani, stanze, collegamenti, agenti) e tutte le modifiche.
// Lo usano sia il server (interfaccia) sia Orion (chat), così le regole sono le stesse.
import * as B from "./building.js";
import { loadAgents, normalize, validate, saveAgent, deleteAgent } from "./config.js";
import { bus, log } from "./store.js";
import * as ctrader from "./ctrader/service.js";
import { getSafety } from "./safety.js";

B.ensureUserData();
let building = B.loadBuilding();
let agents = loadAgents();

function reload() {
  building = B.loadBuilding();
  agents = loadAgents();
  bus.emit("event", { type: "config" });
}

/** Applica una modifica al palazzo leggendo il file aggiornato, poi salva e ricarica. */
function mutate(fn) {
  const b = B.loadBuilding();
  const result = fn(b);
  B.saveBuilding(b);
  reload();
  return result;
}

export const office = {
  building: () => building,
  agents: () => agents,
  rooms: () => building.rooms,
  reload,

  saveFloor: (input) => mutate((b) => B.upsertFloor(b, input)),
  deleteFloor: (id) => mutate((b) => B.deleteFloor(b, id)),
  saveRoom: (input) => mutate((b) => B.upsertRoom(b, input)),
  deleteRoom: (id) => mutate((b) => B.deleteRoom(b, id, agents)),
  setLink: (input) => mutate((b) => B.setLink(b, input)),
  deleteLink: (from, to) => mutate((b) => B.deleteLink(b, from, to)),
  /**
   * Collega un piano al portafoglio simulato o a un conto cTrader.
   * I conti REALI si possono assegnare solo dall'interfaccia e solo dopo lo sblocco in Sicurezza.
   */
  setFloorTrading(floorId, trading, { source = "ui" } = {}) {
    if (trading?.mode === "ctrader") {
      const acc = ctrader.account(trading.accountId);
      if (!acc) throw new Error("Conto cTrader non trovato: collegalo prima nella sezione Broker.");
      if (acc.isLive && source !== "ui") throw new Error("Solo tu, dalla sezione Broker, puoi collegare un piano a un conto REALE.");
      if (acc.isLive && !getSafety().liveEnabled) throw new Error("Il conto REALE è bloccato: sbloccalo prima in Broker → Sicurezza.");
    }
    const floor = mutate((b) => B.setFloorTrading(b, floorId, trading));
    log("sicurezza", "info", `Piano "${floor.name}": ordini su ${floor.trading.mode === "paper" ? "portafoglio simulato" : `conto cTrader ${floor.trading.accountId}`} (${source === "ui" ? "dall'interfaccia" : `da ${source}`})`);
    return floor;
  },

  renameBuilding: (name) =>
    mutate((b) => {
      const n = String(name ?? "").trim();
      if (!n) throw new Error("dai un nome al palazzo");
      b.name = n;
      return { name: n };
    }),

  saveAgent(raw) {
    const agent = normalize(raw);
    if (!agent.id && agent.name) {
      const taken = new Set(agents.map((a) => a.id));
      agent.id = B.slugify(agent.name).replace(/-/g, "_");
      for (let i = 2; taken.has(agent.id); i++) agent.id = `${B.slugify(agent.name).replace(/-/g, "_")}_${i}`;
    }
    const errors = validate(agent, building.rooms);
    if (errors.length) throw Object.assign(new Error(errors.join("; ")), { errors });
    saveAgent(agent);
    reload();
    return agent;
  },

  deleteAgent(id) {
    deleteAgent(id);
    reload();
  },
};
