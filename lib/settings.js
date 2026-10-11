// Impostazioni salvate dall'interfaccia (es. la chiave di Claude) in data/settings.json.
// Il file resta solo sul tuo computer ed è escluso da git.
import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve("data", "settings.json");
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch {
  /* nessuna impostazione salvata */
}

export function getSettings() {
  return settings;
}

export function updateSettings(patch) {
  settings = { ...settings, ...patch };
  for (const [k, v] of Object.entries(settings)) if (v == null || v === "") delete settings[k];
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return settings;
}
