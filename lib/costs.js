// Spesa e risparmio: quanto costano ogni palazzo e ogni agente (dal conteggio giornaliero di store.js), budget del
// mese (generale e per palazzo) e "ritmo" dei palazzi (normale, risparmio, minimo, pausa). Budget e ritmo sono in
// settings.json (chiave costs); il budget si cambia solo dall'interfaccia, il ritmo anche da Orion.
import { getState } from "./store.js";
import { getSettings, updateSettings } from "./settings.js";
import { floorOfRoom, readableRooms } from "./building.js";
import { getSchedule, scheduleFor } from "./schedule.js";
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
  return { monthlyUsd: Number(c.monthlyUsd) > 0 ? Number(c.monthlyUsd) : null, palaces: isObj(c.palaces) ? c.palaces : {} };
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
      const runsPerMonth = Number.isFinite(every) ? workMinutesPerMonth(b.palaces.find((p) => p.id === palace)?.hours) / every : 0;
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
