// Avvia il server e lo riavvia da solo dopo un aggiornamento fatto dall'app (codice d'uscita 75).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const RESTART_CODE = 75;
let child;
let first = true;
let stopping = false; // arrivato un segnale di chiusura: niente più riavvii

function run() {
  child = spawn(process.execPath, [path.join(dir, "server.js")], {
    cwd: dir,
    stdio: "inherit",
    // Dopo un riavvio la pagina è già aperta: non riaprire il browser.
    env: { ...process.env, SUPERVISED: "1", ...(first ? {} : { OPEN_BROWSER: "0" }) },
  });
  first = false;
  child.on("exit", (code, signal) => {
    if (code === RESTART_CODE && !stopping) {
      console.log("\n  🔄 Riavvio con la nuova versione…\n");
      return run();
    }
    process.exit(stopping && code === RESTART_CODE ? 0 : code ?? (signal ? 1 : 0));
  });
}

// control + C arriva anche al server, che si chiude: qui lo inoltriamo solo per sicurezza.
// Sul server (Docker) start.js è il primo processo: riceve SIGTERM a ogni nuova versione e lo passa al server,
// che chiude in ordine (aspetta gli ordini già partiti e salva).
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    stopping = true;
    child?.kill(sig);
  });
}

run();
