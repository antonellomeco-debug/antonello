// Percorsi del progetto, indipendenti dalla cartella da cui si avvia il programma.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Tutto ciò che è tuo (palazzo, agenti, portafoglio, chiave): mai toccato dagli aggiornamenti.
// AGENTI_DATA_DIR: cartella scelta a mano (test, server); RAILWAY_VOLUME_MOUNT_PATH: il volume che Railway
// collega al servizio (la imposta Railway da sola); altrimenti la cartella data/ del programma (Mac).
const dataDir = process.env.AGENTI_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH;
export const DATA_DIR = dataDir ? path.resolve(dataDir) : path.join(ROOT, "data");
export const DEFAULTS_DIR = path.join(ROOT, "defaults");
// Dove cercare i file della versione senza piani (rooms.json, agents/): la cartella del programma.
export const LEGACY_DIR = process.env.AGENTI_LEGACY_DIR ? path.resolve(process.env.AGENTI_LEGACY_DIR) : ROOT; // configurazione iniziale fornita con il programma
export const AGENTS_DIR = path.join(DATA_DIR, "agents");
export const BUILDING_FILE = path.join(DATA_DIR, "building.json");
export const STRATEGIES_DIR = path.join(ROOT, "strategies");
export const PUBLIC_DIR = path.join(ROOT, "public");
