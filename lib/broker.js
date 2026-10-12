// Ordini degli agenti. Ogni piano decide dove operano i suoi agenti:
// - "paper": portafoglio simulato dell'app (nessun ordine esce dal computer);
// - "ctrader": un conto cTrader (demo o reale), con i controlli di sicurezza di lib/safety.js.
import { getQuote } from "./market.js";
import { getState, persist, bus, addApproval, updateApproval, log } from "./store.js";
import { office } from "./office.js";
import { floorOfRoom, floorTrading } from "./building.js";
import * as ctrader from "./ctrader/service.js";
import * as safety from "./safety.js";

// ---------- dove opera un agente ----------

/** { mode: "paper" } oppure { mode: "ctrader", accountId, isLive, label } per il piano dell'agente. */
export function tradingTarget(agent) {
  const b = office.building();
  const t = floorTrading(b, floorOfRoom(b, agent.room));
  if (t.mode !== "ctrader") return { mode: "paper", label: "portafoglio simulato" };
  const acc = ctrader.account(t.accountId);
  return {
    mode: "ctrader",
    accountId: t.accountId,
    isLive: Boolean(acc?.isLive),
    label: acc ? `cTrader ${acc.broker} ${acc.traderLogin ?? t.accountId} (${acc.isLive ? "REALE" : "demo"})` : `cTrader ${t.accountId} (conto non trovato)`,
  };
}

const sameTarget = (a, b) => a.mode === b.mode && String(a.accountId ?? "") === String(b.accountId ?? "");
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

async function placeBrokerOrder(agent, order, target) {
  const id = target.accountId;
  if (!ctrader.account(id)) throw new Error("Il conto cTrader di questo piano non è più disponibile: controlla la sezione Broker.");
  if (ctrader.status().scope === "SCOPE_VIEW") throw new Error("Con cTrader hai concesso solo la lettura: in Broker premi «Ricollega» e consenti il trading.");
  const positions = await ctrader.positions(id);

  if (order.action === "close") {
    const p = positions.find((x) => String(x.positionId) === String(order.positionId));
    if (!p) throw new Error("Posizione non trovata (forse è già stata chiusa).");
    if (p.label !== agentLabel(agent)) throw new Error("Un agente può chiudere solo le posizioni che ha aperto lui.");
    safety.assertNotStopped();
    const r = await ctrader.closePosition(id, p.positionId, order.lots);
    recordBrokerTrade({ agentId: agent.id, accountId: id, isLive: target.isLive, action: "close", symbol: p.symbol, side: p.side === "buy" ? "sell" : "buy", lots: r.lots, price: r.price, positionId: p.positionId, reason: order.reason ?? "" });
    log(agent.id, "info", `Chiusa posizione ${p.symbol} (${r.lots} lotti) su ${target.label}`);
    return r;
  }

  const lots = Number(order.lots);
  if (!(lots > 0)) throw new Error("Su un conto cTrader indica la quantità in lotti (lots), es. 0.01.");
  if (order.side !== "buy" && order.side !== "sell") throw new Error("side deve essere buy o sell");
  checkWatchlist(agent, order.symbol);
  safety.assertBrokerOrder({
    accountId: id,
    isLive: target.isLive,
    lots,
    openAgentPositions: positions.filter((p) => p.label.startsWith("agenti")).length,
  });
  const limits = safety.getSafety().limits;
  let stopLossPct = Number(order.stop_loss_pct ?? order.stopLossPct) || 0;
  if (!stopLossPct && target.isLive && limits.requireStopLossLive) stopLossPct = limits.defaultStopLossPct;
  const takeProfitPct = Number(order.take_profit_pct ?? order.takeProfitPct) || 0;

  const r = await ctrader.placeOrder(id, {
    symbol: order.symbol,
    side: order.side,
    lots,
    stopLossPct,
    takeProfitPct,
    label: agentLabel(agent),
    comment: String(order.reason ?? "").slice(0, 200),
  });
  safety.recordBrokerOrder(id);
  recordBrokerTrade({ agentId: agent.id, accountId: id, isLive: target.isLive, action: "open", symbol: r.symbol, side: order.side, lots: r.lots, price: r.price, positionId: r.positionId, stopLoss: r.stopLoss, takeProfit: r.takeProfit, reason: order.reason ?? "" });
  log(agent.id, "info", `${order.side === "buy" ? "Comprato" : "Venduto"} ${r.lots} lotti ${r.symbol} a ${r.price} su ${target.label}`);
  return r;
}

// ---------- punto d'ingresso degli agenti ----------

/**
 * Esegue un ordine. expectedTarget (da un'approvazione) deve coincidere con il conto attuale del piano:
 * se nel frattempo il piano è stato collegato a un altro conto, l'ordine non parte.
 */
export async function placeOrder(agent, order, { expectedTarget } = {}) {
  if (!agent.canTrade) throw new Error(`L'agente ${agent.name} non è autorizzato a fare trading`);
  safety.assertNotStopped();
  const target = tradingTarget(agent);
  if (expectedTarget && !sameTarget(target, expectedTarget)) {
    throw new Error("Il piano ora usa un conto diverso da quando l'ordine è stato proposto: l'agente deve riproporlo.");
  }
  return target.mode === "ctrader" ? placeBrokerOrder(agent, order, target) : placePaperOrder(agent, order);
}

/**
 * Punto d'ingresso per gli agenti: se l'agente richiede approvazione (default),
 * l'ordine finisce in "Approvazioni" e parte solo quando premi "Fallo per me".
 */
export async function submitOrder(agent, order) {
  if (!agent.canTrade) throw new Error(`L'agente ${agent.name} non è autorizzato a fare trading`);
  safety.assertNotStopped();
  const target = tradingTarget(agent);
  if (target.mode === "ctrader" && target.isLive && !safety.getSafety().liveEnabled) {
    throw new Error("Il conto REALE di questo piano è bloccato: si sblocca solo da Broker → Sicurezza.");
  }
  if (agent.limits?.requireApproval === false) return placeOrder(agent, order);
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
  const a = addApproval({ ...agent, target }, clean);
  return { status: "pending_approval", approvalId: a.id, target: target.label, message: "Ordine proposto: in attesa dell'approvazione dell'utente" };
}

export async function decide(id, approve) {
  const a = getState().approvals.find((x) => x.id === id);
  if (!a) throw new Error("Proposta non trovata");
  if (a.status !== "pending") throw new Error("Proposta già decisa");
  if (!approve) return updateApproval(id, { status: "rejected" });
  a.status = "executing"; // evita doppie esecuzioni con due clic ravvicinati
  try {
    const result = await placeOrder(a.agent, a.order, { expectedTarget: a.target ?? { mode: "paper" } });
    return updateApproval(id, { status: "executed", trade: result });
  } catch (err) {
    return updateApproval(id, { status: "failed", error: err.message });
  }
}

/** Situazione del portafoglio per un agente: simulato oppure conto cTrader del suo piano. */
export async function portfolioFor(agent) {
  const target = tradingTarget(agent);
  if (target.mode !== "ctrader") return { where: target.label, ...(await portfolioValue()) };
  const [info, positions] = await Promise.all([ctrader.accountInfo(target.accountId), ctrader.positions(target.accountId)]);
  return {
    where: target.label,
    account: info,
    positions,
    myPositions: positions.filter((p) => p.label === agentLabel(agent)).map((p) => p.positionId),
  };
}

// ---------- controllo periodico (perdita giornaliera) ----------

/** Per ogni conto usato da un piano: valore attuale, perdita del giorno, STOP automatico se serve. */
export async function monitorAccounts() {
  if (!ctrader.isReady()) return [];
  const ids = [...new Set(office.building().floors.filter((f) => f.trading?.mode === "ctrader").map((f) => String(f.trading.accountId)))];
  const out = [];
  for (const id of ids) {
    if (!ctrader.account(id)) continue;
    try {
      const [info, positions] = await Promise.all([ctrader.accountInfo(id), ctrader.positions(id)]);
      const equity = info.balance + positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
      const check = safety.checkDailyLoss(id, equity);
      out.push({ accountId: id, equity, ...check });
      if (check.breached && safety.getSafety().limits.closeOnStop) {
        const closed = await ctrader.closeAgentPositions(id);
        log("sicurezza", "error", `STOP automatico: chiuse ${closed.length} posizioni degli agenti sul conto ${id}`);
      }
    } catch (err) {
      log("sicurezza", "warn", `Controllo del conto ${id} non riuscito: ${err.message}`);
    }
  }
  return out;
}
