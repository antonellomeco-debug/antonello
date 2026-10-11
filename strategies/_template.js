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
//   portfolio  → async () => { cash, total, pnlPct, positions:[...], trades:[...] }
//   order      → async ({ symbol, side:"buy"|"sell", qty, reason }) — SOLO simulato, rispetta i limiti
//   log        → log(messaggio)
export default async function ({ agent, params, market, notes, portfolio, order, log }) {
  for (const symbol of agent.watchlist) {
    const q = await market.getQuote(symbol);
    log(`${symbol}: ${q.price.toFixed(2)} (${q.changePct.toFixed(2)}%)`);
  }
  notes.post("Esempio completato");
  return "ok";
}
