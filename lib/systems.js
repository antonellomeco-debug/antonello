// Sistemi di trading classici scritti in codice (gratis, sempre uguali, senza Claude) e banco di prova sui prezzi passati.
//
// Ogni sistema ha:
//   prepare(candles, p)  → le serie di indicatori, calcolate una volta sola;
//   entry(s, i, p)       → segnale sulla candela i già chiusa: { side, stopDist, targetDist?, why } oppure null;
//   exit(s, i, pos, p)   → true se la posizione aperta va chiusa alla chiusura della candela i (facoltativo).
// Le stesse funzioni servono al banco di prova e all'agente che opera (strategies/sistema.js): quello che si prova è
// esattamente quello che poi si fa.
import { getState, persist } from "./store.js";

// ---------- indicatori su serie ----------

export function smaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Escursione media (ATR) a media semplice delle ultime n candele. */
export function atrSeries(candles, n) {
  const tr = candles.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))));
  return smaSeries(tr, n);
}

/** RSI di Wilder. */
export function rsiSeries(values, n) {
  const out = new Array(values.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= n) {
      gain += g / n;
      loss += l / n;
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
    }
    if (i >= n) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Massimo (o minimo) delle n candele PRIMA della candela i (la candela i esclusa). */
function channel(values, n, pick) {
  const out = new Array(values.length).fill(null);
  for (let i = n; i < values.length; i++) {
    let v = values[i - n];
    for (let j = i - n + 1; j < i; j++) v = pick(v, values[j]);
    out[i] = v;
  }
  return out;
}
export const highestBefore = (values, n) => channel(values, n, Math.max);
export const lowestBefore = (values, n) => channel(values, n, Math.min);

const ok = (...xs) => xs.every((x) => x != null && Number.isFinite(x));

// ---------- i sistemi ----------

export const SYSTEMS = {
  turtle: {
    label: "Tartarughe (rottura del canale)",
    credit: "Richard Dennis e le Tartarughe, Ed Seykota: seguire la tendenza, tagliare presto le perdite, lasciar correre i guadagni.",
    how: "Compra quando la chiusura supera il massimo delle ultime «entry» candele, vende quando scende sotto il minimo. Stop a «stopAtr» escursioni medie; esce quando il prezzo rompe il canale opposto più corto («exit»).",
    defaults: { entry: 20, exit: 10, atr: 20, stopAtr: 2, trend: 0 },
    prepare(c, p) {
      const close = c.map((x) => x.close);
      return {
        c, close,
        hh: highestBefore(c.map((x) => x.high), p.entry),
        ll: lowestBefore(c.map((x) => x.low), p.entry),
        xh: highestBefore(c.map((x) => x.high), p.exit),
        xl: lowestBefore(c.map((x) => x.low), p.exit),
        atr: atrSeries(c, p.atr),
        trend: p.trend ? smaSeries(close, p.trend) : null,
      };
    },
    entry(s, i, p) {
      const { close, hh, ll, atr } = s;
      if (!ok(hh[i], ll[i], atr[i])) return null;
      const t = s.trend?.[i];
      if (s.trend && t == null) return null;
      if (close[i] > hh[i] && (!s.trend || close[i] > t)) return { side: "buy", stopDist: p.stopAtr * atr[i], why: `chiusura sopra il massimo di ${p.entry} candele` };
      if (close[i] < ll[i] && (!s.trend || close[i] < t)) return { side: "sell", stopDist: p.stopAtr * atr[i], why: `chiusura sotto il minimo di ${p.entry} candele` };
      return null;
    },
    exit(s, i, pos) {
      if (!ok(s.xh[i], s.xl[i])) return false;
      return pos.side === "buy" ? s.close[i] < s.xl[i] : s.close[i] > s.xh[i];
    },
  },

  momentum: {
    label: "Momento di lungo periodo",
    credit: "Ricerca di AQR e Moskowitz sul «time-series momentum», usato dai fondi che seguono la tendenza (Winton, Man AHL).",
    how: "Sta dalla parte del rendimento delle ultime «lookback» candele, solo se il prezzo è anche dalla stessa parte della media a «sma». Esce quando il rendimento cambia segno. Stop largo a «stopAtr» escursioni medie.",
    defaults: { lookback: 120, sma: 50, atr: 20, stopAtr: 3 },
    prepare(c, p) {
      const close = c.map((x) => x.close);
      return { c, close, sma: smaSeries(close, p.sma), atr: atrSeries(c, p.atr) };
    },
    entry(s, i, p) {
      if (i < p.lookback || !ok(s.sma[i], s.atr[i])) return null;
      const ret = s.close[i] / s.close[i - p.lookback] - 1;
      if (ret > 0 && s.close[i] > s.sma[i]) return { side: "buy", stopDist: p.stopAtr * s.atr[i], why: `rendimento di ${p.lookback} candele +${(ret * 100).toFixed(1)}%` };
      if (ret < 0 && s.close[i] < s.sma[i]) return { side: "sell", stopDist: p.stopAtr * s.atr[i], why: `rendimento di ${p.lookback} candele ${(ret * 100).toFixed(1)}%` };
      return null;
    },
    exit(s, i, pos, p) {
      if (i < p.lookback) return false;
      const ret = s.close[i] / s.close[i - p.lookback] - 1;
      return pos.side === "buy" ? ret < 0 : ret > 0;
    },
  },

  pullback: {
    label: "Ritorno nella tendenza",
    credit: "Linda Raschke («Holy Grail») e i trader di tendenza: entrare in una tendenza sana quando torna sulla media, non quando scappa.",
    how: "Tendenza al rialzo (prezzo e media a «fast» sopra la media a «slow», che sale): compra quando il prezzo tocca la media veloce e chiude di nuovo sopra con una candela verde. Stop sotto il minimo del ritorno, obiettivo «rr» volte il rischio. Specchio al ribasso.",
    defaults: { fast: 20, slow: 50, atr: 14, touch: 0.2, rr: 2, maxBars: 30 },
    prepare(c, p) {
      const close = c.map((x) => x.close);
      return { c, close, fast: smaSeries(close, p.fast), slow: smaSeries(close, p.slow), atr: atrSeries(c, p.atr) };
    },
    entry(s, i, p) {
      const { c, close, fast, slow, atr } = s;
      if (i < 6 || !ok(fast[i], slow[i], slow[i - 5], atr[i])) return null;
      const a = atr[i];
      const bar = c[i];
      const prev = c[i - 1];
      const upTrend = close[i] > slow[i] && fast[i] > slow[i] && slow[i] > slow[i - 5];
      const downTrend = close[i] < slow[i] && fast[i] < slow[i] && slow[i] < slow[i - 5];
      if (upTrend && Math.min(bar.low, prev.low) <= fast[i] + p.touch * a && bar.close > bar.open && bar.close > fast[i]) {
        const stopDist = Math.max(a, bar.close - (Math.min(bar.low, prev.low) - 0.2 * a));
        return { side: "buy", stopDist, targetDist: p.rr * stopDist, why: "ritorno sulla media veloce in tendenza al rialzo" };
      }
      if (downTrend && Math.max(bar.high, prev.high) >= fast[i] - p.touch * a && bar.close < bar.open && bar.close < fast[i]) {
        const stopDist = Math.max(a, Math.max(bar.high, prev.high) + 0.2 * a - bar.close);
        return { side: "sell", stopDist, targetDist: p.rr * stopDist, why: "ritorno sulla media veloce in tendenza al ribasso" };
      }
      return null;
    },
  },

  rsi2: {
    label: "Eccesso di breve nella tendenza",
    credit: "Larry Connors (RSI a 2 periodi): comprare la paura di pochi giorni dentro una tendenza di fondo al rialzo.",
    how: "Prezzo sopra la media a «trend»: compra quando l'RSI a «rsiLen» scende sotto «low»; esce quando il prezzo chiude sopra la media a «exitSma». Stop di sicurezza a «stopAtr» escursioni medie. Al ribasso solo se «shorts» è attivo.",
    defaults: { trend: 200, rsiLen: 2, low: 10, high: 90, exitSma: 5, atr: 14, stopAtr: 2.5, shorts: false, maxBars: 15 },
    prepare(c, p) {
      const close = c.map((x) => x.close);
      return { c, close, trend: smaSeries(close, p.trend), rsi: rsiSeries(close, p.rsiLen), exit: smaSeries(close, p.exitSma), atr: atrSeries(c, p.atr) };
    },
    entry(s, i, p) {
      if (!ok(s.trend[i], s.rsi[i], s.atr[i])) return null;
      if (s.close[i] > s.trend[i] && s.rsi[i] < p.low) return { side: "buy", stopDist: p.stopAtr * s.atr[i], why: `RSI(${p.rsiLen}) ${s.rsi[i].toFixed(0)} sopra la media a ${p.trend}` };
      if (p.shorts && s.close[i] < s.trend[i] && s.rsi[i] > p.high) return { side: "sell", stopDist: p.stopAtr * s.atr[i], why: `RSI(${p.rsiLen}) ${s.rsi[i].toFixed(0)} sotto la media a ${p.trend}` };
      return null;
    },
    exit(s, i, pos) {
      if (!ok(s.exit[i])) return false;
      return pos.side === "buy" ? s.close[i] > s.exit[i] : s.close[i] < s.exit[i];
    },
  },

  squeeze: {
    label: "Rottura dopo la compressione",
    credit: "Toby Crabel (giorni stretti «NR7»): dopo una candela molto stretta il mercato tende a fare un movimento ampio.",
    how: "Se la candela prima è la più stretta delle ultime «lookback» e quella dopo chiude oltre il suo massimo (o minimo), entra in quella direzione. Stop dall'altra parte della candela stretta, obiettivo «rr» volte il rischio.",
    defaults: { lookback: 7, atr: 14, rr: 2, maxBars: 10 },
    prepare(c, p) {
      return { c, close: c.map((x) => x.close), atr: atrSeries(c, p.atr) };
    },
    entry(s, i, p) {
      const { c, atr } = s;
      if (i < p.lookback + 1 || !ok(atr[i])) return null;
      const nr = c[i - 1];
      const range = nr.high - nr.low;
      for (let j = i - p.lookback; j < i - 1; j++) if (c[j].high - c[j].low <= range) return null;
      const bar = c[i];
      if (bar.close > nr.high) {
        const stopDist = Math.max(0.5 * atr[i], bar.close - nr.low);
        return { side: "buy", stopDist, targetDist: p.rr * stopDist, why: `rottura in su dopo la candela più stretta di ${p.lookback}` };
      }
      if (bar.close < nr.low) {
        const stopDist = Math.max(0.5 * atr[i], nr.high - bar.close);
        return { side: "sell", stopDist, targetDist: p.rr * stopDist, why: `rottura in giù dopo la candela più stretta di ${p.lookback}` };
      }
      return null;
    },
  },
};

export const SYSTEM_NAMES = Object.keys(SYSTEMS);

/** Parametri del sistema: quelli predefiniti più quelli scelti (solo numeri e sì/no noti). */
export function systemParams(name, params = {}) {
  const sys = SYSTEMS[name];
  if (!sys) throw new Error(`Sistema sconosciuto: ${name}. Disponibili: ${SYSTEM_NAMES.join(", ")}.`);
  const p = { ...sys.defaults };
  for (const [k, v] of Object.entries(params ?? {})) {
    if (!(k in sys.defaults)) continue;
    if (typeof sys.defaults[k] === "boolean") p[k] = v === true || v === "true";
    else if (Number.isFinite(Number(v)) && Number(v) >= 0) p[k] = Number(v);
  }
  return p;
}

/** Candele che servono prima del primo segnale (le medie più lunghe). */
export function warmup(name, p) {
  const nums = Object.entries(p).filter(([k, v]) => typeof v === "number" && !["stopAtr", "rr", "touch", "low", "high", "maxBars"].includes(k)).map(([, v]) => v);
  return Math.max(30, ...nums) + 2;
}

/** Segnale e stato sull'ultima candela chiusa, per l'agente che opera. */
export function liveSignal(name, candles, params = {}, position = null) {
  const sys = SYSTEMS[name];
  const p = systemParams(name, params);
  const s = sys.prepare(candles, p);
  const i = candles.length - 1;
  return {
    entry: position ? null : sys.entry(s, i, p),
    exit: position ? Boolean(sys.exit?.(s, i, position, p)) : false,
    atr: s.atr?.[i] ?? null,
    params: p,
  };
}

// ---------- banco di prova ----------

/**
 * Prova un sistema sulle candele passate. Entra all'apertura della candela dopo il segnale; stop e obiettivo si controllano
 * dentro ogni candela (se la stessa candela tocca tutti e due si conta lo stop: prudenza); le uscite del sistema avvengono
 * all'apertura dopo. Ogni operazione paga lo spread e i costi. Risultati in R (1 R = quanto si rischia con lo stop).
 * opts: { spread (in prezzo, andata e ritorno), costPct (% del prezzo per lato), riskPct (% del conto per operazione),
 *         flatWeekend (true = chiude tutto prima del fine settimana, come la chiusura del venerdì del programma) }.
 */
export function backtest(candles, name, params = {}, opts = {}) {
  const sys = SYSTEMS[name];
  const p = systemParams(name, params);
  const s = sys.prepare(candles, p);
  const spread = Math.max(0, Number(opts.spread) || 0);
  const costPct = Math.max(0, Number(opts.costPct) || 0);
  const trades = [];
  let pos = null;
  const close = (i, price, why) => {
    const dir = pos.side === "buy" ? 1 : -1;
    const cost = spread + (costPct / 100) * (pos.entry + price);
    const net = (price - pos.entry) * dir - cost;
    trades.push({ side: pos.side, in: candles[pos.at].time ?? candles[pos.at].date, out: candles[i].time ?? candles[i].date, at: pos.at, bars: i - pos.at + 1, entry: pos.entry, exit: price, r: net / pos.risk, why });
    pos = null;
  };
  const start = warmup(name, p);
  for (let i = start; i < candles.length; i++) {
    const bar = candles[i];
    if (pos?.exitNext) close(i, bar.open, "uscita del sistema");
    if (pos && i >= pos.at) {
      const buy = pos.side === "buy";
      const hitStop = buy ? bar.low <= pos.stop : bar.high >= pos.stop;
      const hitTarget = pos.target != null && (buy ? bar.high >= pos.target : bar.low <= pos.target);
      if (hitStop) close(i, buy ? Math.min(bar.open, pos.stop) : Math.max(bar.open, pos.stop), "stop");
      else if (hitTarget) close(i, buy ? Math.max(bar.open, pos.target) : Math.min(bar.open, pos.target), "obiettivo");
    }
    if (pos && ((sys.exit && sys.exit(s, i, pos, p)) || (p.maxBars && i - pos.at + 1 >= p.maxBars))) pos.exitNext = true;
    // Chiusura del venerdì: prima di un buco di più di un giorno e mezzo (il fine settimana) si esce alla chiusura.
    if (pos && opts.flatWeekend && i >= pos.at && candles[i + 1] && gapMs(candles[i], candles[i + 1]) > 36 * 3_600_000) close(i, bar.close, "chiusura del venerdì");
    if (!pos && i < candles.length - 1) {
      const sig = sys.entry(s, i, p);
      if (sig && sig.stopDist > 0) {
        const entry = candles[i + 1].open;
        const dir = sig.side === "buy" ? 1 : -1;
        pos = { side: sig.side, at: i + 1, entry, risk: sig.stopDist, stop: entry - dir * sig.stopDist, target: sig.targetDist ? entry + dir * sig.targetDist : null };
      }
    }
  }
  if (pos) close(candles.length - 1, candles.at(-1).close, "aperta a fine prova");

  const split = Math.floor(candles.length * 0.7);
  const first = candles[start] ?? candles[0];
  const last = candles.at(-1);
  const ts = (c) => c.time ?? Date.parse(c.date);
  const days = (ts(last) - ts(first)) / 86_400_000;
  const all = stats(trades, opts.riskPct, days);
  const inSample = stats(trades.filter((t) => t.at < split), opts.riskPct);
  const outSample = stats(trades.filter((t) => t.at >= split), opts.riskPct);
  return {
    system: name,
    params: p,
    candles: candles.length,
    from: first.time ? new Date(first.time).toISOString().slice(0, 10) : first.date,
    to: last.time ? new Date(last.time).toISOString().slice(0, 10) : last.date,
    buyHoldPct: round(((last.close / first.close) - 1) * 100, 1),
    ...all,
    inSample,
    outSample,
    verdict: verdict(all, outSample, opts.minTrades ?? 30),
    operations: trades,
  };
}

const gapMs = (a, b) => (b.time ?? Date.parse(b.date)) - (a.time ?? Date.parse(a.date));
const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Numeri di un elenco di operazioni (in R), più l'andamento del conto rischiando riskPct% per operazione. */
export function stats(trades, riskPct = 0.5, days = null) {
  const n = trades.length;
  const rs = trades.map((t) => t.r);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const sumW = wins.reduce((a, b) => a + b, 0);
  const sumL = -losses.reduce((a, b) => a + b, 0);
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  let eq = 1;
  let eqPeak = 1;
  let maxDdPct = 0;
  for (const r of rs) {
    cum += r;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    eq *= 1 + (r * (Number(riskPct) || 0.5)) / 100;
    eqPeak = Math.max(eqPeak, eq);
    maxDdPct = Math.max(maxDdPct, (1 - eq / eqPeak) * 100);
  }
  const years = days ? days / 365.25 : null;
  return {
    trades: n,
    winRate: n ? round((wins.length / n) * 100, 1) : null,
    avgWinR: wins.length ? round(sumW / wins.length) : null,
    avgLossR: losses.length ? round(-sumL / losses.length) : null,
    expectancyR: n ? round(rs.reduce((a, b) => a + b, 0) / n, 3) : null,
    profitFactor: sumL > 0 ? round(sumW / sumL) : wins.length ? 99 : null,
    totalR: round(cum, 1),
    maxDrawdownR: round(maxDd, 1),
    returnPct: round((eq - 1) * 100, 1),
    maxDrawdownPct: round(maxDdPct, 1),
    ...(years && years > 0.2 ? { yearlyPct: round((eq ** (1 / years) - 1) * 100, 1), years: round(years, 1) } : {}),
    avgBars: n ? round(trades.reduce((a, t) => a + t.bars, 0) / n, 1) : null,
  };
}

/**
 * Verdetto prudente: abbastanza operazioni, guadagno medio di almeno 0,1 R dopo i costi, profitti almeno 1,2 volte le
 * perdite, e positivo anche nell'ultimo 30% dei dati (la parte «fuori campione», che nessuno ha guardato prima).
 */
export function verdict(all, out, minTrades = 30) {
  if (all.trades < minTrades) return { esito: "POCHI DATI", motivo: `${all.trades} operazioni: ne servono almeno ${minTrades} per giudicare` };
  const why = [];
  const it = (x) => String(x).replace(".", ",");
  if (!(all.expectancyR >= 0.1)) why.push(`guadagno medio ${it(all.expectancyR)} R (serve almeno 0,1)`);
  if (!(all.profitFactor >= 1.2)) why.push(`fattore di profitto ${it(all.profitFactor)} (serve almeno 1,2)`);
  if (!(out.trades >= 5 && out.expectancyR > 0)) why.push(`ultimo 30% dei dati ${out.trades ? `${it(out.expectancyR)} R` : "senza operazioni"} (deve restare positivo)`);
  return why.length ? { esito: "BOCCIATO", motivo: why.join("; ") } : { esito: "SUPERATO", motivo: "guadagna dopo i costi anche sui dati più recenti" };
}

// ---------- archivio delle prove ----------

const normSym = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Salva l'esito di una prova (con le ultime 10 operazioni, non tutte) e lo restituisce. */
export function saveBacktest(entry) {
  const st = getState();
  const { operations, ...rest } = entry;
  const saved = { id: `bt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), ...rest, lastTrades: (operations ?? []).slice(-10) };
  st.backtests = [...(st.backtests ?? []), saved].slice(-300);
  persist();
  return saved;
}

export function listBacktests({ limit = 50 } = {}) {
  return [...(getState().backtests ?? [])].reverse().slice(0, limit);
}

/** L'ultima prova di quel sistema su quel mercato e periodo è SUPERATA e ha al massimo maxAgeDays giorni? */
export function passedBacktest(system, symbol, period, maxAgeDays = 45) {
  const last = [...(getState().backtests ?? [])].reverse().find((b) => b.system === system && normSym(b.symbol) === normSym(symbol) && b.period === period);
  return Boolean(last && last.verdict?.esito === "SUPERATO" && Date.now() - Date.parse(last.at) <= maxAgeDays * 86_400_000);
}

/** Descrizione dei sistemi per gli agenti e per l'interfaccia. */
export function describeSystems() {
  return SYSTEM_NAMES.map((name) => ({ nome: name, titolo: SYSTEMS[name].label, ispirato_a: SYSTEMS[name].credit, come_funziona: SYSTEMS[name].how, parametri: SYSTEMS[name].defaults }));
}
