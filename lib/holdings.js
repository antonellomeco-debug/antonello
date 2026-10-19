// Il portafoglio vero dell'utente: azioni che compra e vende lui con la sua banca o il suo broker. Gli agenti mandano
// SEGNALI (comprare o vendere) in ✅ Approvazioni; quando l'utente approva scrive quante azioni ha comprato o venduto e
// a che prezzo, e il portafoglio si aggiorna. Gli agenti lo leggono (my_portfolio) per seguire le azioni e dire quando
// vendere. Qui non parte nessun ordine: i soldi li muove solo l'utente.
// Dati in <dati>/holdings.json (nei backup; «Azzera tutto» non lo tocca).
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./paths.js";
import { writeFileAtomic, readJsonSafe } from "./files.js";
import { bus, getState, addApproval, updateApproval, log } from "./store.js";
import { stockQuote } from "./market.js";
import * as safety from "./safety.js";

const FILE = path.join(DATA_DIR, "holdings.json");
const MAX_CLOSED = 200;
const MAX_PENDING_BUYS = 5; // segnali d'acquisto in attesa nello stesso momento: oltre, si aspetta che l'utente decida
export const RISKS = ["basso", "medio", "alto"];
export const HORIZONS = ["breve", "medio", "lungo"]; // settimane, mesi, anni
export const LEVEL_CHECK_MS = 15 * 60_000;

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const num = (x) => (typeof x === "number" ? x : x === "" || x == null ? NaN : Number(String(x).replace(",", ".")));
const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const money = (x) => Math.round(x * 100) / 100;
const text = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const newId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
export const normSymbol = (s) => String(s ?? "").trim().toUpperCase().replace(/\s+/g, "");
const SYMBOL = /^[A-Z0-9^][A-Z0-9.^=_-]{0,19}$/;

let data = load();
function load() {
  const r = readJsonSafe(FILE);
  const d = isObj(r.data) ? r.data : {};
  return {
    profile: isObj(d.profile) ? d.profile : {},
    positions: Array.isArray(d.positions) ? d.positions.filter((p) => isObj(p) && typeof p.id === "string") : [],
    closed: Array.isArray(d.closed) ? d.closed.filter(isObj) : [],
  };
}
function save(what) {
  writeFileAtomic(FILE, JSON.stringify(data, null, 2));
  bus.emit("event", { type: "holdings", what });
}
/** Per i test e dopo un'importazione dei dati. */
export function reload() {
  data = load();
}

// ---------- profilo d'investimento ----------

export function getProfile() {
  return { capital: null, risk: "medio", horizon: "medio", markets: "", sectors: "", notes: "", ...data.profile };
}

/** Profilo scritto dall'utente: gli agenti lo usano per scegliere le azioni e quanto suggerire di comprare. */
export function setProfile(p = {}) {
  const capital = p.capital === "" || p.capital == null ? null : num(p.capital);
  if (capital != null && !(capital >= 0 && capital < 1e10)) throw new Error("Capitale: scrivi una cifra in euro (es. 10000) o lascia vuoto.");
  const risk = String(p.risk ?? "medio");
  const horizon = String(p.horizon ?? "medio");
  if (!RISKS.includes(risk)) throw new Error(`Rischio: ${RISKS.join(", ")}`);
  if (!HORIZONS.includes(horizon)) throw new Error(`Orizzonte: ${HORIZONS.join(", ")}`);
  data.profile = { capital: capital == null ? null : money(capital), risk, horizon, markets: text(p.markets, 200), sectors: text(p.sectors, 200), notes: text(p.notes, 600), updatedAt: new Date().toISOString() };
  save("profile");
  return getProfile();
}

// ---------- posizioni ----------

const findPosition = (id) => data.positions.find((p) => p.id === id);
const positionBySymbol = (symbol) => data.positions.find((p) => p.symbol === normSymbol(symbol));

function checkTrade({ qty, price, fees }) {
  const q = num(qty);
  const pr = num(price);
  const f = fees === "" || fees == null ? 0 : num(fees);
  if (!(q > 0) || q > 1e9) throw new Error("Quantità: quante azioni (es. 10; anche con decimali se il tuo broker le frazioni).");
  if (!(pr > 0) || pr > 1e7) throw new Error("Prezzo: il prezzo pagato o incassato per una azione (es. 182,50).");
  if (!(f >= 0) || f > 1e6) throw new Error("Commissioni: una cifra (0 se non le sai).");
  return { qty: round(q, 6), price: round(pr, 6), fees: money(f) };
}

function checkDate(v) {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 86_400_000) throw new Error("Data non valida.");
  return d.toISOString();
}

const optLevel = (v, name) => {
  if (v === "" || v == null) return null;
  const n = num(v);
  if (!(n > 0)) throw new Error(`${name}: un prezzo maggiore di zero, oppure vuoto.`);
  return round(n, 6);
};

/**
 * Acquisto fatto dall'utente (da un segnale approvato o aggiunto a mano). Se ha già quell'azione, il prezzo medio
 * si ricalcola. Restituisce la posizione.
 */
export function addBuy({ symbol, name, currency, qty, price, fees, date, stopLoss, target, horizon, thesis, signal } = {}) {
  const sym = normSymbol(symbol);
  if (!SYMBOL.test(sym)) throw new Error("Simbolo: come su Yahoo Finance (es. AAPL, ENI.MI, ISP.MI).");
  const t = checkTrade({ qty, price, fees });
  const at = checkDate(date);
  const stop = optLevel(stopLoss, "Stop loss");
  const tgt = optLevel(target, "Obiettivo");
  let p = positionBySymbol(sym);
  if (p) {
    const cost = p.qty * p.avgPrice + t.qty * t.price;
    p.qty = round(p.qty + t.qty, 6);
    p.avgPrice = round(cost / p.qty, 6);
    p.fees = money((p.fees ?? 0) + t.fees);
    p.currency ||= text(currency, 8) || null;
    p.name ||= text(name, 80) || null;
    if (stop != null) p.stopLoss = stop;
    if (tgt != null) p.target = tgt;
  } else {
    p = {
      id: newId("h"), symbol: sym, name: text(name, 80) || null, currency: text(currency, 8) || null,
      qty: t.qty, avgPrice: t.price, fees: t.fees, openedAt: at,
      stopLoss: stop, target: tgt, horizon: HORIZONS.includes(horizon) ? horizon : null, thesis: text(thesis, 600),
      buys: [], alerted: {},
    };
    data.positions.push(p);
  }
  p.buys = [...(p.buys ?? []), { at, qty: t.qty, price: t.price, fees: t.fees, signalId: signal?.id ?? null, agent: signal?.agentName ?? null }].slice(-50);
  if (signal) Object.assign(p, { signalId: signal.id, agentId: signal.agentId, agentName: signal.agentName, thesis: text(signal.reason, 600) || p.thesis });
  p.alerted = {}; // livelli nuovi o prezzo medio nuovo: i controlli ripartono
  save("buy");
  return p;
}

/** Azione aggiunta a mano dall'utente: il simbolo deve esistere su Yahoo (così si conoscono nome e valuta). */
export async function addManual(input = {}) {
  const sym = normSymbol(input.symbol);
  if (!SYMBOL.test(sym)) throw new Error("Simbolo: come su Yahoo Finance (es. AAPL, ENI.MI, ISP.MI).");
  const q = await stockQuote(sym);
  return addBuy({ ...input, symbol: sym, name: q.name, currency: q.currency });
}

/** Vendita fatta dall'utente (tutta o in parte): la parte venduta va tra le operazioni chiuse con il risultato. */
export function addSell(id, { qty, price, fees, date, reason, signal } = {}) {
  const p = findPosition(id);
  if (!p) throw new Error("Azione non trovata nel tuo portafoglio.");
  const t = checkTrade({ qty, price, fees });
  if (t.qty > p.qty + 1e-9) throw new Error(`Hai ${p.qty} azioni di ${p.symbol}: non puoi venderne ${t.qty}.`);
  const at = checkDate(date);
  // Commissioni d'acquisto divise in proporzione alle azioni vendute.
  const buyFees = p.qty > 0 ? (p.fees ?? 0) * (t.qty / p.qty) : 0;
  const pnl = money((t.price - p.avgPrice) * t.qty - t.fees - buyFees);
  const closed = {
    id: newId("c"), positionId: p.id, symbol: p.symbol, name: p.name, currency: p.currency,
    qty: t.qty, avgPrice: p.avgPrice, sellPrice: t.price, fees: money(t.fees + buyFees), pnl,
    pnlPct: round(((t.price - p.avgPrice) / p.avgPrice) * 100, 2), openedAt: p.openedAt, closedAt: at,
    reason: text(reason ?? signal?.reason, 600), agentName: signal?.agentName ?? null, signalId: signal?.id ?? null,
  };
  data.closed = [...data.closed, closed].slice(-MAX_CLOSED);
  p.fees = money((p.fees ?? 0) - buyFees);
  p.qty = round(p.qty - t.qty, 6);
  if (p.qty <= 1e-9) data.positions = data.positions.filter((x) => x.id !== p.id);
  save("sell");
  return closed;
}

/** Correzione a mano (errori di battitura, livelli nuovi). */
export function updatePosition(id, patch = {}) {
  const p = findPosition(id);
  if (!p) throw new Error("Azione non trovata nel tuo portafoglio.");
  if (patch.qty !== undefined || patch.avgPrice !== undefined) {
    const t = checkTrade({ qty: patch.qty ?? p.qty, price: patch.avgPrice ?? p.avgPrice, fees: p.fees });
    p.qty = t.qty;
    p.avgPrice = t.price;
  }
  if (patch.stopLoss !== undefined) p.stopLoss = optLevel(patch.stopLoss, "Stop loss");
  if (patch.target !== undefined) p.target = optLevel(patch.target, "Obiettivo");
  if (patch.notes !== undefined) p.notes = text(patch.notes, 600);
  p.alerted = {};
  save("update");
  return p;
}

/** Toglie un'azione inserita per sbaglio (non è una vendita: nessun risultato tra le operazioni chiuse). */
export function removePosition(id) {
  const before = data.positions.length;
  data.positions = data.positions.filter((p) => p.id !== id);
  if (data.positions.length === before) throw new Error("Azione non trovata nel tuo portafoglio.");
  save("remove");
  return { removed: true };
}

// ---------- valori attuali ----------

// Cambi in euro (es. USD → EUR) da Yahoo; le azioni di Londra sono quotate in pence (GBp).
async function toEur(currency) {
  const c = String(currency ?? "");
  if (!c || c === "EUR") return { rate: 1, unit: 1 };
  const pence = c === "GBp" || c === "GBX";
  const cur = pence ? "GBP" : c.toUpperCase();
  const q = await stockQuote(`${cur}EUR=X`);
  return { rate: q.price, unit: pence ? 0.01 : 1 };
}

/**
 * Portafoglio con i prezzi di adesso: valore, guadagno o perdita di ogni azione e in totale (in euro, con il cambio
 * del giorno per le azioni in altre valute). I prezzi mancanti non fermano il resto.
 */
export async function snapshot() {
  const fx = new Map();
  const rateFor = async (c) => {
    if (!fx.has(c)) fx.set(c, await toEur(c).catch(() => null));
    return fx.get(c);
  };
  const positions = [];
  const missing = [];
  for (const p of data.positions) {
    const row = { ...p, price: null, value: null, valueEur: null, pnl: null, pnlPct: null, pnlEur: null, changePct: null, priceDate: null };
    try {
      const q = await stockQuote(p.symbol);
      row.price = q.price;
      row.changePct = round(q.changePct, 2);
      row.priceDate = q.date;
      row.priceSource = q.source;
      row.currency = p.currency || q.currency || "";
      row.name = p.name || q.name || null;
      row.value = money(q.price * p.qty);
      row.pnl = money((q.price - p.avgPrice) * p.qty - (p.fees ?? 0));
      row.pnlPct = round(((q.price - p.avgPrice) / p.avgPrice) * 100, 2);
      row.toStopPct = p.stopLoss ? round(((q.price - p.stopLoss) / q.price) * 100, 2) : null;
      row.toTargetPct = p.target ? round(((p.target - q.price) / q.price) * 100, 2) : null;
      const r = await rateFor(row.currency);
      if (r) {
        row.valueEur = money(row.value * r.rate * r.unit);
        row.pnlEur = money(row.pnl * r.rate * r.unit);
        row.costEur = money((p.avgPrice * p.qty + (p.fees ?? 0)) * r.rate * r.unit);
      } else missing.push(`cambio ${row.currency}`);
    } catch (err) {
      missing.push(`${p.symbol}: ${err.message}`);
    }
    positions.push(row);
  }
  const priced = positions.filter((p) => p.valueEur != null);
  const value = money(priced.reduce((s, p) => s + p.valueEur, 0));
  const cost = money(priced.reduce((s, p) => s + p.costEur, 0));
  for (const p of positions) p.weightPct = p.valueEur != null && value > 0 ? round((p.valueEur / value) * 100, 1) : null;
  const closed = data.closed.slice().reverse();
  const realizedByCurrency = {};
  for (const c of closed) realizedByCurrency[c.currency || "?"] = money((realizedByCurrency[c.currency || "?"] ?? 0) + c.pnl);
  return {
    profile: getProfile(),
    positions,
    closed: closed.slice(0, 50),
    totals: {
      value, cost, pnl: money(value - cost), pnlPct: cost > 0 ? round(((value - cost) / cost) * 100, 2) : null,
      count: positions.length, priced: priced.length, realizedByCurrency,
      wins: data.closed.filter((c) => c.pnl > 0).length, losses: data.closed.filter((c) => c.pnl < 0).length,
    },
    missing,
    at: new Date().toISOString(),
  };
}

// ---------- segnali degli agenti (in ✅ Approvazioni) ----------

const pendingSignals = () => getState().approvals.filter((a) => a.kind === "signal" && a.status === "pending");

/**
 * Un agente propone di comprare o vendere un'azione. Il segnale va in ✅ Approvazioni: l'utente approva scrivendo
 * quante azioni ha comprato o venduto e a che prezzo, oppure scarta.
 */
export async function proposeSignal(agent, input = {}) {
  safety.assertNotStopped();
  const side = input.side === "sell" ? "sell" : input.side === "buy" ? "buy" : null;
  if (!side) throw new Error('side: "buy" (comprare) o "sell" (vendere)');
  const reason = text(input.reason, 1500);
  if (reason.length < 20) throw new Error("reason: spiega in poche righe perché (dati, livelli, rischi, fonti con data).");
  const sym = normSymbol(input.symbol);
  if (!SYMBOL.test(sym)) throw new Error("symbol: ticker come su Yahoo Finance (es. AAPL, ENI.MI).");
  const q = await stockQuote(sym); // il titolo deve esistere e avere un prezzo
  const signal = {
    side, symbol: sym, name: q.name ?? null, currency: q.currency, priceAtSignal: q.price, priceDate: q.date, reason,
    horizon: HORIZONS.includes(input.horizon) ? input.horizon : null,
  };
  if (side === "buy") {
    if (pendingSignals().some((a) => a.signal.side === "buy" && a.signal.symbol === sym)) {
      throw new Error(`C'è già un segnale d'acquisto su ${sym} in attesa: aspetta la decisione dell'utente.`);
    }
    if (pendingSignals().filter((a) => a.signal.side === "buy").length >= MAX_PENDING_BUYS) {
      throw new Error(`Ci sono già ${MAX_PENDING_BUYS} segnali d'acquisto in attesa: proponi solo quando l'utente avrà deciso su quelli.`);
    }
    const stop = optLevel(input.stop_loss, "stop_loss");
    const target = optLevel(input.target, "target");
    if (!stop) throw new Error("stop_loss: il prezzo a cui uscire se va male (obbligatorio per i segnali d'acquisto).");
    if (stop >= q.price) throw new Error(`stop_loss (${stop}) deve stare sotto il prezzo attuale (${q.price}).`);
    if (target != null && target <= q.price) throw new Error(`target (${target}) deve stare sopra il prezzo attuale (${q.price}).`);
    const entryMin = optLevel(input.entry_min, "entry_min");
    const entryMax = optLevel(input.entry_max, "entry_max");
    const pct = input.suggested_pct == null || input.suggested_pct === "" ? null : num(input.suggested_pct);
    if (pct != null && !(pct > 0 && pct <= 25)) throw new Error("suggested_pct: percentuale del capitale tra 0 e 25 (nessun titolo oltre il 25%).");
    Object.assign(signal, { stopLoss: stop, target, entryMin, entryMax, suggestedPct: pct });
    const capital = getProfile().capital;
    if (pct && capital) {
      const fx = await toEur(q.currency).catch(() => null);
      const priceEur = fx ? q.price * fx.rate * fx.unit : null;
      signal.suggestedEur = money((capital * pct) / 100);
      signal.suggestedQty = priceEur ? Math.floor(signal.suggestedEur / priceEur) : null;
    }
    const held = positionBySymbol(sym);
    if (held) signal.alreadyHeld = { qty: held.qty, avgPrice: held.avgPrice };
  } else {
    const p = input.position_id ? findPosition(String(input.position_id)) : positionBySymbol(sym);
    if (!p || p.symbol !== sym) throw new Error(`${sym} non è nel portafoglio dell'utente: usa my_portfolio per vedere le sue azioni.`);
    if (pendingSignals().some((a) => a.signal.side === "sell" && a.signal.positionId === p.id)) {
      throw new Error(`C'è già un segnale di vendita su ${sym} in attesa.`);
    }
    const sellPct = input.sell_pct == null || input.sell_pct === "" ? 100 : num(input.sell_pct);
    if (!(sellPct > 0 && sellPct <= 100)) throw new Error("sell_pct: percentuale della posizione da vendere (1–100, default 100).");
    Object.assign(signal, {
      positionId: p.id, sellPct, heldQty: p.qty, avgPrice: p.avgPrice,
      suggestedQty: round((p.qty * sellPct) / 100, 6), pnlPct: round(((q.price - p.avgPrice) / p.avgPrice) * 100, 2),
    });
  }
  const a = addApproval(agent, null, { kind: "signal", signal });
  log(agent.id, "info", `Segnale ${side === "buy" ? "d'acquisto" : "di vendita"} su ${sym} in ✅ Approvazioni.`);
  return { status: "pending_approval", approvalId: a.id, message: "Segnale inviato all'utente in ✅ Approvazioni: decide lui se e quanto comprare o vendere." };
}

/**
 * Decisione dell'utente su un segnale. Approvare = «l'ho fatto»: con quantità e prezzo (e commissioni) l'acquisto o la
 * vendita entra nel portafoglio.
 */
export function decideSignal(id, { approve, qty, price, fees, date } = {}) {
  const a = getState().approvals.find((x) => x.id === id && x.kind === "signal");
  if (!a) throw new Error("Segnale non trovato");
  if (a.status !== "pending") throw new Error("Segnale già deciso");
  if (!approve) return updateApproval(id, { status: "rejected" });
  const s = a.signal;
  const who = { id: a.id, agentId: a.agentId, agentName: a.agentName, reason: s.reason };
  if (s.side === "buy") {
    const p = addBuy({ symbol: s.symbol, name: s.name, currency: s.currency, qty, price, fees, date, stopLoss: s.stopLoss, target: s.target, horizon: s.horizon, signal: who });
    return updateApproval(id, { status: "executed", fill: { qty: num(qty), price: num(price), fees: num(fees) || 0, positionId: p.id } });
  }
  if (!findPosition(s.positionId)) throw new Error("L'azione non è più nel portafoglio (venduta o tolta): scarta il segnale.");
  const c = addSell(s.positionId, { qty, price, fees, date, signal: who });
  return updateApproval(id, { status: "executed", fill: { qty: c.qty, price: c.sellPrice, fees: c.fees, pnl: c.pnl, pnlPct: c.pnlPct } });
}

/** Per gli agenti: portafoglio con prezzi, profilo, segnali in attesa e gli ultimi decisi (con l'esito). */
export async function forAgents() {
  const s = await snapshot();
  const signals = getState().approvals.filter((a) => a.kind === "signal");
  const brief = (a) => ({ id: a.id, quando: a.at, agente: a.agentName, lato: a.signal.side, simbolo: a.signal.symbol, prezzo: a.signal.priceAtSignal, stato: a.status, eseguito: a.fill ?? null });
  return {
    profilo: s.profile,
    posizioni: s.positions.map((p) => ({
      position_id: p.id, simbolo: p.symbol, nome: p.name, valuta: p.currency, quantita: p.qty, prezzo_medio: p.avgPrice, prezzo: p.price,
      data_prezzo: p.priceDate, valore: p.value, valore_eur: p.valueEur, risultato: p.pnl, risultato_pct: p.pnlPct, peso_pct: p.weightPct,
      stop_loss: p.stopLoss, obiettivo: p.target, distanza_stop_pct: p.toStopPct ?? null, distanza_obiettivo_pct: p.toTargetPct ?? null,
      comprata_il: p.openedAt, tesi: p.thesis, segnalata_da: p.agentName ?? null,
    })),
    totali_eur: s.totals,
    chiuse: s.closed.slice(0, 15).map((c) => ({ simbolo: c.symbol, quantita: c.qty, prezzo_medio: c.avgPrice, venduta_a: c.sellPrice, risultato: c.pnl, risultato_pct: c.pnlPct, valuta: c.currency, chiusa_il: c.closedAt })),
    segnali_in_attesa: signals.filter((a) => a.status === "pending").map(brief),
    segnali_decisi: signals.filter((a) => a.status !== "pending").slice(-15).map(brief),
    prezzi_mancanti: s.missing,
    nota: "Portafoglio vero dell'utente (compra e vende lui). Le quantità sono quelle che ha scritto lui. Scartato = l'utente ha deciso di non farlo.",
  };
}

// ---------- controllo automatico di stop loss e obiettivi (gratis, senza Claude) ----------

const SYSTEM_AGENT = { id: "controllo-portafoglio", name: "Controllo portafoglio", room: null, canTrade: false, watchlist: [], limits: {} };

/**
 * Ogni 15 minuti: se un'azione tocca lo stop loss o l'obiettivo, segnale di vendita in ✅ Approvazioni (una volta per
 * livello: se l'utente lo scarta, non si ripete finché il livello non cambia).
 */
export async function checkLevels() {
  if (safety.isStopped()) return [];
  const out = [];
  for (const p of data.positions) {
    if (!p.stopLoss && !p.target) continue;
    let q;
    try {
      q = await stockQuote(p.symbol);
    } catch {
      continue;
    }
    const hit = p.stopLoss && q.price <= p.stopLoss ? "stop" : p.target && q.price >= p.target ? "target" : null;
    if (!hit) continue;
    const level = hit === "stop" ? p.stopLoss : p.target;
    if (p.alerted?.[hit] === level) continue;
    if (pendingSignals().some((a) => a.signal.side === "sell" && a.signal.positionId === p.id)) continue;
    const why = hit === "stop"
      ? `Il prezzo (${q.price}) è sceso allo stop loss che avevi fissato (${level}). Vendere limita la perdita come previsto all'acquisto.`
      : `Il prezzo (${q.price}) ha raggiunto l'obiettivo (${level}). Puoi incassare tutto o una parte, oppure alzare l'obiettivo dal portafoglio.`;
    try {
      const r = await proposeSignal(SYSTEM_AGENT, { side: "sell", symbol: p.symbol, position_id: p.id, reason: why, sell_pct: 100 });
      p.alerted = { ...(p.alerted ?? {}), [hit]: level };
      save("alert");
      out.push(r);
    } catch (err) {
      log(SYSTEM_AGENT.id, "warn", `Controllo di ${p.symbol} non riuscito: ${err.message}`);
    }
  }
  return out;
}
