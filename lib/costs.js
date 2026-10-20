// Spesa e risparmio: quanto costano ogni palazzo e ogni agente (dal conteggio giornaliero di store.js), budget del
// mese (generale e per palazzo) e "ritmo" dei palazzi (normale, risparmio, minimo, pausa). Budget e ritmo sono in
// settings.json (chiave costs); il budget si cambia solo dall'interfaccia, il ritmo anche da Orion.
import { getState } from "./store.js";
import { getSettings, updateSettings } from "./settings.js";
import { floorOfRoom, readableRooms } from "./building.js";
import { getSchedule, scheduleFor, hasAppointment } from "./schedule.js";
import { PRICES } from "./models.js";

/** Ritmo di un palazzo: gli agenti programmati lavorano 1, 2 o 4 volte meno spesso, oppure mai. */
export const PACES = {
  normale: { factor: 1, label: "Normale" },
  risparmio: { factor: 2, label: "Risparmio (metà dei lavori)" },
  minimo: { factor: 4, label: "Minimo (un quarto dei lavori)" },
  pausa: { factor: Infinity, label: "In pausa" },
};

const dayKey = (at = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(at);
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

function config() {
  const c = isObj(getSettings().costs) ? getSettings().costs : {};
  return { monthlyUsd: Number(c.monthlyUsd) > 0 ? Number(c.monthlyUsd) : null, palaces: isObj(c.palaces) ? c.palaces : {}, subscriptions: Array.isArray(c.subscriptions) ? c.subscriptions : [] };
}
function saveConfig(c) {
  updateSettings({ costs: c });
}

export const palaceOfAgent = (agent, b) => b.floors.find((f) => f.id === floorOfRoom(b, agent.room))?.palace ?? null;
export const paceOf = (palaceId) => (PACES[config().palaces[palaceId]?.pace] ? config().palaces[palaceId].pace : "normale");

export function setPalacePace(palaceId, pace, b) {
  if (!PACES[pace]) throw new Error(`ritmo: ${Object.keys(PACES).join(", ")}`);
  if (!b.palaces.some((p) => p.id === palaceId)) throw new Error(`il palazzo "${palaceId}" non esiste`);
  const c = config();
  c.palaces[palaceId] = { ...(c.palaces[palaceId] ?? {}), pace };
  saveConfig(c);
  return { palace: palaceId, pace, label: PACES[pace].label };
}

/** Solo dall'interfaccia: budget del mese in dollari (null = nessun limite), generale e per palazzo. */
export function setBudgets({ monthlyUsd, palaces } = {}) {
  const c = config();
  const amount = (v, what) => {
    if (v === null || v === "" || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new Error(`${what}: un numero di dollari (vuoto = nessun limite)`);
    return n || null;
  };
  if (monthlyUsd !== undefined) c.monthlyUsd = amount(monthlyUsd, "Budget del mese");
  for (const [id, v] of Object.entries(isObj(palaces) ? palaces : {})) {
    c.palaces[id] = { ...(c.palaces[id] ?? {}), budgetUsd: amount(v, "Budget del palazzo") };
  }
  saveConfig(c);
}

/** Spesa del mese in corso (ora italiana): totale, per palazzo, per agente, altre voci. */
export function monthSpend(at = new Date()) {
  const month = dayKey(at).slice(0, 7);
  const out = { total: 0, palaces: {}, agents: {}, other: {}, days: 0 };
  for (const [day, d] of Object.entries(getState().usage?.days ?? {})) {
    if (!day.startsWith(month) || !isObj(d)) continue;
    out.days++;
    out.total += Number(d.usd) || 0;
    for (const [id, v] of Object.entries(d.palaces ?? {})) out.palaces[id] = (out.palaces[id] ?? 0) + (Number(v) || 0);
    for (const [k, v] of Object.entries(d.other ?? {})) out.other[k] = (out.other[k] ?? 0) + (Number(v) || 0);
    for (const [id, a] of Object.entries(d.agents ?? {})) {
      const t = (out.agents[id] ??= { usd: 0, runs: 0 });
      t.usd += Number(a?.usd) || 0;
      t.runs += Number(a?.runs) || 0;
    }
  }
  return out;
}

const todaySpend = () => Number(getState().usage?.days?.[dayKey()]?.usd) || 0;

/**
 * Lo scheduler può avviare questo agente? null = sì, altrimenti il motivo (palazzo in pausa, budget raggiunto).
 * month: monthSpend() già calcolato (una volta per giro dello scheduler).
 */
export function scheduleBlock(agent, b, month = monthSpend()) {
  const palace = palaceOfAgent(agent, b);
  if (paceOf(palace) === "pausa") return "palazzo in pausa";
  const c = config();
  if (c.monthlyUsd && month.total >= c.monthlyUsd) return `budget del mese raggiunto (${month.total.toFixed(2)} $ su ${c.monthlyUsd} $)`;
  const pb = Number(c.palaces[palace]?.budgetUsd) || null;
  if (pb && (month.palaces[palace] ?? 0) >= pb) return `budget del palazzo raggiunto (${(month.palaces[palace] ?? 0).toFixed(2)} $ su ${pb} $)`;
  return null;
}

/** Ogni quanti minuti lavora davvero un agente programmato, con il ritmo del suo palazzo. */
export const effectiveEvery = (agent, b) => Math.max(5, agent.everyMinutes) * PACES[paceOf(palaceOfAgent(agent, b))].factor;

/** "Solo con novità": ci sono note nuove (di altri) nelle stanze che l'agente legge, dopo il suo ultimo lavoro? */
export function hasNews(agent, b, since) {
  const notes = getState().notes ?? {};
  return readableRooms(agent, b).some((r) => (notes[r.id] ?? []).some((n) => n.agentId !== agent.id && Date.parse(n.at) >= since));
}

/** Minuti di lavoro al mese secondo l'orario (per stimare quante volte lavora un agente). */
function workMinutesPerMonth(hours) {
  const s = scheduleFor(hours, getSchedule());
  if (!s.enabled) return 30 * 24 * 60;
  const [sh, sm] = s.start.split(":").map(Number);
  const [eh, em] = s.end.split(":").map(Number);
  const perDay = Math.max(0, eh * 60 + em - (sh * 60 + sm));
  return (perDay * s.days.length * 30) / 7;
}

/** Consigli per spendere meno con un agente. */
function tips(agent, perRun, monthly) {
  const out = [];
  const cheap = PRICES["claude-haiku-5-5"][1];
  const price = PRICES[agent.model]?.[1] ?? cheap;
  if (agent.mode === "llm" && price > cheap && monthly > 0.5) out.push(`con Haiku costerebbe circa ${Math.round(price / cheap)} volte meno`);
  if (agent.everyMinutes > 0 && agent.everyMinutes < 60 && monthly > 0.3) out.push("lavora più di una volta all'ora: basta meno spesso?");
  if ((agent.tools ?? []).includes("web_search") && agent.everyMinutes > 0 && agent.everyMinutes < 180) out.push("ricerca web frequente (ogni ricerca costa e porta molto testo)");
  const reacts = !(agent.tools ?? []).some((t) => ["web_search", "get_quote", "get_candles", "get_indicators", "get_calendar", "social_stats", "social_comments"].includes(t));
  if (reacts && !agent.onlyOnNews && agent.everyMinutes > 0) out.push("può lavorare «solo con novità»");
  if (agent.mode === "llm" && agent.effort && !["low"].includes(agent.effort) && perRun > 0.02) out.push(`impegno «${agent.effort}»: con «low» ragiona meno e costa meno`);
  return out;
}

/** Rapporto completo per la sezione 💰 Spesa e per Orion. */
export function costReport(agents, b, at = new Date()) {
  const m = monthSpend(at);
  const c = config();
  const d = new Date(at);
  const dayOfMonth = Number(dayKey(at).slice(8, 10));
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const projection = dayOfMonth > 0 ? (m.total / dayOfMonth) * daysInMonth : m.total;
  const agentRows = agents
    .map((a) => {
      const t = m.agents[a.id] ?? { usd: 0, runs: 0 };
      const perRun = t.runs ? t.usd / t.runs : 0;
      const every = a.enabled && a.everyMinutes > 0 ? effectiveEvery(a, b) : Infinity;
      const palace = palaceOfAgent(a, b);
      // Con un appuntamento fisso lavora una volta in ciascuno dei suoi giorni (circa 4,3 volte al mese per giorno).
      const runsPerMonth = hasAppointment(a) ? (a.enabled ? (a.runDays.length * 30) / 7 : 0) : Number.isFinite(every) ? workMinutesPerMonth(b.palaces.find((p) => p.id === palace)?.hours) / every : 0;
      const monthly = perRun * runsPerMonth;
      return {
        id: a.id,
        name: a.name,
        avatar: a.avatar,
        palace,
        model: a.mode === "llm" ? a.model : "regole",
        effort: a.mode === "llm" ? a.effort : null,
        everyMinutes: a.everyMinutes,
        enabled: a.enabled,
        onlyOnNews: Boolean(a.onlyOnNews),
        usdMonth: t.usd,
        runsMonth: t.runs,
        perRun,
        monthlyEstimate: monthly,
        tips: tips(a, perRun, Math.max(monthly, t.usd)),
      };
    })
    .sort((x, y) => y.usdMonth - x.usdMonth || y.monthlyEstimate - x.monthlyEstimate);
  return {
    month: dayKey(at).slice(0, 7),
    total: m.total,
    today: todaySpend(),
    projection,
    budget: c.monthlyUsd,
    palaces: b.palaces.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      usd: m.palaces[p.id] ?? 0,
      budget: Number(c.palaces[p.id]?.budgetUsd) || null,
      pace: paceOf(p.id),
      agents: agentRows.filter((r) => r.palace === p.id).length,
      monthlyEstimate: agentRows.filter((r) => r.palace === p.id).reduce((n, r) => n + r.monthlyEstimate, 0),
    })),
    other: m.other,
    agents: agentRows,
    paces: Object.fromEntries(Object.entries(PACES).map(([k, v]) => [k, v.label])),
  };
}

// ---------- periodi, abbonamenti e servizi (per gli agenti che controllano le spese) ----------

const ymd = (d) => dayKey(d);
const addDays = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Periodi che gli agenti possono chiedere: giorni compresi (ora italiana). */
export const PERIODS = {
  oggi: "oggi",
  settimana: "ultimi 7 giorni (oggi compreso)",
  settimana_scorsa: "i 7 giorni prima degli ultimi 7",
  mese: "mese in corso",
  mese_scorso: "mese scorso (intero)",
};
export function periodRange(period = "mese", at = new Date()) {
  const today = ymd(at);
  const month = today.slice(0, 7);
  if (period === "oggi") return { from: today, to: today };
  if (period === "settimana") return { from: addDays(today, -6), to: today };
  if (period === "settimana_scorsa") return { from: addDays(today, -13), to: addDays(today, -7) };
  if (period === "mese_scorso") {
    const first = `${month}-01`;
    const last = addDays(first, -1);
    return { from: `${last.slice(0, 7)}-01`, to: last };
  }
  if (period === "mese") return { from: `${month}-01`, to: today };
  throw new Error(`periodo: ${Object.keys(PERIODS).join(", ")}`);
}

/** Spesa tra due giorni compresi (AAAA-MM-GG): totale, per palazzo, per agente, altre voci, giorno per giorno. */
export function spendBetween(from, to) {
  const out = { total: 0, palaces: {}, agents: {}, other: {}, days: {} };
  for (const [day, d] of Object.entries(getState().usage?.days ?? {})) {
    if (day < from || day > to || !isObj(d)) continue;
    out.total += Number(d.usd) || 0;
    out.days[day] = { usd: Number(d.usd) || 0, palaces: {} };
    for (const [id, v] of Object.entries(d.palaces ?? {})) {
      out.palaces[id] = (out.palaces[id] ?? 0) + (Number(v) || 0);
      out.days[day].palaces[id] = Number(v) || 0;
    }
    for (const [k, v] of Object.entries(d.other ?? {})) out.other[k] = (out.other[k] ?? 0) + (Number(v) || 0);
    for (const [id, a] of Object.entries(d.agents ?? {})) {
      const t = (out.agents[id] ??= { usd: 0, runs: 0 });
      t.usd += Number(a?.usd) || 0;
      t.runs += Number(a?.runs) || 0;
    }
  }
  return out;
}

export const SUB_EVERY = { mese: "al mese", anno: "all'anno", "una tantum": "una volta (ricarica o acquisto)" };
const CURRENCIES = ["EUR", "USD"];
const MAX_SUBS = 40;

/** Abbonamenti e servizi a pagamento fuori dalla piattaforma (Railway, ElevenLabs, ricariche di crediti…). */
export function listSubscriptions() {
  return Array.isArray(config().subscriptions) ? config().subscriptions.filter(isObj) : [];
}

/** Salva (o cambia, con id) un abbonamento. Solo informazioni: non paga né attiva niente. */
export function saveSubscription(input = {}, b = null) {
  const subs = listSubscriptions();
  const old = input.id ? subs.find((s) => s.id === String(input.id)) : null;
  if (input.id && !old) throw new Error(`abbonamento "${input.id}" non trovato`);
  const s = { ...(old ?? {}) };
  const text = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  if (input.name !== undefined || !old) {
    s.name = text(input.name, 80);
    if (!s.name) throw new Error("nome: scrivi il servizio (es. Railway Hobby)");
  }
  if (input.amount !== undefined || !old) {
    const n = Number(String(input.amount ?? "").replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new Error("importo: un numero (es. 5 o 6,99)");
    s.amount = Math.round(n * 100) / 100;
  }
  if (input.currency !== undefined || !old) {
    const c = String(input.currency ?? "EUR").toUpperCase().replace("€", "EUR").replace("$", "USD");
    if (!CURRENCIES.includes(c)) throw new Error("valuta: EUR o USD");
    s.currency = c;
  }
  if (input.every !== undefined || !old) {
    const e = String(input.every ?? "mese");
    if (!SUB_EVERY[e]) throw new Error(`ogni: ${Object.keys(SUB_EVERY).join(", ")}`);
    s.every = e;
  }
  if (input.palace !== undefined) {
    const p = input.palace === null || input.palace === "" ? null : String(input.palace);
    if (p && b && !b.palaces.some((x) => x.id === p)) throw new Error(`il palazzo "${p}" non esiste`);
    s.palace = p;
  }
  s.palace ??= null;
  if (input.renews !== undefined) {
    const d = input.renews === null || input.renews === "" ? null : Number(input.renews);
    if (d !== null && !(Number.isInteger(d) && d >= 1 && d <= 31)) throw new Error("rinnovo: il giorno del mese (1–31) o vuoto");
    s.renews = d;
  }
  if (input.date !== undefined) {
    const d = input.date ? String(input.date) : null;
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('data: "AAAA-MM-GG" (es. 2026-10-18)');
    s.date = d;
  }
  if (input.note !== undefined) s.note = text(input.note, 300);
  if (!old) {
    if (subs.length >= MAX_SUBS) throw new Error(`al massimo ${MAX_SUBS} abbonamenti: togline qualcuno`);
    s.id = `ab${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    s.added = ymd(new Date());
  }
  const c = config();
  c.subscriptions = old ? subs.map((x) => (x.id === s.id ? s : x)) : [...subs, s];
  saveConfig(c);
  return s;
}

export function deleteSubscription(id) {
  const subs = listSubscriptions();
  if (!subs.some((s) => s.id === id)) throw new Error("abbonamento non trovato");
  const c = config();
  c.subscriptions = subs.filter((s) => s.id !== id);
  saveConfig(c);
  return { deleted: id };
}

/** Quanto pesano gli abbonamenti in un mese, per valuta (gli annuali divisi per 12, le ricariche solo nel mese della data). */
export function subscriptionsMonthly(subs, month) {
  const out = {};
  for (const s of subs) {
    const v = s.every === "anno" ? s.amount / 12 : s.every === "una tantum" ? (String(s.date ?? s.added ?? "").startsWith(month) ? s.amount : 0) : s.amount;
    out[s.currency] = Math.round(((out[s.currency] ?? 0) + v) * 100) / 100;
  }
  return out;
}

/** Caratteri usati questo mese dalle voci dei video (ElevenLabs a crediti, Google gratis fino a 1 milione). */
function servicesUsage() {
  const s = getSettings();
  const m = new Date().toISOString().slice(0, 7);
  const chars = (u) => (u?.month === m ? Number(u.chars) || 0 : 0);
  const out = {};
  if (s.elevenKey) out.elevenlabs = { caratteri_mese: chars(s.elevenUsage), nota: "1 carattere = 1 credito con i modelli multilingual e v3, mezzo credito con flash; i crediti del piano si vedono su elevenlabs.io" };
  if (s.googleTtsKey) out.google_voci = { caratteri_mese: chars(s.ttsUsage), gratis_al_mese: 1_000_000 };
  return out;
}

const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

/**
 * Spese per gli agenti e per Orion (sola lettura): periodo, palazzi, agenti, altre voci, giorni, abbonamenti, servizi.
 * palace = solo quel palazzo (i suoi agenti e i suoi abbonamenti; quelli senza palazzo restano «generali»).
 */
export function spendingReport(agents, b, { period = "mese", palace = null, top = 15 } = {}, at = new Date()) {
  if (palace && !b.palaces.some((p) => p.id === palace)) throw new Error(`il palazzo "${palace}" non esiste: ${b.palaces.map((p) => p.id).join(", ")}`);
  const range = periodRange(period, at);
  const s = spendBetween(range.from, range.to);
  const c = config();
  const full = costReport(agents, b, at); // stime e consigli sul mese in corso
  const rows = full.agents.filter((a) => !palace || a.palace === palace);
  const n = Math.min(Math.max(Number(top) || 15, 1), 60);
  const subs = listSubscriptions();
  const mySubs = palace ? subs.filter((x) => x.palace === palace) : subs;
  const month = (period === "mese_scorso" ? range.from : range.to).slice(0, 7);
  return {
    periodo: { nome: period, dal: range.from, al: range.to, nota: "spese della piattaforma in dollari: Claude (token e ricerche web) e servizi pagati a consumo (es. letture di X); ora italiana" },
    totale: r2(palace ? s.palaces[palace] : s.total),
    ...(palace ? { totale_di_tutti_i_palazzi: r2(s.total) } : { altre_spese: Object.fromEntries(Object.entries(s.other).map(([k, v]) => [k === "orion" ? "orion_chat" : k === "social" ? "post_programmati" : k, r2(v)])) }),
    mese_in_corso: { spesa: r2(palace ? (full.palaces.find((p) => p.id === palace)?.usd ?? 0) : full.total), stima_fine_mese: r2(full.projection), budget_mese: full.budget },
    palazzi: full.palaces
      .filter((p) => !palace || p.id === palace)
      .map((p) => ({ id: p.id, nome: p.name, spesa_periodo: r2(s.palaces[p.id]), spesa_mese: r2(p.usd), budget_mese: p.budget, ritmo: p.pace, stima_mese_intero: r2(p.monthlyEstimate), agenti: p.agents })),
    giorni: Object.entries(s.days).sort().map(([day, d]) => ({ giorno: day, spesa: r2(palace ? d.palaces[palace] : d.usd) })),
    agenti: rows
      .map((a) => ({ ...a, usdPeriod: s.agents[a.id]?.usd ?? 0, runsPeriod: s.agents[a.id]?.runs ?? 0 }))
      .sort((x, y) => y.usdPeriod - x.usdPeriod || y.monthlyEstimate - x.monthlyEstimate)
      .slice(0, n)
      .map((a) => ({
        id: a.id, nome: a.name, modello: a.model, effort: a.effort, ogni_minuti: a.everyMinutes, acceso: a.enabled, solo_con_novita: a.onlyOnNews,
        spesa_periodo: r2(a.usdPeriod), lavori_periodo: a.runsPeriod, costo_medio_lavoro: Math.round(a.perRun * 1000) / 1000, stima_mese: r2(a.monthlyEstimate), consigli: a.tips,
      })),
    agenti_totali: rows.length,
    abbonamenti: mySubs.map(({ id, name, amount, currency, every, palace: p, renews, date, note }) => ({ id, nome: name, importo: amount, valuta: currency, ogni: every, palazzo: p, rinnovo_giorno: renews ?? null, data: date ?? null, note: note || undefined })),
    abbonamenti_nel_mese: subscriptionsMonthly(mySubs, month),
    ...(palace ? { abbonamenti_generali: subs.filter((x) => !x.palace).length } : {}),
    servizi: servicesUsage(),
    budget_palazzo: palace ? Number(c.palaces[palace]?.budgetUsd) || null : undefined,
  };
}
