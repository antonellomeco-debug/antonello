// Mappa del progetto (⚙️ Impostazioni → 🗺️ Mappa del progetto): tutto quello che serve per analizzare l'universo
// — palazzi, piani, stanze, collegamenti, agenti con istruzioni e strumenti, quanto lavorano e spendono, ultime note,
// social, trading e portafoglio in breve — SENZA chiavi, password, codici di accesso né credenziali.
import fs from "node:fs";
import { office } from "./office.js";
import { getState } from "./store.js";
import { costReport, monthSpend, listSubscriptions } from "./costs.js";
import { getSchedule } from "./schedule.js";
import { getPlatform } from "./platform.js";
import { getSafety } from "./safety.js";
import { getProfile } from "./holdings.js";
import * as social from "./social/index.js";
import { ROOT } from "./paths.js";

const DAY = 86_400_000;
const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const round = (x) => Math.round((Number(x) || 0) * 10000) / 10000;

/** Spesa e lavori di ogni agente negli ultimi `days` giorni (da usage.days). */
function agentSpend(days) {
  const out = {};
  const since = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  for (const [day, d] of Object.entries(getState().usage?.days ?? {})) {
    if (day < since) continue;
    for (const [id, a] of Object.entries(d?.agents ?? {})) {
      const o = (out[id] ??= { usd: 0, lavori: 0 });
      o.usd += Number(a?.usd) || 0;
      o.lavori += Number(a?.runs) || 0;
    }
  }
  for (const o of Object.values(out)) o.usd = round(o.usd);
  return out;
}

/** La mappa completa (oggetto JSON). notesPerRoom = quante note recenti per stanza (accorciate). */
export function projectMap({ notesPerRoom = 3, noteChars = 700 } = {}) {
  const b = office.building();
  const agents = office.agents();
  const st = getState();
  const now = Date.now();
  const spend30 = agentSpend(30);
  const report = costReport(agents, b);
  const estimate = Object.fromEntries((report.agents ?? []).map((r) => [r.id, r]));
  const notes = st.notes ?? {};

  // Note e avvisi per agente (ultimi 7 e 30 giorni).
  const byAgent = {};
  for (const list of Object.values(notes)) {
    for (const n of list) {
      const o = (byAgent[n.agentId] ??= { note7: 0, note30: 0, ultima: null });
      const t = Date.parse(n.at);
      if (now - t <= 7 * DAY) o.note7++;
      if (now - t <= 30 * DAY) o.note30++;
      if (!o.ultima || n.at > o.ultima) o.ultima = n.at;
    }
  }
  const problems = {};
  for (const e of st.log ?? []) {
    if (!["warn", "error"].includes(e.level) || now - Date.parse(e.at) > 7 * DAY) continue;
    const o = (problems[e.agentId] ??= { quanti: 0, ultimi: [] });
    o.quanti++;
    o.ultimi.push(clip(e.message, 200));
    if (o.ultimi.length > 3) o.ultimi.shift();
  }

  const roomsOf = (floorId) => b.rooms.filter((r) => r.floor === floorId);
  const agentsOf = (roomId) => agents.filter((a) => a.room === roomId);
  const agentView = (a) => {
    const { params, ...rest } = a;
    const est = estimate[a.id];
    return {
      ...rest,
      ...(params && Object.keys(params).length ? { params } : {}),
      lavoro: {
        ultimi_30_giorni: spend30[a.id] ?? { usd: 0, lavori: 0 },
        stima_mese_usd: est ? round(est.monthlyEstimate) : undefined,
        costo_medio_per_lavoro_usd: est?.perRun ? round(est.perRun) : undefined,
        note: byAgent[a.id] ?? { note7: 0, note30: 0, ultima: null },
        ...(problems[a.id] ? { avvisi_7_giorni: problems[a.id] } : {}),
      },
    };
  };

  const palaces = b.palaces.map((p) => ({
    id: p.id,
    nome: p.name,
    descrizione: p.description,
    orario: p.hours ?? "lavoro",
    ...(p.pace ? { ritmo: p.pace } : {}),
    piani: b.floors
      .filter((f) => f.palace === p.id)
      .sort((x, y) => (x.level ?? 0) - (y.level ?? 0))
      .map((f) => ({
        id: f.id,
        nome: f.name,
        settore: f.sector,
        livello: f.level,
        trading: f.trading ? { mode: f.trading.mode, ...(f.trading.accountId ? { conto: String(f.trading.accountId) } : {}) } : undefined,
        stanze: roomsOf(f.id).map((r) => {
          const list = notes[r.id] ?? [];
          return {
            id: r.id,
            nome: r.name,
            descrizione: r.description,
            note_totali: list.length,
            note_7_giorni: list.filter((n) => now - Date.parse(n.at) <= 7 * DAY).length,
            ultime_note: list.slice(-notesPerRoom).map((n) => ({ at: n.at, agente: n.agentName ?? n.agentId, tags: n.tags?.length ? n.tags : undefined, testo: clip(n.text, noteChars) })),
            agenti: agentsOf(r.id).map(agentView),
          };
        }),
      })),
  }));

  const knownRooms = new Set(b.rooms.map((r) => r.id));
  const orphans = agents.filter((a) => !knownRooms.has(a.room)).map(agentView);

  let socialSummary = null;
  try {
    socialSummary = social.statusForAgents();
  } catch (err) {
    socialSummary = { errore: err.message };
  }
  const month = monthSpend();
  const safety = getSafety();
  const profile = getProfile();
  const approvals = (st.approvals ?? []).filter((a) => a.status === "pending");
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(`${ROOT}/package.json`, "utf8")).version;
  } catch {
    // facoltativa
  }

  return {
    mappa: "Mappa del progetto (senza chiavi né password)",
    generata: new Date().toISOString(),
    versione_programma: version,
    universo: b.name,
    numeri: {
      palazzi: b.palaces.length,
      piani: b.floors.length,
      stanze: b.rooms.length,
      agenti: agents.length,
      agenti_attivi: agents.filter((a) => a.enabled).length,
      collegamenti: (b.links ?? []).length,
    },
    brief_del_progetto: getPlatform().brief ?? null,
    orario: getSchedule(),
    palazzi: palaces,
    collegamenti: (b.links ?? []).map((l) => ({ da: l.from, a: l.to, senso: l.direction, attivo: l.active !== false })),
    ...(orphans.length ? { agenti_senza_stanza: orphans } : {}),
    spesa: {
      mese_usd: round(month.total),
      altro: month.other,
      oggi_usd: round(report.today),
      stima_fine_mese_usd: round(report.projection),
      budget_mese_usd: report.budget ?? null,
      palazzi: report.palaces.map((p) => ({ id: p.id, usd: round(p.usd), budget: p.budget, ritmo: p.pace, stima_mese_usd: round(p.monthlyEstimate) })),
      abbonamenti: listSubscriptions(),
    },
    social: socialSummary,
    trading: {
      stop_attivo: Boolean(safety.killSwitch?.active),
      limiti: safety.limits,
      conto_reale_sbloccato: Boolean(safety.liveEnabled),
      ordini_cTrader_30_giorni: (st.brokerTrades ?? []).filter((t) => now - Date.parse(t.at ?? t.time ?? 0) <= 30 * DAY).length,
      portafoglio_simulato: { contanti: round(st.portfolio?.cash), posizioni: Object.keys(st.portfolio?.positions ?? {}).length, operazioni: (st.portfolio?.trades ?? []).length },
    },
    portafoglio_azioni: { profilo: profile ?? null },
    approvazioni_in_attesa: approvals.reduce((acc, a) => ({ ...acc, [a.kind ?? "ordine"]: (acc[a.kind ?? "ordine"] ?? 0) + 1 }), {}),
    domande_aperte: (st.requests ?? []).filter((r) => r.status === "open").length,
  };
}
