// SISTEMA DI TRADING: fa operare uno dei sistemi classici di lib/systems.js (tartarughe, momento, ritorno nella tendenza,
// RSI a 2, compressione) sui mercati scelti, senza Claude: gratis, sempre uguale, lo stesso codice del banco di prova.
// Entra solo sui mercati dove la prova sui prezzi passati è SUPERATA (strumento backtest), rischia una % fissa del conto
// per operazione e mette sempre lo stop loss. Scrive una nota solo quando apre, chiude o trova un problema.
//
// params:
//   system         turtle | momentum | pullback | rsi2 | squeeze (obbligatorio)
//   period         candele: H1, H4 (predefinito), D1
//   markets        mercati (predefinito: la watchlist dell'agente)
//   riskPct        % del saldo rischiata per operazione (predefinito 0.5, massimo 2)
//   maxPositions   posizioni aperte al massimo per questo agente (predefinito 3)
//   requireBacktest true (predefinito) = opera solo dove l'ultima prova è SUPERATA e ha meno di backtestDays giorni
//   backtestDays   età massima della prova (predefinito 45)
//   maxSpreadAtr   spread massimo in rapporto all'escursione media (predefinito 0.25)
//   newsMinutes    niente entrate da 30 minuti prima a 30 minuti dopo una notizia ad alto impatto (predefinito 30; 0 = mai)
//   params         parametri del sistema (es. { entry: 55, exit: 20 } per le tartarughe lente)
import { SYSTEMS, liveSignal, systemParams, warmup, passedBacktest } from "../lib/systems.js";

const PERIOD_MIN = { M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };
const same = (a, b) => String(a).toUpperCase().replace(/[^A-Z0-9]/g, "") === String(b).toUpperCase().replace(/[^A-Z0-9]/g, "");
const fmt = (x) => (Math.abs(x) >= 100 ? x.toFixed(2) : Math.abs(x) >= 1 ? x.toFixed(4) : x.toFixed(5));

export default async function ({ agent, params, market, notes, portfolio, order, log, trading }) {
  const {
    system,
    period = "H4",
    markets = agent.watchlist,
    riskPct: rawRisk = 0.5,
    maxPositions = 3,
    requireBacktest = true,
    backtestDays = 45,
    maxSpreadAtr = 0.25,
    newsMinutes = 30,
    params: sysParams = {},
  } = params;
  if (!SYSTEMS[system]) return `params.system mancante o sconosciuto: usa ${Object.keys(SYSTEMS).join(", ")}`;
  if (!PERIOD_MIN[period]) return `params.period non valido: usa ${Object.keys(PERIOD_MIN).join(", ")}`;
  const riskPct = Math.min(Math.max(Number(rawRisk) || 0.5, 0.05), 2);
  const p = systemParams(system, sysParams);
  const need = warmup(system, p) + 60;
  const onBroker = trading?.mode === "ctrader";
  const tag = `[${system}]`;

  const pf = await portfolio();
  const mine = onBroker ? pf.positions.filter((x) => pf.myPositions.includes(x.positionId)) : pf.positions;
  const balance = onBroker ? pf.account.balance : pf.total;
  const riskMoney = (balance * riskPct) / 100;
  const done = [];
  const skipped = [];
  let open = mine.length;

  for (const symbol of markets) {
    try {
      const h = await market.longHistory(symbol, { period, bars: need });
      const candles = h.candles;
      if (candles.length < need - 60) {
        skipped.push(`${symbol}: poche candele (${candles.length})`);
        continue;
      }
      const held = mine.find((x) => same(x.symbol, symbol));
      if (held) {
        const pos = { side: held.side ?? "buy" };
        const sig = liveSignal(system, candles, p, pos);
        const barsHeld = held.openedAt ? (Date.now() - Date.parse(held.openedAt)) / 60_000 / PERIOD_MIN[period] : 0;
        const timeUp = p.maxBars && barsHeld >= p.maxBars;
        if (sig.exit || timeUp) {
          const why = sig.exit ? "uscita del sistema" : `tempo massimo (${p.maxBars} candele)`;
          const o = onBroker ? { action: "close", positionId: held.positionId, reason: `${tag} ${why}` } : { symbol, side: "sell", qty: held.qty, reason: `${tag} ${why}` };
          await order(o);
          done.push(`CHIUSA ${symbol}: ${why}`);
          open--;
        }
        continue;
      }
      if (open >= maxPositions) continue;
      const sig = liveSignal(system, candles, p);
      if (!sig.entry) continue;
      const { side, stopDist, targetDist, why } = sig.entry;
      if (requireBacktest && !passedBacktest(system, symbol, period, backtestDays)) {
        skipped.push(`${symbol}: segnale ${side} ma la prova sui prezzi passati non è superata (o ha più di ${backtestDays} giorni)`);
        continue;
      }
      if (newsMinutes > 0 && market.newsNear) {
        const news = await market.newsNear(symbol, newsMinutes);
        if (news?.length) {
          skipped.push(`${symbol}: notizia importante vicina (${news[0]})`);
          continue;
        }
      }
      if (!onBroker && side === "sell") {
        skipped.push(`${symbol}: segnale al ribasso, il portafoglio simulato compra soltanto`);
        continue;
      }
      const q = await market.getQuote(symbol);
      const price = q.price ?? candles.at(-1).close;
      if (q.spread != null && sig.atr && q.spread / sig.atr > maxSpreadAtr) {
        skipped.push(`${symbol}: spread ${fmt(q.spread)} troppo alto rispetto all'escursione media ${fmt(sig.atr)}`);
        continue;
      }
      const reason = `${tag} ${why}; rischio ${riskPct}% del conto`;
      let o;
      if (onBroker) {
        const size = await market.riskLots(symbol, stopDist, riskMoney);
        if (!(size.lots > 0)) {
          skipped.push(`${symbol}: ${size.note}`);
          continue;
        }
        o = { symbol, side, lots: size.lots, stop_loss_pct: Number(((stopDist / price) * 100).toFixed(3)), take_profit_pct: targetDist ? Number(((targetDist / price) * 100).toFixed(3)) : undefined, reason };
      } else {
        const qty = Math.min(Math.floor(riskMoney / stopDist), Math.floor((balance * 0.1) / price));
        if (!(qty > 0)) {
          skipped.push(`${symbol}: quantità troppo piccola per il rischio scelto`);
          continue;
        }
        o = { symbol, side, qty, reason };
      }
      const r = await order(o);
      const where = r?.status === "pending" || r?.approvalId ? "PROPOSTA in ✅ Approvazioni" : "APERTA";
      done.push(`${where} ${symbol} ${side === "buy" ? "al rialzo" : "al ribasso"}: ${why}. Prezzo ${fmt(price)}, stop a ${fmt(stopDist)} (${o.stop_loss_pct ?? ((stopDist / price) * 100).toFixed(2)}%)${targetDist ? `, obiettivo a ${fmt(targetDist)}` : ""}${o.lots ? `, ${o.lots} lotti` : `, ${o.qty} pezzi`}`);
      open++;
    } catch (err) {
      log(`${symbol}: ${err.message}`);
      skipped.push(`${symbol}: errore (${err.message})`);
    }
  }

  if (done.length) {
    const head = `SISTEMA ${SYSTEMS[system].label} (${system}, ${period}) — ${new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
    notes.post(`${head}\n${done.join("\n")}${skipped.length ? `\nSaltati: ${skipped.join("; ")}` : ""}`, ["SISTEMA", system.toUpperCase()]);
  }
  return [done.length ? done.join(" | ") : "nessuna operazione", skipped.length ? `saltati: ${skipped.join("; ")}` : ""].filter(Boolean).join(" — ");
}
