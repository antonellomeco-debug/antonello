// Ordini degli agenti. Ogni piano decide dove operano i suoi agenti:
// - "paper": portafoglio simulato dell'app (nessun ordine esce dal computer);
// - "ctrader": un conto cTrader (demo o reale), con i controlli di sicurezza di lib/safety.js.
import { getQuote } from "./market.js";
import { getState, persist, persistNow, bus, addApproval, updateApproval, log } from "./store.js";
import { office } from "./office.js";
import { floorOfRoom, floorTrading } from "./building.js";
import * as ctrader from "./ctrader/service.js";
import * as safety from "./safety.js";

// ---------- dove opera un agente ----------

/** { mode: "paper" } oppure { mode: "ctrader", accountId, isLive, label } per il piano dell'agente. */
export function tradingTarget(agent) {
  const b = office.building();
  return targetFor(floorTrading(b, floorOfRoom(b, agent.room)));
}

function targetFor(t) {
  if (t.mode !== "ctrader") return { mode: "paper", label: "portafoglio simulato" };
  const acc = ctrader.account(t.accountId);
  return {
    mode: "ctrader",
    accountId: t.accountId,
    isLive: Boolean(acc?.isLive),
    label: acc ? `cTrader ${acc.broker} ${acc.traderLogin ?? t.accountId} (${acc.isLive ? "REALE" : "demo"})` : `cTrader ${t.accountId} (conto non trovato)`,
  };
}

const sameTarget = (a, b) =>
  a.mode === b.mode && String(a.accountId ?? "") === String(b.accountId ?? "") && Boolean(a.isLive) === Boolean(b.isLive);
const agentLabel = (agent) => `agenti:${agent.id}`;
const normSym = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9^.=-]/g, "");

// ---------- portafoglio simulato ----------

export async function portfolioValue() {
  const { portfolio } = getState();
  let invested = 0;
  const positions = [];
  for (const [symbol, pos] of Object.entries(portfolio.positions)) {
    const q = await getQuote(symbol);
    const value = pos.qty * q.price;
    invested += value;
    positions.push({
      symbol, qty: pos.qty, avgPrice: pos.avgPrice, price: q.price, value,
      pnlPct: ((q.price - pos.avgPrice) / pos.avgPrice) * 100, source: q.source,
    });
  }
  const total = portfolio.cash + invested;
  return {
    cash: portfolio.cash, invested, total,
    pnlPct: ((total - portfolio.initialCash) / portfolio.initialCash) * 100,
    positions, trades: portfolio.trades.slice(-50),
  };
}

function checkWatchlist(agent, symbol) {
  const allowed = (agent.watchlist ?? []).map(normSym);
  if (agent.limits?.onlyWatchlist !== false && allowed.length && !allowed.includes(normSym(symbol))) {
    throw new Error(`${symbol} non è nella watchlist dell'agente`);
  }
}

async function placePaperOrder(agent, order) {
  const symbol = String(order.symbol).toUpperCase();
  const qty = Math.floor(Number(order.qty));
  if (!(qty > 0)) throw new Error("Quantità non valida: sul portafoglio simulato indica qty (numero di pezzi).");
  if (order.side !== "buy" && order.side !== "sell") throw new Error("side deve essere buy o sell");
  checkWatchlist(agent, symbol);

  const limits = agent.limits ?? {};
  const { portfolio } = getState();
  const q = await getQuote(symbol);
  const notional = qty * q.price;
  const pv = await portfolioValue();

  if (order.side === "buy") {
    if (notional > portfolio.cash) throw new Error("Liquidità insufficiente");
    const maxOrder = (limits.maxOrderPct ?? 10) / 100 * pv.total;
    if (notional > maxOrder) throw new Error(`Ordine oltre il limite (${limits.maxOrderPct ?? 10}% del portafoglio)`);
    const current = portfolio.positions[symbol]?.qty ?? 0;
    const maxPos = (limits.maxPositionPct ?? 20) / 100 * pv.total;
    if ((current + qty) * q.price > maxPos) throw new Error(`Posizione oltre il limite (${limits.maxPositionPct ?? 20}%)`);
    const pos = (portfolio.positions[symbol] ??= { qty: 0, avgPrice: 0 });
    pos.avgPrice = (pos.avgPrice * pos.qty + notional) / (pos.qty + qty);
    pos.qty += qty;
    portfolio.cash -= notional;
  } else {
    const pos = portfolio.positions[symbol];
    if (!pos || pos.qty < qty) throw new Error(`Posizione insufficiente su ${symbol}`);
    pos.qty -= qty;
    portfolio.cash += notional;
    if (pos.qty === 0) delete portfolio.positions[symbol];
  }

  const trade = {
    at: new Date().toISOString(), agentId: agent.id, symbol, side: order.side, qty,
    price: q.price, notional, reason: order.reason ?? "", source: q.source, target: "paper",
  };
  portfolio.trades.push(trade);
  persist();
  bus.emit("event", { type: "trade", trade });
  return trade;
}

// ---------- conto cTrader ----------

function recordBrokerTrade(entry) {
  const st = getState();
  st.brokerTrades = [...(st.brokerTrades ?? []), { at: new Date().toISOString(), ...entry }].slice(-300);
  persist();
  bus.emit("event", { type: "trade", trade: entry });
}

// Un ordine alla volta per conto: i limiti (posizioni aperte, ordini del giorno) si controllano e si
// aggiornano senza che un altro ordine dello stesso conto passi in mezzo.
const accountLocks = new Map(); // id conto -> coda (promise)
function withAccountLock(id, fn) {
  const key = String(id);
  const run = (accountLocks.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  accountLocks.set(key, tail);
  tail.then(() => accountLocks.get(key) === tail && accountLocks.delete(key));
  return run;
}

/** Aspetta che finiscano gli ordini già in corso (es. prima di chiudere tutto con lo STOP). */
export async function settleInFlight() {
  await Promise.all([...accountLocks.values()]);
}

// Programma in chiusura (nuova versione sul server, riavvio): nessun nuovo ordine parte più,
// quelli già inviati al broker si aspettano con settleInFlight().
let closing = false;
export function stopNewOrders() {
  closing = true;
}
const assertNotClosing = () => {
  if (closing) throw new Error("Il programma si sta chiudendo: ordine non inviato, riprova tra un minuto.");
};

/** Distanza di stop loss / take profit in %: valori mancanti, negativi o assurdi non sono accettati. */
function pctOrZero(value, what) {
  if (value == null || value === "") return 0;
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${what} non valido: indica una distanza in % positiva (es. 1.5).`);
  if (v > 50) throw new Error(`${what} troppo lontano (${v}%): massimo 50%.`);
  return v;
}

/** Controlli dell'ordine che non cambiano nulla: servono anche prima di proporre l'ordine all'utente. */
async function checkBrokerOrder(agent, order, target, positions) {
  const id = target.accountId;
  if (!ctrader.account(id)) throw new Error("Il conto cTrader di questo piano non è più disponibile: controlla la sezione Broker.");
  if (ctrader.status().scope === "SCOPE_VIEW") throw new Error("Con cTrader hai concesso solo la lettura: in Broker premi «Ricollega» e consenti il trading.");

  if (order.action === "close") {
    const p = positions.find((x) => String(x.positionId) === String(order.positionId));
    if (!p) throw new Error("Posizione non trovata (forse è già stata chiusa). Usa get_portfolio per vedere le tue posizioni.");
    if (p.label !== agentLabel(agent)) throw new Error("Un agente può chiudere solo le posizioni che ha aperto lui.");
    if (order.lots != null && !(Number(order.lots) > 0)) throw new Error("lots non valido per la chiusura parziale.");
    return { position: p };
  }

  const lots = Number(order.lots);
  if (!(lots > 0)) throw new Error("Su un conto cTrader indica la quantità in lotti (lots), es. 0.01 (non qty).");
  if (order.side !== "buy" && order.side !== "sell") throw new Error("side deve essere buy o sell");
  checkWatchlist(agent, order.symbol);
  const limits = safety.getSafety().limits;
  if (lots > limits.maxLotsPerOrder) throw new Error(`Ordine troppo grande: ${lots} lotti, il limite è ${limits.maxLotsPerOrder} (Broker → Sicurezza).`);
  let stopLossPct = pctOrZero(order.stop_loss_pct ?? order.stopLossPct, "Stop loss");
  const takeProfitPct = pctOrZero(order.take_profit_pct ?? order.takeProfitPct, "Take profit");
  if (!stopLossPct && limits.requireStopLoss) stopLossPct = limits.defaultStopLossPct;
  const symbol = await ctrader.validateOrder(id, order.symbol, lots);
  return { lots, symbol, stopLossPct, takeProfitPct };
}

/** Controlli del conto per una nuova posizione: tipo di conto e regole di Broker → Sicurezza. */
async function checkAccountForOpen(target, lots, positions) {
  // Conti "netting": una sola posizione per strumento, gli ordini degli agenti si mescolerebbero con le tue.
  const info = await ctrader.accountInfo(target.accountId);
  if (info.accountType && info.accountType !== "HEDGED") {
    throw new Error(`Questo conto cTrader è di tipo ${info.accountType}: gli agenti possono operare solo su conti HEDGED (più posizioni per strumento).`);
  }
  safety.assertBrokerOrder({
    accountId: target.accountId,
    isLive: target.isLive,
    lots,
    openAgentPositions: positions.filter((p) => p.label.startsWith("agenti")).length,
  });
}

async function placeBrokerOrder(agent, order, target, { expectedTarget } = {}) {
  const id = target.accountId;
  // Ricontrollato appena prima di inviare l'ordine al broker (anche dopo eventuali attese).
  const guard = () => {
    assertNotClosing();
    safety.assertNotStopped();
    if (target.isLive && !safety.getSafety().liveEnabled) throw new Error("Il conto REALE è stato bloccato: ordine non inviato.");
    if (!sameTarget(tradingTarget(agent), expectedTarget ?? target)) throw new Error("Il piano ora usa un conto diverso: ordine non inviato.");
  };

  return withAccountLock(id, async () => {
    guard();
    const positions = await ctrader.positions(id);
    const checked = await checkBrokerOrder(agent, order, target, positions);

    if (order.action === "close") {
      const p = checked.position;
      guard();
      const r = await ctrader.closePosition(id, p.positionId, order.lots ? Number(order.lots) : undefined);
      recordBrokerTrade({ agentId: agent.id, accountId: id, isLive: target.isLive, action: "close", symbol: p.symbol, side: p.side === "buy" ? "sell" : "buy", lots: r.lots, price: r.price, positionId: p.positionId, status: r.status, reason: order.reason ?? "" });
      log(agent.id, "info", `Chiusa posizione ${p.symbol} (${r.lots} lotti) su ${target.label}`);
      return r;
    }

    await checkAccountForOpen(target, checked.lots, positions);

    const base = { agentId: agent.id, accountId: id, isLive: target.isLive, action: "open", symbol: checked.symbol, side: order.side, lots: checked.lots, reason: order.reason ?? "" };
    let r;
    try {
      r = await ctrader.placeOrder(id, {
        symbol: order.symbol,
        side: order.side,
        lots: checked.lots,
        stopLossPct: checked.stopLossPct,
        takeProfitPct: checked.takeProfitPct,
        label: agentLabel(agent),
        comment: String(order.reason ?? "").slice(0, 200),
        guard,
      });
    } catch (err) {
      if (err.uncertain) {
        // Potrebbe essere stato eseguito: si conta comunque, per non superare i limiti.
        safety.recordBrokerOrder(id);
        recordBrokerTrade({ ...base, status: "incerto" });
        log(agent.id, "warn", `Ordine ${checked.symbol} con esito incerto su ${target.label}: controlla le posizioni`);
      }
      throw err;
    }
    safety.recordBrokerOrder(id);
    recordBrokerTrade({ ...base, symbol: r.symbol, lots: r.lots, price: r.price, positionId: r.positionId, stopLoss: r.stopLoss, takeProfit: r.takeProfit, status: r.status });
    log(agent.id, "info", `${order.side === "buy" ? "Comprato" : "Venduto"} ${r.lots} lotti ${r.symbol} a ${r.price} su ${target.label}${r.status === "accepted" ? " (esecuzione non ancora confermata)" : ""}`);
    return r;
  });
}

// ---------- punto d'ingresso degli agenti ----------

/**
 * Esegue un ordine. expectedTarget (da un'approvazione) deve coincidere con il conto attuale del piano:
 * se nel frattempo il piano è stato collegato a un altro conto, l'ordine non parte.
 */
export async function placeOrder(agent, order, { expectedTarget } = {}) {
  if (!agent.canTrade) throw new Error(`L'agente ${agent.name} non è autorizzato a fare trading`);
  assertNotClosing();
  safety.assertNotStopped();
  const target = tradingTarget(agent);
  if (expectedTarget && !sameTarget(target, expectedTarget)) {
    throw new Error("Il piano ora usa un conto diverso da quando l'ordine è stato proposto: l'agente deve riproporlo.");
  }
  return target.mode === "ctrader" ? placeBrokerOrder(agent, order, target, { expectedTarget }) : placePaperOrder(agent, order);
}

/**
 * Punto d'ingresso per gli agenti: se l'agente richiede approvazione (default) o il piano opera su un conto reale,
 * l'ordine finisce in "Approvazioni" e parte solo quando premi "Fallo per me".
 */
export async function submitOrder(agent, order) {
  if (!agent.canTrade) throw new Error(`L'agente ${agent.name} non è autorizzato a fare trading`);
  safety.assertNotStopped();
  const target = tradingTarget(agent);
  if (target.mode === "ctrader" && target.isLive && !safety.getSafety().liveEnabled) {
    throw new Error("Il conto REALE di questo piano è bloccato: si sblocca solo da Broker → Sicurezza.");
  }
  // Senza approvazione solo sul portafoglio simulato e sui conti demo: sul conto REALE ogni ordine passa sempre
  // da ✅ Approvazioni, anche se all'agente è stata tolta l'approvazione.
  const live = target.mode === "ctrader" && target.isLive;
  if (agent.limits?.requireApproval === false && !live) return placeOrder(agent, order);
  const clean = {
    action: order.action === "close" ? "close" : "open",
    symbol: String(order.symbol ?? "").toUpperCase(),
    side: order.side,
    qty: order.qty != null ? Math.floor(Number(order.qty)) : undefined,
    lots: order.lots != null ? Number(order.lots) : undefined,
    stop_loss_pct: order.stop_loss_pct != null ? Number(order.stop_loss_pct) : undefined,
    take_profit_pct: order.take_profit_pct != null ? Number(order.take_profit_pct) : undefined,
    positionId: order.positionId ?? order.position_id,
    reason: order.reason ?? "",
  };
  // Gli errori evidenti si segnalano subito all'agente, invece di proporre all'utente un ordine che non può partire.
  if (target.mode === "ctrader") {
    const positions = await ctrader.positions(target.accountId);
    const checked = await checkBrokerOrder(agent, clean, target, positions);
    if (checked.position) {
      const p = checked.position; // per mostrare all'utente quale posizione verrà chiusa
      Object.assign(clean, { symbol: p.symbol, side: p.side, positionLots: p.lots, pnl: p.pnl });
    } else {
      await checkAccountForOpen(target, checked.lots, positions);
      Object.assign(clean, { symbol: checked.symbol, stop_loss_pct: checked.stopLossPct || undefined });
    }
  } else {
    if (clean.action === "close") throw new Error("Sul portafoglio simulato usa place_order con side sell.");
    if (!(clean.qty > 0)) throw new Error("Quantità non valida: sul portafoglio simulato indica qty (numero di pezzi).");
    if (clean.side !== "buy" && clean.side !== "sell") throw new Error("side deve essere buy o sell");
    checkWatchlist(agent, clean.symbol);
  }
  const a = addApproval({ ...agent, target }, clean);
  return { status: "pending_approval", approvalId: a.id, target: target.label, message: "Ordine proposto: in attesa dell'approvazione dell'utente" };
}

export async function decide(id, approve) {
  const a = getState().approvals.find((x) => x.id === id);
  if (!a || a.kind === "post") throw new Error("Proposta non trovata");
  if (a.status !== "pending") throw new Error("Proposta già decisa");
  if (!approve) return updateApproval(id, { status: "rejected" });
  assertNotClosing();
  // Evita doppie esecuzioni con due clic ravvicinati. Si salva subito: se il programma si chiudesse proprio
  // adesso, alla riapertura l'ordine risulta "esito incerto" invece di tornare da approvare (e partire due volte).
  a.status = "executing";
  a.executingAt = new Date().toISOString();
  persistNow();
  try {
    const result = await placeOrder(a.agent, a.order, { expectedTarget: a.target ?? { mode: "paper" } });
    return updateApproval(id, { status: "executed", trade: result });
  } catch (err) {
    return updateApproval(id, { status: err.uncertain ? "uncertain" : "failed", error: err.message });
  }
}

/**
 * All'avvio: ordini rimasti "in esecuzione" perché il programma si è chiuso mentre partivano.
 * Non si sa se il broker li abbia eseguiti: diventano "esito incerto" (mai di nuovo da approvare).
 */
export function recoverInterruptedApprovals() {
  const stuck = getState().approvals.filter((a) => a.status === "executing" && a.kind !== "post"); // i post li controlla lib/social
  for (const a of stuck) {
    updateApproval(a.id, { status: "uncertain", error: "Il programma si è chiuso mentre l'ordine partiva: controlla le posizioni prima di riproporlo." });
    const what = `${a.order?.action === "close" ? "chiusura" : a.order?.side ?? "ordine"} ${a.order?.symbol ?? ""}`.trim();
    log("sicurezza", "warn", `Ordine approvato (${what} di ${a.agentName}) interrotto dalla chiusura del programma: esito incerto, controlla le posizioni.`);
  }
  return stuck.length;
}

/** Situazione di un conto cTrader per gli agenti. */
async function brokerAccount(target, agent) {
  const [info, positions] = await Promise.all([ctrader.accountInfo(target.accountId), ctrader.positions(target.accountId)]);
  return {
    where: target.label,
    account: info,
    positions,
    myPositions: agent ? positions.filter((p) => p.label === agentLabel(agent)).map((p) => p.positionId) : [],
  };
}

/**
 * Situazione del portafoglio per un agente: simulato oppure conto cTrader del suo piano.
 * Gli agenti che non operano (es. il CIO) vedono anche dove operano gli altri piani.
 */
export async function portfolioFor(agent) {
  const target = tradingTarget(agent);
  const own = target.mode === "ctrader" ? await brokerAccount(target, agent) : { where: target.label, ...(await portfolioValue()) };
  if (agent.canTrade) return own;
  const b = office.building();
  const keyOf = (t) => (t.mode === "ctrader" ? String(t.accountId) : "paper");
  const others = [];
  const seen = new Set([keyOf(target)]);
  for (const f of b.floors) {
    const t = floorTrading(b, f.id);
    if (seen.has(keyOf(t))) continue;
    seen.add(keyOf(t));
    const floors = b.floors.filter((x) => keyOf(floorTrading(b, x.id)) === keyOf(t)).map((x) => x.name);
    try {
      const ft = targetFor(t);
      others.push({ floors, ...(ft.mode === "ctrader" ? await brokerAccount(ft) : { where: ft.label, ...(await portfolioValue()) }) });
    } catch (err) {
      others.push({ floors, error: err.message });
    }
  }
  return others.length ? { ...own, otherFloors: others } : own;
}

// ---------- controllo periodico (perdita giornaliera) ----------

const monitorState = new Map(); // id conto -> { failing, lastMsg, lastLoggedAt }
const closeLog = new Map(); // id conto -> ultimo esito della chiusura automatica (per non ripeterlo nel registro)

/** Registra i problemi del controllo senza riempire il registro: alla prima volta, se cambiano, e ogni 30 minuti. */
function monitorProblem(id, message) {
  const m = monitorState.get(id) ?? {};
  const now = Date.now();
  if (!m.failing || m.lastMsg !== message || now - m.lastLoggedAt > 30 * 60_000) {
    log("sicurezza", "warn", String(id).startsWith("close:") ? message : `Controllo del conto ${id} non riuscito: ${message}`);
    m.lastLoggedAt = now;
  }
  monitorState.set(id, { ...m, failing: true, lastMsg: message });
}
function monitorOk(id) {
  if (monitorState.get(id)?.failing) log("sicurezza", "info", `Controllo del conto ${id} di nuovo attivo`);
  monitorState.set(id, { failing: false });
}

/** Depositi meno prelievi dall'inizio della giornata di controllo (non sono guadagni o perdite). */
async function netCashFlow(id, info) {
  const d = safety.dailyAccount(id);
  if (d.startEquity == null || !d.startAt) return 0;
  const flows = await ctrader.cashFlows(id, d.startAt - 60_000);
  const useVersions = d.startBalanceVersion != null && info.balanceVersion != null;
  return flows
    .filter((f) =>
      useVersions && f.balanceVersion != null
        ? f.balanceVersion > d.startBalanceVersion && f.balanceVersion <= info.balanceVersion
        : f.at > d.startAt,
    )
    .reduce((s, f) => s + f.amount, 0);
}

/** Chiude le posizioni degli agenti su un conto e riassume l'esito. */
export async function closeAllAgentPositions(id) {
  const results = await ctrader.closeAgentPositions(id);
  return {
    closed: results.filter((r) => r.status === "closed"),
    unconfirmed: results.filter((r) => r.status === "accepted"),
    failed: results.filter((r) => r.error),
  };
}

/** Chiude le posizioni aperte dagli agenti su tutti i conti cTrader collegati (STOP e chiusura del venerdì). */
export async function closeAgentPositionsEverywhere() {
  const report = { closed: 0, unconfirmed: 0, failed: [] };
  for (const id of ctrader.status().accounts.map((a) => String(a.ctidTraderAccountId))) {
    try {
      const r = await closeAllAgentPositions(id);
      report.closed += r.closed.length;
      report.unconfirmed += r.unconfirmed.length;
      report.failed.push(...r.failed.map((f) => ({ accountId: id, symbol: f.symbol, error: f.error })));
    } catch (e) {
      report.failed.push({ accountId: id, symbol: "tutte le posizioni del conto", error: e.message });
    }
  }
  return report;
}

/** Per ogni conto usato da un piano: valore attuale, perdita del giorno, STOP automatico se serve. */
export async function monitorAccounts() {
  if (!ctrader.isReady()) return [];
  const ids = [...new Set(office.building().floors.filter((f) => f.trading?.mode === "ctrader").map((f) => String(f.trading.accountId)))];
  const out = [];
  for (const id of ids) {
    if (!ctrader.account(id)) continue;
    try {
      // Senza il P&L delle posizioni il valore del conto sarebbe sbagliato: in quel caso si salta il controllo.
      const at = Date.now();
      const [info, positions] = await Promise.all([ctrader.accountInfo(id), ctrader.positions(id, { requirePnl: true })]);
      const equity = info.balance + positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
      const check = safety.checkDailyLoss(id, equity, { netFlow: await netCashFlow(id, info), at, balanceVersion: info.balanceVersion });
      out.push({ accountId: id, equity, ...check });
      monitorOk(id);
      // Con "chiudi anche le posizioni" si riprova a ogni controllo finché restano posizioni degli agenti
      // (es. mercato chiuso al primo tentativo): sul conto bloccato non se ne possono aprire di nuove.
      if (check.breached && safety.getSafety().limits.closeOnStop && (check.fresh || positions.some((p) => p.label.startsWith("agenti")))) {
        try {
          await settleInFlight();
          const r = await closeAllAgentPositions(id);
          const text = `STOP automatico sul conto ${id}: chiuse ${r.closed.length} posizioni degli agenti` +
            (r.unconfirmed.length ? `, ${r.unconfirmed.length} in attesa di conferma` : "") +
            (r.failed.length ? `, NON chiuse: ${r.failed.map((f) => `${f.symbol} (${f.error})`).join(", ")} (riprovo al prossimo controllo)` : "");
          if (check.fresh || r.closed.length || closeLog.get(id) !== text) log("sicurezza", "error", text);
          closeLog.set(id, text);
        } catch (err) {
          monitorProblem(`close:${id}`, `posizioni degli agenti NON chiuse sul conto ${id}: ${err.message}`);
        }
      }
    } catch (err) {
      monitorProblem(id, err.message);
    }
  }
  return out;
}
