// Controlla il portafoglio: stop-loss, concentrazione e liquidità (simulato) oppure perdite per posizione (cTrader).
// params: { stopLossPct: -8, maxConcentrationPct: 25, minCashPct: 10, autoStop: false }
// Sui conti cTrader la perdita massima del giorno e lo STOP sono gestiti anche da Broker → Sicurezza.
export default async function ({ agent, params, notes, portfolio, order, trading }) {
  const { stopLossPct = -8, maxConcentrationPct = 25, minCashPct = 10, autoStop = false } = params;
  const pf = await portfolio();
  const alerts = [];

  if (trading?.mode === "ctrader") {
    const balance = pf.account.balance;
    const pnl = pf.positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
    for (const p of pf.positions) {
      const lossPct = balance > 0 ? ((p.pnl ?? 0) / balance) * 100 : 0;
      if (lossPct <= stopLossPct / 4) alerts.push(`${p.symbol} (${p.label || "manuale"}): P&L ${p.pnl} ${pf.account.currency} (${lossPct.toFixed(2)}% del saldo)`);
      if (!p.stopLoss) alerts.push(`${p.symbol}: posizione senza stop loss`);
    }
    notes.post(
      alerts.length
        ? `⚠️ ${alerts.join("\n")}`
        : `Rischio OK — ${pf.where}: saldo ${balance.toFixed(2)} ${pf.account.currency}, P&L aperto ${pnl.toFixed(2)}, ${pf.positions.length} posizioni`,
      alerts.length ? ["RISCHIO"] : ["OK"],
    );
    return alerts.join(" | ") || "nessun allarme";
  }

  for (const p of pf.positions) {
    const weight = (p.value / pf.total) * 100;
    if (p.pnlPct <= stopLossPct) {
      alerts.push(`${p.symbol}: perdita ${p.pnlPct.toFixed(1)}% oltre lo stop (${stopLossPct}%)`);
      if (autoStop && agent.canTrade) await order({ symbol: p.symbol, side: "sell", qty: p.qty, reason: "stop-loss" });
    }
    if (weight > maxConcentrationPct) alerts.push(`${p.symbol}: peso ${weight.toFixed(1)}% oltre ${maxConcentrationPct}%`);
  }
  const cashPct = (pf.cash / pf.total) * 100;
  if (cashPct < minCashPct) alerts.push(`Liquidità al ${cashPct.toFixed(1)}%, sotto il minimo ${minCashPct}%`);
  notes.post(
    alerts.length ? `⚠️ ${alerts.join("\n")}` : `Rischio OK — valore ${pf.total.toFixed(0)}, P&L ${pf.pnlPct.toFixed(2)}%, cash ${cashPct.toFixed(0)}%`,
    alerts.length ? ["RISCHIO"] : ["OK"],
  );
  return alerts.join(" | ") || "nessun allarme";
}
