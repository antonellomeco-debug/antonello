// Incrocio di medie mobili: compra quando la media veloce supera la lenta, vende/chiude nel caso opposto.
// params: { fast: 20, slow: 50, orderPct: 5, lots: 0.01, stopLossPct: 2 }
//   - portafoglio simulato: orderPct = % del portafoglio per ordine
//   - conto cTrader: lots per ordine e stopLossPct (distanza dello stop loss in %)
export default async function ({ agent, params, market, notes, portfolio, order, log, trading }) {
  const { fast = 20, slow = 50, orderPct = 5, lots = 0.01, stopLossPct = 2 } = params;
  const { sma } = market.indicators;
  const onBroker = trading?.mode === "ctrader";
  const pf = await portfolio();
  const lines = [];

  for (const symbol of agent.watchlist) {
    const { candles, source } = await market.getHistory(symbol);
    const closes = candles.map((c) => c.close);
    const f = sma(closes, fast), s = sma(closes, slow);
    const prevF = sma(closes.slice(0, -1), fast), prevS = sma(closes.slice(0, -1), slow);
    if (f == null || s == null) continue;
    const held = onBroker
      ? pf.positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase() && pf.myPositions.includes(p.positionId) && p.side === "buy")
      : pf.positions.find((p) => p.symbol === symbol.toUpperCase());
    const price = closes.at(-1);
    let action = "attendi";

    if (prevF <= prevS && f > s && !held) action = "BUY";
    else if (prevF >= prevS && f < s && held) action = "SELL";

    if (agent.canTrade && action === "BUY") {
      const reason = `SMA${fast} incrocia sopra SMA${slow}`;
      const o = onBroker
        ? { symbol, side: "buy", lots, stop_loss_pct: stopLossPct, reason }
        : { symbol, side: "buy", qty: Math.floor((pf.total * orderPct) / 100 / price), reason };
      if (onBroker || o.qty > 0) await order(o).catch((e) => log(e.message));
    } else if (agent.canTrade && action === "SELL") {
      const reason = `SMA${fast} incrocia sotto SMA${slow}`;
      const o = onBroker ? { action: "close", positionId: held.positionId, reason } : { symbol, side: "sell", qty: held.qty, reason };
      await order(o).catch((e) => log(e.message));
    }
    lines.push(`${symbol}${source === "demo" ? " (demo)" : ""}: SMA${fast}=${f.toFixed(5)} SMA${slow}=${s.toFixed(5)} → ${action}`);
  }
  if (lines.length) notes.post(lines.join("\n"), ["SMA"]);
  return lines.join(" | ");
}
