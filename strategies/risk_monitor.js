// Controlla il portafoglio: stop-loss, concentrazione e liquidità. Può chiudere le posizioni in perdita.
// params: { stopLossPct: -8, maxConcentrationPct: 25, minCashPct: 10, autoStop: false }
export default async function ({ agent, params, notes, portfolio, order }) {
  const { stopLossPct = -8, maxConcentrationPct = 25, minCashPct = 10, autoStop = false } = params;
  const pf = await portfolio();
  const alerts = [];
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
