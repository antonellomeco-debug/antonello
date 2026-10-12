// Percorsi del progetto, indipendenti dalla cartella da cui si avvia il programma.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Tutto ciò che è tuo (palazzo, agenti, portafoglio, chiave): mai toccato dagli aggiornamenti.
// AGENTI_DATA_DIR serve solo ai test per usare una cartella temporanea.
export const DATA_DIR = process.env.AGENTI_DATA_DIR ? path.resolve(process.env.AGENTI_DATA_DIR) : path.join(ROOT, "data");
export const DEFAULTS_DIR = path.join(ROOT, "defaults"); // configurazione iniziale fornita con il programma
export const AGENTS_DIR = path.join(DATA_DIR, "agents");
export const BUILDING_FILE = path.join(DATA_DIR, "building.json");
export const STRATEGIES_DIR = path.join(ROOT, "strategies");
export const PUBLIC_DIR = path.join(ROOT, "public");
