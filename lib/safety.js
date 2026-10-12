// Regole di sicurezza per gli ordini: pulsante STOP, limiti, perdita massima giornaliera, conto reale.
// Le decide solo l'utente dall'interfaccia (non Orion né gli agenti). Salvate in data/safety.json.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths.js";
import { bus, log } from "./store.js";

const FILE = path.join(DATA_DIR, "safety.json");
export const LIVE_CONFIRM = "SOLDI VERI";

const DEFAULT_LIMITS = {
  maxLotsPerOrder: 0.1, // quantità massima per singolo ordine sul broker
  maxOpenPositions: 5, // posizioni aperte dagli agenti, per conto
  maxOrdersPerDay: 20, // ordini al giorno, per conto
  maxDailyLossPct: 3, // perdita massima del giorno (% del valore del conto a inizio giornata)
  requireStopLoss: true, // ogni ordine sul broker ha uno stop loss (se l'agente non lo indica si usa quello predefinito)
  defaultStopLossPct: 2, // stop loss usato quando l'agente non lo indica
  closeOnStop: false, // con lo STOP automatico chiude anche le posizioni degli agenti
};

let state = load();

function load() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    /* prima volta */
  }
  return {
    killSwitch: { active: false, at: null, reason: "", ...(s.killSwitch ?? {}) },
    liveEnabled: Boolean(s.liveEnabled),
    limits: migrateLimits({ ...DEFAULT_LIMITS, ...(s.limits ?? {}) }),
    daily: s.daily ?? { date: "", accounts: {} },
  };
}

function migrateLimits(l) {
  if ("requireStopLossLive" in l) {
    l.requireStopLoss = l.requireStopLossLive !== false;
    delete l.requireStopLossLive;
  }
  return l;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE);
  bus.emit("event", { type: "safety" });
}

const today = () => new Date().toISOString().slice(0, 10);
function day() {
  if (state.daily.date !== today()) state.daily = { date: today(), accounts: {} };
  return state.daily;
}
function accountDay(accountId) {
  const d = day();
  return (d.accounts[String(accountId)] ??= { startEquity: null, orders: 0, equity: null, lossPct: 0, breached: false });
}

export function getSafety() {
  day();
  return structuredClone(state);
}

const RANGES = {
  maxLotsPerOrder: [0.01, 100],
  maxOpenPositions: [1, 100],
  maxOrdersPerDay: [1, 1000],
  maxDailyLossPct: [0.5, 50],
  defaultStopLossPct: [0.1, 50],
};
const LABELS = {
  maxLotsPerOrder: "Lotti massimi per ordine",
  maxOpenPositions: "Posizioni aperte massime",
  maxOrdersPerDay: "Ordini massimi al giorno",
  maxDailyLossPct: "Perdita massima del giorno",
  defaultStopLossPct: "Stop loss predefinito",
};

export function updateLimits(patch) {
  const next = { ...state.limits };
  for (const [k, [min, max]] of Object.entries(RANGES)) {
    if (patch[k] == null || patch[k] === "") continue;
    const v = Number(patch[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${LABELS[k]}: il valore deve stare tra ${min} e ${max}.`);
    next[k] = v;
  }
  if (typeof patch.requireStopLossLive === "boolean" && typeof patch.requireStopLoss !== "boolean") patch.requireStopLoss = patch.requireStopLossLive;
  for (const k of ["requireStopLoss", "closeOnStop"]) if (typeof patch[k] === "boolean") next[k] = patch[k];
  state.limits = next;
  // Alzando il limite di perdita, i conti fermati sotto il nuovo limite possono tornare a operare.
  // (solo se il nuovo limite supera sia la perdita che aveva fatto scattare il blocco sia quella attuale)
  for (const d of Object.values(day().accounts)) {
    if (d.breached && next.maxDailyLossPct > Math.max(d.breachPct ?? d.lossPct, d.lossPct)) d.breached = false;
  }
  save();
  return state.limits;
}

/** Il conto reale si sblocca solo scrivendo la frase di conferma. */
export function setLive(enabled, confirm) {
  if (enabled && String(confirm ?? "").trim().toUpperCase() !== LIVE_CONFIRM) {
    throw new Error(`Per sbloccare il conto reale scrivi esattamente: ${LIVE_CONFIRM}`);
  }
  state.liveEnabled = Boolean(enabled);
  save();
  log("sicurezza", "warn", enabled ? "Conto REALE sbloccato dall'utente" : "Conto reale bloccato");
}

export function activateKill(reason) {
  state.killSwitch = { active: true, at: new Date().toISOString(), reason: reason || "STOP premuto dall'utente" };
  save();
  log("sicurezza", "error", `⛔ STOP: ${state.killSwitch.reason}`);
}

export function deactivateKill() {
  state.killSwitch = { active: false, at: new Date().toISOString(), reason: "" };
  save();
  log("sicurezza", "info", "STOP disattivato: gli ordini sono di nuovo permessi");
}

export const isStopped = () => state.killSwitch.active;

export function assertNotStopped() {
  if (state.killSwitch.active) throw new Error(`⛔ STOP attivo (${state.killSwitch.reason}): nessun ordine è permesso finché non lo disattivi.`);
}

/** Controlli prima di mandare un ordine al broker. */
export function assertBrokerOrder({ accountId, isLive, lots, openAgentPositions }) {
  assertNotStopped();
  if (isLive && !state.liveEnabled) throw new Error("Il conto REALE è bloccato: si sblocca solo da Broker → Sicurezza.");
  const L = state.limits;
  if (lots > L.maxLotsPerOrder) throw new Error(`Ordine troppo grande: ${lots} lotti, il limite è ${L.maxLotsPerOrder} (Broker → Sicurezza).`);
  if (openAgentPositions >= L.maxOpenPositions) throw new Error(`Troppe posizioni aperte dagli agenti su questo conto (limite ${L.maxOpenPositions}).`);
  const d = accountDay(accountId);
  if (d.orders >= L.maxOrdersPerDay) throw new Error(`Raggiunto il numero massimo di ordini di oggi su questo conto (${L.maxOrdersPerDay}).`);
  if (d.breached) {
    throw new Error(
      `Su questo conto oggi la perdita ha raggiunto il ${(d.breachPct ?? d.lossPct).toFixed(2)}% (limite ${L.maxDailyLossPct}%): ` +
        "nuovi ordini bloccati fino a domani (ora UTC), oppure alza il limite in Broker → Sicurezza.",
    );
  }
}

export function recordBrokerOrder(accountId) {
  accountDay(accountId).orders++;
  save();
}

/** Dati di oggi di un conto (copia). */
export function dailyAccount(accountId) {
  return structuredClone(accountDay(accountId));
}

/**
 * Registra il valore del conto e controlla la perdita del giorno (il giorno è quello UTC).
 * netFlow = depositi meno prelievi da inizio giornata: non sono guadagni o perdite e vengono tolti.
 * Al primo superamento del limite attiva lo STOP; il conto resta bloccato per il resto della giornata
 * (anche se l'utente riattiva gli ordini) a meno che il limite venga alzato.
 * Restituisce { lossPct, breached, fresh } (fresh = superato adesso).
 */
export function checkDailyLoss(accountId, equity, { netFlow = 0, at = Date.now(), balanceVersion = null } = {}) {
  const d = accountDay(accountId);
  if (d.startEquity == null) {
    Object.assign(d, { startEquity: equity, startAt: at, startBalanceVersion: balanceVersion });
    netFlow = 0;
  }
  const adjusted = equity - netFlow;
  const lossPct = d.startEquity > 0 ? ((d.startEquity - adjusted) / d.startEquity) * 100 : 0;
  d.equity = equity;
  d.netFlow = netFlow;
  d.lossPct = Math.round(lossPct * 100) / 100;
  const over = lossPct >= state.limits.maxDailyLossPct;
  const fresh = over && !d.breached;
  if (fresh) {
    d.breached = true;
    d.breachPct = d.lossPct;
    activateKill(`perdita del giorno ${lossPct.toFixed(2)}% sul conto ${accountId}, oltre il limite del ${state.limits.maxDailyLossPct}%`);
  } else save();
  return { lossPct, breached: d.breached, fresh };
}
