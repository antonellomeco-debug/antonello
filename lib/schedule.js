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

/**
 * Appuntamento fisso di un agente: runDays (0 = domenica … 6 = sabato) e runAt "HH:MM" in ora italiana. Un agente con
 * runDays lavora una volta in quei giorni, appena passata l'ora (anche fuori dall'orario del suo palazzo, es. il report
 * della domenica), e non ogni everyMinutes.
 */
export const DEFAULT_RUN_AT = "18:00";
export const hasAppointment = (agent) => Array.isArray(agent?.runDays) && agent.runDays.length > 0;

/** È il momento dell'appuntamento? lastDate = giorno ("AAAA-MM-GG") dell'ultimo appuntamento fatto. */
export function appointmentDue(agent, lastDate, at = new Date()) {
  if (!hasAppointment(agent)) return false;
  const r = romeParts(at);
  const runAt = HHMM.test(agent.runAt ?? "") ? agent.runAt : DEFAULT_RUN_AT;
  return agent.runDays.includes(r.weekday) && r.minutes >= toMinutes(runAt) && lastDate !== r.date;
}

/** Da quanti minuti in su un agente è «di più giorni» (ogni giorno, settimana, mese): non riparte a ogni apertura. */
export const LONG_EVERY_MIN = 1440;

/**
 * Ultimo lavoro da usare per lo scheduler (millisecondi, 0 = mai). Gli agenti «di giornata» (intervallo sotto un giorno)
 * contano solo il lavoro di oggi: all'apertura dell'orario ripartono tutti. Quelli con un intervallo di uno o più giorni
 * contano sempre il loro ultimo lavoro: un agente settimanale lavora davvero una volta alla settimana.
 */
export function lastRunFor(everyMinutes, lastIso, at = new Date()) {
  const t = lastIso ? Date.parse(lastIso) : NaN;
  if (Number.isNaN(t)) return 0;
  if (Number(everyMinutes) >= LONG_EVERY_MIN) return t;
  return romeParts(new Date(t)).date === romeParts(at).date ? t : 0;
}

/** Errori di runDays/runAt (per la validazione degli agenti). */
export function appointmentErrors(agent) {
  const errors = [];
  if (agent.runDays !== undefined && agent.runDays !== null) {
    if (!Array.isArray(agent.runDays) || agent.runDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(agent.runDays).size !== agent.runDays.length) {
      errors.push("runDays: elenco di giorni senza doppioni, 0 = domenica … 6 = sabato (vuoto = nessun appuntamento fisso)");
    }
  }
  if (agent.runAt !== undefined && agent.runAt !== null && agent.runAt !== "" && !HHMM.test(String(agent.runAt))) errors.push('runAt: ora "HH:MM" (es. "18:00")');
  return errors;
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

/**
 * Orario di un palazzo: "lavoro" = l'orario di lavoro generale; "tutti-i-giorni" = stesse ore anche sabato e domenica
 * (per esempio i social, che nel fine settimana sono più attivi); "sempre" = a qualsiasi ora.
 */
export const PALACE_HOURS = { lavoro: "Orario di lavoro", "tutti-i-giorni": "Tutti i giorni, stesse ore", sempre: "Sempre, 24 ore su 24" };
export function scheduleFor(hours, cfg = getSchedule()) {
  if (hours === "sempre") return { ...cfg, enabled: false };
  if (hours === "tutti-i-giorni") return { ...cfg, days: [0, 1, 2, 3, 4, 5, 6] };
  return cfg;
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
