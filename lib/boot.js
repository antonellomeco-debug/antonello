// Operazioni da fare prima di caricare i dati: server.js importa questo modulo per primo.
// Mette al loro posto i file di una copia importata dall'app (⚙️ Impostazioni → Importa), così nessun dato
// rimasto in memoria nel programma di prima può sovrascriverli.
import { applyStagedImport } from "./backup.js";

export let importedAtBoot = 0;
try {
  importedAtBoot = applyStagedImport();
} catch (err) {
  console.log(`${new Date().toISOString()} [error] programma: importazione dei dati non riuscita (${err.message}). Restano i dati di prima.`);
}
