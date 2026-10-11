// Crea sulla Scrivania del Mac l'icona "Avvia Agenti.command": doppio clic e il programma parte.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform !== "darwin") {
  console.log("Questo comando serve solo sul Mac.");
  process.exit(0);
}

const project = process.cwd(); // npm esegue lo script dalla cartella del progetto
const quoted = `'${project.replace(/'/g, `'\\''`)}'`;
const file = path.join(os.homedir(), "Desktop", "Avvia Agenti.command");
const script = `#!/bin/bash
# Avvia l'Ufficio Agenti (creato da: npm run collegamento)
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd ${quoted} || { echo "Cartella del programma non trovata: l'hai spostata? Rifai: npm run collegamento"; read -n 1; exit 1; }
npm start
`;

fs.writeFileSync(file, script, { mode: 0o755 });
fs.chmodSync(file, 0o755);
console.log("");
console.log(`  ✅ Creato sulla Scrivania: "Avvia Agenti"`);
console.log("  D'ora in poi basta un doppio clic su quell'icona per avviare il programma.");
console.log("  (Se sposti la cartella del programma, ripeti: npm run collegamento)");
console.log("");
