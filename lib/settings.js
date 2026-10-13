// Impostazioni salvate dall'interfaccia (es. la chiave di Claude) in data/settings.json.
// Il file resta solo sul tuo computer (o nel volume del server) ed è escluso da git.
import path from "node:path";

import { DATA_DIR } from "./paths.js";
import { writeFileAtomic, readJsonSafe } from "./files.js";

const FILE = path.join(DATA_DIR, "settings.json");
const loaded = readJsonSafe(FILE); // nessuna impostazione salvata: {}
let settings = loaded.data && typeof loaded.data === "object" ? loaded.data : {};
if (loaded.corrupt) console.log(`${new Date().toISOString()} [error] programma: il file settings.json era rovinato, messo da parte come ${path.basename(loaded.corrupt)}.`);

export function getSettings() {
  return settings;
}

export function updateSettings(patch) {
  settings = { ...settings, ...patch };
  for (const [k, v] of Object.entries(settings)) if (v == null || v === "") delete settings[k];
  writeFileAtomic(FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return settings;
}
