// Calendario economico (dati di Forex Factory): eventi con data e ora italiana, impatto, previsione,
// dato precedente e, appena esce, il dato uscito. Si scarica al massimo una volta ogni ora e resta salvato
// in data/calendar.json, così funziona anche se per un po' la fonte non risponde.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";
import { romeParts } from "./schedule.js";

// Prima la copia su GitHub (tre settimane, con i dati usciti), poi la stessa su jsDelivr (settimana in corso)
// e infine il file ufficiale di Forex Factory (settimana in corso, senza i dati usciti).
const DEFAULT_SOURCES = [
  "https://raw.githubusercontent.com/QuarkFX/forex-economic-calendar/main/output/forexfactory_21days.json",
  "https://cdn.jsdelivr.net/gh/QuarkFX/forex-economic-calendar@main/output/forexfactory_thisweek.json",
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
];
const sources = () =>
  process.env.CALENDAR_URLS ? process.env.CALENDAR_URLS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_SOURCES;
const ttlMs = () => Number(process.env.CALENDAR_TTL_MIN ?? 60) * 60_000;
const RETRY_MS = 5 * 60_000; // dopo un errore di tutte le fonti si riprova al massimo ogni 5 minuti
const FILE = path.join(DATA_DIR, "calendar.json");

const IMPACT = { high: "alto", medium: "medio", low: "basso" };
const RANK = { alto: 3, medio: 2, basso: 1, altro: 0 };
const DAY_SHORT = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];

let cache = (() => {
  try {
    const c = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(c?.events) ? c : null;
  } catch {
    return null; // nessun calendario salvato
  }
})();
let lastFailure = null; // { at, error }
let inflight = null;

/** Un evento della fonte nel formato comune; null se manca qualcosa di essenziale. */
export function normalizeEvent(e) {
  if (!e || typeof e !== "object") return null;
  const title = String(e.title ?? e.event ?? "").trim();
  const currency = String(e.country ?? e.currency ?? "").trim().toUpperCase();
  const impact = IMPACT[String(e.impact ?? "").trim().toLowerCase()] ?? "altro"; // festivi e non economici
  let at = null; // istante preciso, solo se l'evento ha un orario
  let day = null; // giorno italiano "AAAA-MM-GG"
  if (e.datetime) {
    // Copia QuarkFX: datetime in UTC; time è "HH:MM" oppure "All Day", "Tentative"…
    if (/^\d{1,2}:\d{2}$/.test(String(e.time ?? "").trim())) at = e.datetime;
    else day = String(e.date ?? e.datetime).slice(0, 10);
  } else if (e.date) {
    // File ufficiale: "2026-10-14T08:30:00-04:00"; la mezzanotte indica tutto il giorno o orario da definire.
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(String(e.date));
    if (m && !(m[2] === "00" && m[3] === "00")) at = e.date;
    else day = m ? m[1] : String(e.date).slice(0, 10);
  }
  let time = null;
  if (at) {
    const t = Date.parse(at);
    if (Number.isNaN(t)) return null;
    const r = romeParts(new Date(t));
    at = new Date(t).toISOString();
    day = r.date;
    time = r.time;
  }
  if (!title || !day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return {
    at,
    day,
    time,
    currency,
    title,
    impact,
    forecast: String(e.forecast ?? e.consensus ?? "").trim(),
    previous: String(e.previous ?? "").trim(),
    actual: String(e.actual ?? "").trim(),
  };
}

async function download(url) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "ufficio-agenti" }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(`${host} non raggiungibile (${err.cause?.code ?? err.name ?? err.message})`);
  }
  if (!res.ok) throw new Error(`${host} ha risposto ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`${host}: risposta non leggibile`);
  }
  const list = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : null;
  if (!list) throw new Error(`${host}: formato sconosciuto`);
  const events = list.map(normalizeEvent).filter(Boolean);
  if (!events.length) throw new Error(`${host}: nessun evento`);
  return { host, events };
}

/** Calendario aggiornato (dalla cache se ha meno di un'ora). Con la fonte irraggiungibile usa l'ultimo salvato. */
export async function loadCalendar({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - Date.parse(cache.fetchedAt) < ttlMs()) return { ...cache, stale: false };
  if (!force && lastFailure && now - lastFailure.at < RETRY_MS) {
    if (cache) return { ...cache, stale: true, error: lastFailure.error };
    throw new Error(lastFailure.error);
  }
  inflight ??= (async () => {
    const errors = [];
    for (const url of sources()) {
      try {
        const { host, events } = await download(url);
        cache = { fetchedAt: new Date().toISOString(), source: host, events };
        lastFailure = null;
        try {
          fs.mkdirSync(path.dirname(FILE), { recursive: true });
          fs.writeFileSync(FILE, JSON.stringify(cache));
        } catch {
          /* la copia su disco è facoltativa */
        }
        return { ...cache, stale: false };
      } catch (err) {
        errors.push(err.message);
      }
    }
    lastFailure = { at: Date.now(), error: `Calendario economico non disponibile: ${errors.join("; ")}. Controlla la connessione a internet.` };
    if (cache) return { ...cache, stale: true, error: lastFailure.error };
    throw new Error(lastFailure.error);
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

const addDays = (isoDay, n) => {
  const d = new Date(`${isoDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekdayOf = (isoDay) => new Date(`${isoDay}T12:00:00Z`).getUTCDay();
const dayLabel = (isoDay) => `${DAY_SHORT[weekdayOf(isoDay)]} ${isoDay.slice(8, 10)}/${isoDay.slice(5, 7)}`;

/** Primo e ultimo giorno (italiani) di un periodo: oggi, domani, ieri, settimana (fino a domenica), 7giorni. */
export function periodDays(giorni = "oggi", at = new Date()) {
  const today = romeParts(at).date;
  switch (giorni) {
    case "domani":
      return [addDays(today, 1), addDays(today, 1)];
    case "ieri":
      return [addDays(today, -1), addDays(today, -1)];
    case "settimana": {
      // Da oggi a domenica; di sabato e di domenica, anche tutta la settimana che arriva.
      const wd = weekdayOf(today);
      const toSunday = (7 - wd) % 7;
      return [today, addDays(today, wd === 6 || wd === 0 ? toSunday + 7 : toSunday)];
    }
    case "7giorni":
      return [today, addDays(today, 6)];
    default:
      return [today, today];
  }
}

/** Una riga leggibile per evento, es. "mer 14/10 14:30 · USD · CPI m/m · impatto alto · previsione 0.6% · precedente 0.4%". */
export function eventLine(e) {
  return [
    `${dayLabel(e.day)} ${e.time ?? "(senza orario preciso)"}`,
    e.currency || "—",
    e.title,
    `impatto ${e.impact}`,
    e.forecast && `previsione ${e.forecast}`,
    e.previous && `precedente ${e.previous}`,
    e.actual && `USCITO ${e.actual}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Risposta dello strumento get_calendar (per gli agenti e per Orion). */
export async function calendarFor({ giorni = "oggi", valute = ["USD"], impatto_minimo = "medio" } = {}, at = new Date()) {
  const cal = await loadCalendar();
  const [from, to] = periodDays(giorni, at);
  const wanted = new Set((Array.isArray(valute) ? valute : [valute]).map((v) => String(v).trim().toUpperCase()).filter(Boolean));
  const allCurrencies = wanted.size === 0 || wanted.has("TUTTE") || wanted.has("ALL");
  const min = RANK[impatto_minimo] ?? RANK.medio;
  const list = cal.events
    .filter((e) => e.day >= from && e.day <= to && RANK[e.impact] >= min && (allCurrencies || wanted.has(e.currency) || e.currency === "ALL"))
    .sort((a, b) => `${a.day} ${a.time ?? "00:00"}`.localeCompare(`${b.day} ${b.time ?? "00:00"}`));
  return {
    fonte: `Forex Factory (${cal.source})`,
    aggiornato: romeParts(new Date(cal.fetchedAt)).label,
    ...(cal.stale ? { avviso: `Fonte non raggiungibile adesso: sono i dati dell'ultimo aggiornamento. ${cal.error ?? ""}`.trim() } : {}),
    periodo: from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`,
    orari: "ora italiana",
    eventi: list.map(eventLine),
    ...(list.length ? {} : { nota: "Nessun evento con questi filtri nel periodo richiesto." }),
  };
}

/** Per i test: dimentica cache ed errori. */
export function resetCalendarCache() {
  cache = null;
  lastFailure = null;
  try {
    fs.rmSync(FILE, { force: true });
  } catch {
    /* niente da cancellare */
  }
}
