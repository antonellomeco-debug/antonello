// Segnala titoli in ipervenduto/ipercomprato secondo l'RSI. Solo segnali, nessun ordine.
// params: { period: 14, low: 30, high: 70 }
export default async function ({ agent, params, market, notes }) {
  const { period = 14, low = 30, high = 70 } = params;
  const signals = [];
  for (const symbol of agent.watchlist) {
    const { candles } = await market.getHistory(symbol);
    const value = market.indicators.rsi(candles.map((c) => c.close), period);
    if (value == null) continue;
    if (value < low) signals.push(`${symbol}: RSI ${value.toFixed(1)} → ipervenduto (possibile rimbalzo)`);
    else if (value > high) signals.push(`${symbol}: RSI ${value.toFixed(1)} → ipercomprato (attenzione)`);
  }
  notes.post(signals.length ? signals.join("\n") : `Nessun segnale RSI (${low}/${high}) sulla watchlist.`, ["RSI"]);
  return signals.join(" | ") || "nessun segnale";
}
