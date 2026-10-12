// MODELLO per scrivere una strategia personale.
// 1. Copia questo file, es. strategies/mia_strategia.js
// 2. In un agente con "mode": "rule" imposta "strategy": "mia_strategia" e i tuoi "params".
//
// ctx contiene:
//   agent      → la configurazione dell'agente (watchlist, limits, ...)
//   params     → i parametri impostati nella configurazione
//   market     → getQuote(sym), getHistory(sym) → { candles:[{date,open,high,low,close,volume}] },
//                indicators.{ sma, rsi, volatility, returnPct, summary }
//   notes      → read(roomId?, limit?), post(testo, tags?)
//   trading    → dove opera il piano: { mode: "paper" } oppure { mode: "ctrader", accountId, isLive, label }
//   portfolio  → async () => simulato: { cash, total, pnlPct, positions:[...] }
//                             cTrader:  { account:{balance,currency}, positions:[...], myPositions:[positionId] }
//   order      → async (ordine) — rispetta limiti, approvazioni e Sicurezza:
//                simulato: { symbol, side:"buy"|"sell", qty, reason }
//                cTrader:  { symbol, side, lots, stop_loss_pct, take_profit_pct, reason }
//                          oppure { action:"close", positionId, lots?, reason }
//   log        → log(messaggio)
export default async function ({ agent, params, market, notes, portfolio, order, log }) {
  for (const symbol of agent.watchlist) {
    const q = await market.getQuote(symbol);
    log(`${symbol}: ${q.price} (${q.changePct == null ? "variazione n/d" : `${q.changePct.toFixed(2)}%`})`);
  }
  notes.post("Esempio completato");
  return "ok";
}
