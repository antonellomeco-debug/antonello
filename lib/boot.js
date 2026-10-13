// Operazioni da fare prima di caricare i dati: server.js importa questo modulo per primo.
// Mette al loro posto i file di una copia importata dall'app (⚙️ Impostazioni → Importa), così nessun dato
// rimasto in memoria nel programma di prima può sovrascriverli.
// Se il programma è già aperto (es. l'icona premuta due volte) non si tocca niente: questo secondo avvio si
// fermerà subito perché la porta è occupata.
// Tutto è sincrono: gli altri moduli caricano i dati appena importati, quindi qui non si può aspettare.
import { spawnSync } from "node:child_process";
import { applyStagedImport } from "./backup.js";
import { PORT } from "./env.js";

/** Qualcuno risponde già sulla porta del programma? (controllo in un piccolo processo a parte, al massimo 2 s) */
function portInUse(port) {
  const probe = `const s=require("node:net").connect({port:${Number(port)},host:"127.0.0.1"});s.setTimeout(500,()=>process.exit(1));s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));`;
  const r = spawnSync(process.execPath, ["-e", probe], { timeout: 2000, stdio: "ignore" });
  return r.status === 0;
}

export let importedAtBoot = 0;
if (!portInUse(PORT)) {
  try {
    importedAtBoot = applyStagedImport();
  } catch (err) {
    console.log(`${new Date().toISOString()} [error] programma: importazione dei dati non riuscita (${err.message}). Restano i dati di prima.`);
  }
}
