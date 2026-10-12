// Indicatori tecnici di base calcolati sulle chiusure (giornaliere, oppure del periodo scelto con cTrader).

const PERIOD_MS = { M1: 6e4, M5: 3e5, M15: 9e5, M30: 18e5, H1: 36e5, H4: 144e5, D1: 864e5, W1: 6048e5 };
/** Candele in un anno, per annualizzare la volatilità (stima: mercati aperti 252 giorni, 24 ore). */
const barsPerYear = (period = "D1") => (period === "W1" ? 52 : 252 * (PERIOD_MS.D1 / (PERIOD_MS[period] ?? PERIOD_MS.D1)));

export function sma(values, n) {
  if (values.length < n) return null;
  return values.slice(-n).reduce((a, b) => a + b, 0) / n;
}

export function rsi(values, n = 14) {
  if (values.length <= n) return null;
  let gain = 0, loss = 0;
  for (let i = values.length - n; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / n / (loss / n);
  return 100 - 100 / (1 + rs);
}

export function volatility(values, n = 20, period = "D1") {
  if (values.length <= n) return null;
  const rets = [];
  for (let i = values.length - n; i < values.length; i++) rets.push(Math.log(values[i] / values[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance) * Math.sqrt(barsPerYear(period)) * 100; // annualizzata, in %
}

export function returnPct(values, n) {
  if (values.length <= n) return null;
  return (values.at(-1) / values.at(-1 - n) - 1) * 100;
}

export function summary(candles, period = "D1") {
  const closes = candles.map((c) => c.close);
  const round = (x) => (x == null ? null : Math.round(x * 100) / 100);
  // I prezzi tengono 6 cifre significative (es. EURUSD 1.08432), non 2 decimali.
  const px = (x) => (x == null ? null : Number(x.toPrecision(6)));
  // Rendimenti sulle ultime 5/20/60 candele: "d" = giorni con il periodo D1, altrimenti il periodo (es. return5_H1).
  const suffix = period === "D1" ? "d" : `_${period}`;
  return {
    last: px(closes.at(-1)),
    sma20: px(sma(closes, 20)),
    sma50: px(sma(closes, 50)),
    rsi14: round(rsi(closes, 14)),
    volatility20: round(volatility(closes, 20, period)),
    [`return5${suffix}`]: round(returnPct(closes, 5)),
    [`return20${suffix}`]: round(returnPct(closes, 20)),
    [`return60${suffix}`]: round(returnPct(closes, 60)),
  };
}
