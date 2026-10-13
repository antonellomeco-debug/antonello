// Copia dei tuoi dati in un file .zip (⚙️ Impostazioni): per tenerne una copia o per spostarli dal Mac al server.
// Contiene palazzo, agenti, portafoglio e registro, impostazioni (anche la chiave di Claude), sicurezza e cTrader:
// va tenuta al sicuro come una password. Non contiene le sessioni dell'accesso (auth.json) né le copie in backup/.
//
// Importazione: si controlla tutto il file, si salva una copia dei dati attuali in backup/prima-di-import-….zip,
// poi i nuovi file si preparano in una cartella d'attesa e vengono messi al loro posto alla riapertura del
// programma, prima di caricare i dati (lib/boot.js): così niente di ciò che il programma ha in memoria li
// sovrascrive.
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { DATA_DIR } from "./paths.js";
import { writeFileAtomic } from "./files.js";

const TOP_FILES = ["building.json", "state.json", "settings.json", "safety.json", "ctrader.json"];
const SECRET_FILES = new Set(["settings.json", "ctrader.json"]); // chiave di Claude, credenziali cTrader
const AGENT_FILE = /^agents\/[a-z0-9_-]+\.json$/;
const MAX_ENTRY = 10 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const KEEP_COPIES = 10;
export const STAGING_DIR = path.join(DATA_DIR, "import-in-attesa");
const READY = "PRONTO";

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const allowed = (rel) => TOP_FILES.includes(rel) || AGENT_FILE.test(rel);

/** File dei dati da copiare (percorsi relativi a DATA_DIR). */
function dataFiles(dir = DATA_DIR) {
  const out = TOP_FILES.filter((f) => fs.existsSync(path.join(dir, f)));
  try {
    for (const f of fs.readdirSync(path.join(dir, "agents")).sort()) if (allowed(`agents/${f}`)) out.push(`agents/${f}`);
  } catch {
    /* nessun agente */
  }
  return out;
}

/** Nome del file scaricato: agenti-dati-AAAA-MM-GG.zip */
export const backupFileName = (d = new Date()) => `agenti-dati-${d.toISOString().slice(0, 10)}.zip`;

export function exportZip() {
  const zip = new AdmZip();
  for (const rel of dataFiles()) zip.addFile(rel, fs.readFileSync(path.join(DATA_DIR, rel)));
  return zip.toBuffer();
}

/**
 * Legge e controlla una copia: solo i file previsti (gli altri si ignorano), dimensioni ragionevoli,
 * ogni JSON deve essere leggibile. Errori in italiano, niente viene scritto.
 */
export function readBackup(buf) {
  let entries;
  try {
    entries = new AdmZip(buf).getEntries();
  } catch {
    throw new Error("Il file non è uno .zip valido: scegli il file agenti-dati-….zip scaricato dall'app.");
  }
  if (entries.length > MAX_ENTRIES) throw new Error("Lo .zip contiene troppi file: non sembra una copia dei dati dell'app.");
  const files = new Map();
  const skipped = [];
  let total = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    // Accetta anche una cartella "data/" compressa a mano dal Mac.
    const rel = e.entryName.replace(/\\/g, "/").replace(/^data\//, "");
    if (!allowed(rel)) {
      skipped.push(e.entryName);
      continue;
    }
    if (files.has(rel)) throw new Error(`Lo .zip contiene due volte ${rel}: importazione annullata.`);
    if (e.header.size > MAX_ENTRY) throw new Error(`${rel} è troppo grande: importazione annullata.`);
    let content;
    try {
      content = e.getData();
    } catch {
      throw new Error(`Non riesco a leggere ${rel} dallo .zip (file protetto o rovinato).`);
    }
    if (content.length > MAX_ENTRY) throw new Error(`${rel} è troppo grande: importazione annullata.`);
    total += content.length;
    if (total > MAX_TOTAL) throw new Error("Lo .zip è troppo grande: importazione annullata.");
    let parsed;
    try {
      parsed = JSON.parse(content.toString("utf8"));
    } catch {
      throw new Error(`${rel} è rovinato (non è un file JSON valido): importazione annullata.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${rel} non ha il contenuto atteso: importazione annullata.`);
    if (rel === "building.json" && [parsed.floors, parsed.rooms, parsed.links].some((x) => x !== undefined && !Array.isArray(x))) {
      throw new Error("building.json (il palazzo) non ha il contenuto atteso: importazione annullata.");
    }
    files.set(rel, content);
  }
  if (!files.has("building.json") && ![...files.keys()].some((k) => k.startsWith("agents/"))) {
    throw new Error("Questo file non sembra una copia dei dati dell'app (mancano il palazzo e gli agenti).");
  }
  return { files, skipped };
}

/** Copia dei dati attuali in backup/prima-di-import-<data>.zip (tiene le ultime 10). */
export function saveCurrentCopy() {
  const dir = path.join(DATA_DIR, "backup");
  const dest = path.join(dir, `prima-di-import-${stamp()}.zip`);
  writeFileAtomic(dest, exportZip(), { mode: 0o600 });
  const old = fs.readdirSync(dir).filter((f) => /^prima-di-import-.*\.zip$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_COPIES))) fs.rmSync(path.join(dir, f), { force: true });
  return dest;
}

/** Prepara i file importati nella cartella d'attesa: si applicano alla prossima apertura del programma. */
export function stageImport(files) {
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  for (const [rel, content] of files) writeFileAtomic(path.join(STAGING_DIR, rel), content, SECRET_FILES.has(rel) ? { mode: 0o600 } : {});
  fs.writeFileSync(path.join(STAGING_DIR, READY), new Date().toISOString());
}

/** Controlla, salva la copia dei dati attuali e prepara l'importazione. */
export function importZip(buf) {
  const { files, skipped } = readBackup(buf);
  const copy = saveCurrentCopy();
  stageImport(files);
  return { files: files.size, skipped: skipped.length, copy: path.relative(DATA_DIR, copy) };
}

/**
 * All'avvio, prima di caricare i dati: mette al loro posto i file di un'importazione completa.
 * Se la copia contiene agenti, gli agenti che non ci sono vengono tolti (la copia li sostituisce tutti).
 * Restituisce il numero di file applicati (0 se non c'era niente).
 */
export function applyStagedImport() {
  if (!fs.existsSync(STAGING_DIR)) return 0;
  if (!fs.existsSync(path.join(STAGING_DIR, READY))) {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true }); // preparazione interrotta: si ignora
    return 0;
  }
  const rels = dataFiles(STAGING_DIR);
  if (rels.some((r) => r.startsWith("agents/"))) {
    const keep = new Set(rels);
    for (const rel of dataFiles().filter((r) => r.startsWith("agents/"))) if (!keep.has(rel)) fs.rmSync(path.join(DATA_DIR, rel), { force: true });
  }
  for (const rel of rels) {
    fs.mkdirSync(path.dirname(path.join(DATA_DIR, rel)), { recursive: true });
    fs.renameSync(path.join(STAGING_DIR, rel), path.join(DATA_DIR, rel));
  }
  fs.rmSync(STAGING_DIR, { recursive: true, force: true });
  return rels.length;
}
