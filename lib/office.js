// Stato condiviso del palazzo (piani, stanze, collegamenti, agenti) e tutte le modifiche.
// Lo usano sia il server (interfaccia) sia Orion (chat), così le regole sono le stesse.
import * as B from "./building.js";
import { loadAgents, normalize, validate, saveAgent, deleteAgent } from "./config.js";
import { bus } from "./store.js";

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
