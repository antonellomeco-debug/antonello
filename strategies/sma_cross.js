// Incrocio di medie mobili: compra quando la media veloce supera la lenta, vende nel caso opposto.
// params: { fast: 20, slow: 50, orderPct: 5 }   (orderPct = % del portafoglio per ordine)
export default async function ({ agent, params, market, notes, portfolio, order, log }) {
  const { fast = 20, slow = 50, orderPct = 5 } = params;
  const { sma } = market.indicators;
  const pf = await portfolio();
  const lines = [];

  for (const symbol of agent.watchlist) {
    const { candles, source } = await market.getHistory(symbol);
    const closes = candles.map((c) => c.close);
    const f = sma(closes, fast), s = sma(closes, slow);
    const prevF = sma(closes.slice(0, -1), fast), prevS = sma(closes.slice(0, -1), slow);
    if (f == null || s == null) continue;
    const held = pf.positions.find((p) => p.symbol === symbol.toUpperCase());
    const price = closes.at(-1);
    let action = "attendi";

    if (prevF <= prevS && f > s && !held) action = "BUY";
    else if (prevF >= prevS && f < s && held) action = "SELL";

    if (agent.canTrade && action === "BUY") {
      const qty = Math.floor((pf.total * orderPct) / 100 / price);
      if (qty > 0) await order({ symbol, side: "buy", qty, reason: `SMA${fast} incrocia sopra SMA${slow}` }).catch((e) => log(e.message));
    } else if (agent.canTrade && action === "SELL") {
      await order({ symbol, side: "sell", qty: held.qty, reason: `SMA${fast} incrocia sotto SMA${slow}` }).catch((e) => log(e.message));
    }
    lines.push(`${symbol}${source === "demo" ? " (demo)" : ""}: SMA${fast}=${f.toFixed(2)} SMA${slow}=${s.toFixed(2)} → ${action}`);
  }
  if (lines.length) notes.post(lines.join("\n"), ["SMA"]);
  return lines.join(" | ");
}
