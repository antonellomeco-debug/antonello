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

// I file dell'archivio per i social (media/: foto e video) non entrano nelle copie: possono essere molto grandi.
const TOP_FILES = ["building.json", "state.json", "settings.json", "safety.json", "ctrader.json", "social.json", "platform.json"];
const SECRET_FILES = new Set(["settings.json", "ctrader.json", "social.json"]); // chiavi, credenziali cTrader e dei social
const AGENT_FILE = /^agents\/[a-z0-9_-]+\.json$/;
const MAX_ENTRY = 10 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const KEEP_COPIES = 10;
export const STAGING_DIR = path.join(DATA_DIR, "import-in-attesa");
const READY = "PRONTO";

export const APPLIED_MARK = path.join(DATA_DIR, "import-applicato");

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

/** Forma minima di ogni file, perché il programma possa ripartire con i dati importati. */
function checkShape(rel, d) {
  const listOf = (v, test = isObj) => v === undefined || (Array.isArray(v) && v.every(test));
  const withId = (x) => isObj(x) && typeof x.id === "string";
  if (rel === "building.json") return ["palaces", "floors", "rooms"].every((k) => listOf(d[k], withId)) && listOf(d.links);
  if (rel === "state.json") {
    const p = d.portfolio;
    return (
      ["log", "approvals", "brokerTrades"].every((k) => listOf(d[k])) &&
      ["notes", "usage", "lastRun"].every((k) => d[k] === undefined || isObj(d[k])) &&
      (p === undefined || (isObj(p) && (p.positions === undefined || (isObj(p.positions) && Object.values(p.positions).every(isObj))) && listOf(p.trades))) &&
      (d.notes === undefined || Object.values(d.notes).every((v) => listOf(v)))
    );
  }
  if (rel.startsWith("agents/")) return d.id === undefined || d.id === path.basename(rel, ".json");
  if (rel === "safety.json") return ["limits", "killSwitch", "daily"].every((k) => d[k] === undefined || isObj(d[k]));
  if (rel === "settings.json") {
    const s = d.schedule;
    const hhmm = (v) => v === undefined || (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v));
    return (
      (d.anthropicApiKey === undefined || typeof d.anthropicApiKey === "string") &&
      (d.geminiKey === undefined || typeof d.geminiKey === "string") &&
      (d.pexelsKey === undefined || typeof d.pexelsKey === "string") &&
      (d.pixabayKey === undefined || typeof d.pixabayKey === "string") &&
      (d.googleTtsKey === undefined || typeof d.googleTtsKey === "string") &&
      (d.elevenKey === undefined || typeof d.elevenKey === "string") &&
      (s === undefined ||
        (isObj(s) &&
          (s.days === undefined || (Array.isArray(s.days) && s.days.every((x) => Number.isInteger(x) && x >= 0 && x <= 6))) &&
          hhmm(s.start) && hhmm(s.end) &&
          (s.fridayClose === undefined || (isObj(s.fridayClose) && hhmm(s.fridayClose.time)))))
    );
  }
  if (rel === "platform.json") return (d.look === undefined || isObj(d.look)) && listOf(d.shortcuts, withId) && listOf(d.ideas, withId);
  if (rel === "social.json") return ["apps", "accounts", "settings"].every((k) => d[k] === undefined || isObj(d[k])) && listOf(d.posts, withId);
  if (rel === "ctrader.json") {
    return listOf(d.accounts) && (d.token == null || isObj(d.token)) && ["clientId", "clientSecret"].every((k) => d[k] === undefined || typeof d[k] === "string");
  }
  return true;
}

/** Profondità massima di un JSON (senza ricorsione): file troppo annidati non si importano. */
function tooDeep(value, limit = 64) {
  const stack = [[value, 1]];
  while (stack.length) {
    const [v, depth] = stack.pop();
    if (v === null || typeof v !== "object") continue;
    if (depth > limit) return true;
    for (const x of Object.values(v)) if (x !== null && typeof x === "object") stack.push([x, depth + 1]);
  }
  return false;
}
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
    if (!isObj(parsed) || tooDeep(parsed) || !checkShape(rel, parsed)) throw new Error(`${rel} non ha il contenuto atteso: importazione annullata.`);
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
 * Sicurezza: dalla copia si prendono solo i limiti. STOP, blocco per la perdita del giorno e sblocco del conto
 * reale restano quelli di adesso (lo STOP resta acceso se lo è in uno dei due): una copia vecchia non deve
 * spegnere uno STOP né sbloccare il conto reale senza «SOLDI VERI».
 */
function mergeStagedSafety() {
  const staged = path.join(STAGING_DIR, "safety.json");
  if (!fs.existsSync(staged)) return;
  const read = (f) => {
    try {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      return isObj(d) ? d : {};
    } catch {
      return {};
    }
  };
  const cur = read(path.join(DATA_DIR, "safety.json"));
  const imp = read(staged);
  const merged = { ...cur, limits: isObj(imp.limits) ? imp.limits : cur.limits, liveEnabled: Boolean(cur.liveEnabled) };
  if (!cur.killSwitch?.active && imp.killSwitch?.active) merged.killSwitch = imp.killSwitch;
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  writeFileAtomic(staged, JSON.stringify(merged, null, 2));
}

/**
 * All'avvio successivo a un'importazione: se il programma si è fermato subito dopo (dati che non riesce a usare),
 * rimette la copia dei dati di prima. Il segno viene tolto da server.js dopo due minuti e mezzo di funzionamento o a una chiusura ordinata.
 */
function rollbackFailedImport() {
  let mark;
  try {
    mark = JSON.parse(fs.readFileSync(APPLIED_MARK, "utf8"));
  } catch {
    return null;
  }
  const copy = String(mark.copy ?? "");
  fs.rmSync(APPLIED_MARK, { force: true });
  const file = path.join(DATA_DIR, "backup", path.basename(copy));
  if (!/^prima-di-import-.*\.zip$/.test(path.basename(copy)) || !fs.existsSync(file)) return null;
  const { files } = readBackup(fs.readFileSync(file));
  // Tornano esattamente i file di prima: quelli che la copia non ha (es. un ctrader.json arrivato con l'importazione) si tolgono.
  for (const rel of dataFiles()) if (!files.has(rel)) fs.rmSync(path.join(DATA_DIR, rel), { force: true });
  for (const [rel, content] of files) writeFileAtomic(path.join(DATA_DIR, rel), content, SECRET_FILES.has(rel) ? { mode: 0o600 } : {});
  return path.basename(file);
}

/** Il programma è ripartito bene con i dati importati: non serve più poter tornare indietro. */
export const confirmImportWorked = () => fs.rmSync(APPLIED_MARK, { force: true });

/**
 * All'avvio, prima di caricare i dati: mette al loro posto i file di un'importazione completa.
 * Se la copia contiene agenti, gli agenti che non ci sono vengono tolti (la copia li sostituisce tutti).
 * Restituisce il numero di file applicati (0 se non c'era niente).
 */
export function applyStagedImport() {
  const restored = rollbackFailedImport();
  if (restored) {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    console.log(`${new Date().toISOString()} [error] programma: dopo l'importazione il programma si era fermato: rimessi i dati di prima (${restored}).`);
    return 0;
  }
  if (!fs.existsSync(STAGING_DIR)) return 0;
  if (!fs.existsSync(path.join(STAGING_DIR, READY))) {
    fs.rmSync(STAGING_DIR, { recursive: true, force: true }); // preparazione interrotta: si ignora
    return 0;
  }
  mergeStagedSafety();
  // Copia dei dati di adesso (anche le modifiche fatte dopo aver scelto il file), per poter tornare indietro.
  const copy = saveCurrentCopy();
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
  fs.writeFileSync(APPLIED_MARK, JSON.stringify({ copy: path.basename(copy) }));
  return rels.length;
}
