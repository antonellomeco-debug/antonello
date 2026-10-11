// Broker virtuale (paper trading): nessun ordine reale viene mai inviato.
// Applica i limiti di rischio definiti nella configurazione di ogni agente.
import { getQuote } from "./market.js";
import { getState, persist, bus, addApproval, updateApproval } from "./store.js";

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

/**
 * @param {object} agent configurazione dell'agente (usa agent.limits)
 * @param {{symbol:string, side:"buy"|"sell", qty:number, reason?:string}} order
 */
export async function placeOrder(agent, order) {
  if (!agent.canTrade) throw new Error(`L'agente ${agent.name} non è autorizzato a fare trading`);
  const symbol = String(order.symbol).toUpperCase();
  const qty = Math.floor(Number(order.qty));
  if (!(qty > 0)) throw new Error("Quantità non valida");
  if (order.side !== "buy" && order.side !== "sell") throw new Error("side deve essere buy o sell");

  const limits = agent.limits ?? {};
  const allowed = agent.watchlist?.map((s) => s.toUpperCase());
  if (limits.onlyWatchlist !== false && allowed?.length && !allowed.includes(symbol)) {
    throw new Error(`${symbol} non è nella watchlist dell'agente`);
  }

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
    price: q.price, notional, reason: order.reason ?? "", source: q.source,
  };
  portfolio.trades.push(trade);
  persist();
  bus.emit("event", { type: "trade", trade });
  return trade;
}

/**
 * Punto d'ingresso per gli agenti: se l'agente richiede approvazione (default),
 * l'ordine finisce in "Approvazioni" e parte solo quando premi "Fallo per me".
 */
export async function submitOrder(agent, order) {
  if (!agent.canTrade) throw new Error(`L'agente ${agent.name} non è autorizzato a fare trading`);
  if (agent.limits?.requireApproval === false) return placeOrder(agent, order);
  const clean = {
    symbol: String(order.symbol).toUpperCase(), side: order.side,
    qty: Math.floor(Number(order.qty)), reason: order.reason ?? "",
  };
  const a = addApproval(agent, clean);
  return { status: "pending_approval", approvalId: a.id, message: "Ordine proposto: in attesa dell'approvazione dell'utente" };
}

export async function decide(id, approve) {
  const a = getState().approvals.find((x) => x.id === id);
  if (!a) throw new Error("Proposta non trovata");
  if (a.status !== "pending") throw new Error("Proposta già decisa");
  if (!approve) return updateApproval(id, { status: "rejected" });
  a.status = "executing"; // evita doppie esecuzioni con due clic ravvicinati
  try {
    const trade = await placeOrder(a.agent, a.order);
    return updateApproval(id, { status: "executed", trade });
  } catch (err) {
    return updateApproval(id, { status: "failed", error: err.message });
  }
}
