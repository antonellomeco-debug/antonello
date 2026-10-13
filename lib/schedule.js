// Orario di lavoro degli agenti programmati, in ora italiana (anche con l'ora legale).
// Fuori orario lo scheduler non avvia nessun agente: Orion e i pulsanti ▶ funzionano sempre.
// L'orario si salva in data/settings.json e si cambia da ⚙️ Impostazioni.
import { getSettings, updateSettings } from "./settings.js";

export const TIME_ZONE = "Europe/Rome";
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_NAMES = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];

const DEFAULTS = {
  enabled: true,
  days: [1, 2, 3, 4, 5], // 0 = domenica … 6 = sabato
  start: "07:30",
  end: "22:30",
  fridayClose: { enabled: true, time: "21:45" }, // chiusura delle posizioni degli agenti prima del weekend
};

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const pad = (n) => String(n).padStart(2, "0");

const romeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Giorno e ora in Italia per un istante: { weekday, date "AAAA-MM-GG", time "HH:MM", minutes, dayName, label }. */
export function romeParts(at = new Date()) {
  const p = Object.fromEntries(romeFormat.formatToParts(at).map((x) => [x.type, x.value]));
  const weekday = WEEKDAYS[p.weekday];
  const time = `${p.hour}:${p.minute}`;
  return {
    weekday,
    date: `${p.year}-${p.month}-${p.day}`,
    time,
    minutes: toMinutes(time),
    dayName: DAY_NAMES[weekday],
    label: `${DAY_NAMES[weekday]} ${p.day}/${p.month}/${p.year}, ore ${time}`,
  };
}

/** Riga con giorno e ora per i messaggi a Claude (agenti e Orion). */
export function clockLine(at = new Date()) {
  const r = romeParts(at);
  const utc = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
  return `Adesso è ${r.label} (ora italiana; ${utc} UTC).`;
}

export function getSchedule() {
  const raw = getSettings().schedule;
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const fc = s.fridayClose && typeof s.fridayClose === "object" ? s.fridayClose : {};
  // Ogni valore con la forma sbagliata (es. da una copia importata rovinata) torna a quello di partenza.
  const days = Array.isArray(s.days) && s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ? s.days : DEFAULTS.days;
  const time = (v, def) => (typeof v === "string" && HHMM.test(v) ? v : def);
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULTS.enabled,
    days,
    start: time(s.start, DEFAULTS.start),
    end: time(s.end, DEFAULTS.end),
    fridayClose: {
      enabled: typeof fc.enabled === "boolean" ? fc.enabled : DEFAULTS.fridayClose.enabled,
      time: time(fc.time, DEFAULTS.fridayClose.time),
    },
  };
}

/** Controlla e salva un nuovo orario; restituisce l'orario completo o un errore leggibile. */
export function updateSchedule(input = {}) {
  const cur = getSchedule();
  const next = {
    enabled: input.enabled ?? cur.enabled,
    days: input.days ?? cur.days,
    start: input.start ?? cur.start,
    end: input.end ?? cur.end,
    fridayClose: { ...cur.fridayClose, ...(input.fridayClose ?? {}) },
  };
  const errors = [];
  next.enabled = Boolean(next.enabled);
  next.fridayClose.enabled = Boolean(next.fridayClose.enabled);
  if (!Array.isArray(next.days) || next.days.some((d) => !Number.isInteger(Number(d)) || d < 0 || d > 6)) errors.push("giorni non validi");
  else next.days = [...new Set(next.days.map(Number))].sort((a, b) => a - b);
  if (next.enabled && Array.isArray(next.days) && next.days.length === 0) errors.push("scegli almeno un giorno di lavoro");
  if (!HHMM.test(next.start) || !HHMM.test(next.end)) errors.push("orari non validi (es. 07:30)");
  else if (toMinutes(next.end) <= toMinutes(next.start)) errors.push("l'orario di fine deve venire dopo quello di inizio");
  if (!HHMM.test(next.fridayClose.time)) errors.push("orario della chiusura del venerdì non valido (es. 21:45)");
  if (errors.length) throw Object.assign(new Error(`Orario non salvato: ${errors.join("; ")}.`), { errors });
  updateSettings({ schedule: next });
  return getSchedule();
}

/** true se in questo momento gli agenti programmati possono partire. */
export function isWorkingTime(cfg = getSchedule(), at = new Date()) {
  if (!cfg.enabled) return true;
  const r = romeParts(at);
  return cfg.days.includes(r.weekday) && r.minutes >= toMinutes(cfg.start) && r.minutes < toMinutes(cfg.end);
}

/** Quando ripartono gli agenti (es. "lunedì alle 07:30"), oppure null se lavorano adesso o l'orario è spento. */
export function resumeText(cfg = getSchedule(), at = new Date()) {
  if (!cfg.enabled || isWorkingTime(cfg, at)) return null;
  const r = romeParts(at);
  if (cfg.days.includes(r.weekday) && r.minutes < toMinutes(cfg.start)) return `oggi alle ${cfg.start}`;
  for (let i = 1; i <= 7; i++) {
    const d = (r.weekday + i) % 7;
    if (cfg.days.includes(d)) return `${i === 1 ? "domani" : DAY_NAMES[d]} alle ${cfg.start}`;
  }
  return null;
}

/** Stato per l'interfaccia: orario, se si lavora adesso e quando si riparte. */
export function scheduleStatus(at = new Date()) {
  const cfg = getSchedule();
  return { ...cfg, now: romeParts(at).label, working: isWorkingTime(cfg, at), resume: resumeText(cfg, at) };
}

/** true se è venerdì (ora italiana) ed è passata l'ora della chiusura delle posizioni degli agenti. */
export function isFridayCloseTime(cfg = getSchedule(), at = new Date()) {
  if (!cfg.fridayClose.enabled) return false;
  const r = romeParts(at);
  return r.weekday === 5 && r.minutes >= toMinutes(cfg.fridayClose.time);
}
