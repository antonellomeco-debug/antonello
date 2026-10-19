// Diario delle operazioni per l'agente «Allenatore»: operazioni chiuse sul conto cTrader (demo) e vendite del portafoglio
// vero, con il risultato per agente, e l'esito dei segnali (proposti, approvati, scartati). Serve a capire chi guadagna,
// chi perde e quali abitudini costano, non a decidere cosa comprare.
import { tradeHistory } from "./broker.js";
import * as holdings from "./holdings.js";

const money = (x) => Math.round(x * 100) / 100;

export async function tradeJournal({ days = 30 } = {}) {
  const d = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const since = Date.now() - d * 86_400_000;
  const broker = await tradeHistory({ days: d }).catch((err) => ({ linked: false, error: err.message, trades: [], totals: null }));
  const trades = (broker.trades ?? []).map((t) => ({
    agente: t.agentId ?? "a mano", simbolo: t.symbol, lato: t.side, lotti: t.lots, entrata: t.entryPrice, uscita: t.closePrice,
    aperta: t.openedAt, chiusa: t.closedAt, durata_ore: t.openedAt ? Math.round((Date.parse(t.closedAt) - Date.parse(t.openedAt)) / 36e5 * 10) / 10 : null,
    netto: t.net, valuta: t.currency, conto: t.isLive ? "reale" : "demo", motivo_apertura: String(t.openReason ?? "").slice(0, 200), motivo_chiusura: String(t.closeReason ?? "").slice(0, 200),
    stop_loss: t.stopLoss ?? null, take_profit: t.takeProfit ?? null,
  })).slice(0, 120);
  const snap = await holdings.snapshot().catch(() => ({ closed: [] }));
  const sells = snap.closed.filter((c) => Date.parse(c.closedAt) > since).map((c) => ({
    simbolo: c.symbol, segnalata_da: c.agentName ?? "utente", quantita: c.qty, comprata_a: c.avgPrice, venduta_a: c.sellPrice,
    risultato: c.pnl, risultato_pct: c.pnlPct, valuta: c.currency, tenuta_giorni: c.openedAt ? Math.round((Date.parse(c.closedAt) - Date.parse(c.openedAt)) / 864e5) : null,
  }));
  const signals = holdings.signalLog().filter((s) => Date.parse(s.at) > since);
  const byAgent = {};
  for (const s of signals) {
    const a = (byAgent[s.agentName ?? "?"] ??= { proposti: 0, approvati: 0, scartati: 0, in_attesa: 0, acquisti: 0, vendite: 0, risultato_vendite: 0 });
    a.proposti++;
    a[s.status === "executed" ? "approvati" : s.status === "rejected" ? "scartati" : "in_attesa"]++;
    a[s.side === "buy" ? "acquisti" : "vendite"]++;
    if (s.pnl != null) a.risultato_vendite = money(a.risultato_vendite + s.pnl);
  }
  return {
    giorni: d,
    conto_ctrader: broker.linked === false ? "non collegato" : { riepilogo: broker.totals ?? null, operazioni: trades },
    portafoglio_vero: { vendite_chiuse: sells },
    segnali_per_agente: byAgent,
    nota: "Netti dopo swap e commissioni. Un risultato su pochi casi non dimostra niente: guarda le abitudini che si ripetono.",
  };
}
