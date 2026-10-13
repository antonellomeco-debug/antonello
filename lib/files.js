// Scrittura e lettura sicura dei file di dati: un file non resta mai scritto a metà (spegnimento, disco pieno)
// e un file rovinato viene messo da parte invece di essere sovrascritto in silenzio.
import fs from "node:fs";
import path from "node:path";

/** Scrive in un file temporaneo e poi lo sostituisce in un colpo solo (rename). */
export function writeFileAtomic(file, data, { mode } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
  if (mode) fs.chmodSync(file, mode);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Legge un file JSON. Restituisce { data } se è a posto, {} se non esiste, oppure { corrupt: nome } se era
 * rovinato: in quel caso il file viene rinominato in "<nome>.corrupt-<data>" per poterlo recuperare.
 */
export function readJsonSafe(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {}; // non esiste ancora
  }
  try {
    return { data: JSON.parse(text) };
  } catch {
    const corrupt = `${file}.corrupt-${stamp()}`;
    try {
      fs.renameSync(file, corrupt);
    } catch {
      /* se non si può rinominare, almeno non lo sovrascriviamo subito */
    }
    return { corrupt };
  }
}
