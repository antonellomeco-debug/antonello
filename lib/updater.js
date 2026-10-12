// Aggiornamento dall'app: scarica l'ultima versione da GitHub e sostituisce i file del programma.
// Non tocca mai la cartella data/ (palazzo, agenti, portafoglio, chiave) né node_modules/.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import AdmZip from "adm-zip";
import { ROOT, DATA_DIR } from "./paths.js";

const REPO = process.env.UPDATE_REPO ?? "antonellomeco-debug/antonello";
const API = `https://api.github.com/repos/${REPO}`;
const INSTALLED_FILE = path.join(DATA_DIR, "installed.json");
const SKIP = [/^data\//, /^node_modules\//, /^\.git\//];
export const RESTART_CODE = 75; // start.js riavvia il server quando esce con questo codice

let updating = false;

export const isGitCheckout = () => fs.existsSync(path.join(ROOT, ".git"));

function readInstalled() {
  try {
    return JSON.parse(fs.readFileSync(INSTALLED_FILE, "utf8"));
  } catch {
    return null; // scaricato a mano: versione sconosciuta
  }
}

async function github(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "ufficio-agenti-updater" } });
  } catch {
    throw new Error("Impossibile raggiungere GitHub: controlla la connessione a internet.");
  }
  if (res.status === 403 || res.status === 429) throw new Error("GitHub ha limitato le richieste: riprova tra un'ora.");
  if (!res.ok) throw new Error(`GitHub ha risposto con un errore (${res.status}).`);
  return res;
}

export async function checkUpdate() {
  // "HEAD" = ultima versione del ramo principale del progetto (una sola richiesta a GitHub).
  const c = await (await github(`${API}/commits/HEAD`)).json();
  const latest = {
    sha: c.sha,
    short: c.sha.slice(0, 7),
    date: c.commit?.committer?.date ?? null,
    message: String(c.commit?.message ?? "").split("\n")[0],
  };
  const installed = readInstalled();
  return {
    installed,
    latest,
    available: installed?.sha !== latest.sha,
    canUpdate: !isGitCheckout(),
    reason: isGitCheckout() ? "Questa cartella è gestita con git: per aggiornare usa git pull." : null,
  };
}

function safeRelative(rel) {
  const norm = path.posix.normalize(rel);
  if (!norm || norm.startsWith("..") || path.isAbsolute(norm) || norm.includes("\0")) return null;
  return norm;
}

function runNpmInstall() {
  return new Promise((resolve) => {
    const args = ["install", "--no-audit", "--no-fund", "--omit=dev"];
    const opts = { cwd: ROOT, shell: process.platform === "win32" };
    let out = "";
    const child = spawn("npm", args, opts);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ ok: false, out: err.message }));
    child.on("close", (code) => resolve({ ok: code === 0, out }));
  });
}

/**
 * Scarica e installa l'ultima versione. Restituisce { restarting } : se il programma è stato avviato
 * con "npm start" (o l'icona sulla Scrivania) si riavvia da solo; altrimenti va riaperto a mano.
 */
export async function applyUpdate({ busy } = {}) {
  if (isGitCheckout()) throw new Error("Questa cartella è gestita con git: per aggiornare usa git pull.");
  if (updating) throw new Error("Aggiornamento già in corso.");
  if (busy) throw new Error("Alcuni agenti stanno lavorando: aspetta che finiscano e riprova.");
  updating = true;
  try {
    const info = await checkUpdate();
    const zipRes = await github(`${API}/zipball/${info.latest.sha}`);
    const zip = new AdmZip(Buffer.from(await zipRes.arrayBuffer()));
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    const prefix = entries[0]?.entryName.split("/")[0] + "/";
    if (!entries.some((e) => e.entryName === `${prefix}package.json`) || !entries.some((e) => e.entryName === `${prefix}server.js`)) {
      throw new Error("Il pacchetto scaricato non sembra il programma: aggiornamento annullato.");
    }

    const oldPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const backupDir = path.join(DATA_DIR, "backup", new Date().toISOString().replace(/[:.]/g, "-"));
    const written = [];

    // 1) copia di sicurezza dei file che verranno sostituiti, 2) scrittura dei nuovi file
    for (const e of entries) {
      const rel = safeRelative(e.entryName.slice(prefix.length));
      if (!rel || SKIP.some((re) => re.test(rel))) continue;
      const dest = path.join(ROOT, rel);
      if (!dest.startsWith(ROOT + path.sep)) continue;
      if (fs.existsSync(dest)) {
        fs.mkdirSync(path.dirname(path.join(backupDir, rel)), { recursive: true });
        fs.copyFileSync(dest, path.join(backupDir, rel));
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.getData());
      written.push(rel);
    }

    // Nuove librerie da installare?
    const newPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    if (JSON.stringify(oldPkg.dependencies) !== JSON.stringify(newPkg.dependencies)) {
      const npm = await runNpmInstall();
      if (!npm.ok) {
        restoreBackup(backupDir, written);
        throw new Error(`Installazione dei componenti non riuscita, ho rimesso la versione precedente. Dettagli: ${npm.out.slice(-400)}`);
      }
    }

    fs.writeFileSync(
      INSTALLED_FILE,
      JSON.stringify({ ...info.latest, installedAt: new Date().toISOString() }, null, 2),
    );
    const supervised = process.env.SUPERVISED === "1";
    if (supervised) setTimeout(() => process.exit(RESTART_CODE), 600);
    return { ok: true, version: info.latest, files: written.length, restarting: supervised };
  } finally {
    updating = false;
  }
}

function restoreBackup(backupDir, written) {
  for (const rel of written) {
    const saved = path.join(backupDir, rel);
    const dest = path.join(ROOT, rel);
    if (fs.existsSync(saved)) fs.copyFileSync(saved, dest);
    else fs.rmSync(dest, { force: true }); // file nuovo: lo tolgo
  }
}
