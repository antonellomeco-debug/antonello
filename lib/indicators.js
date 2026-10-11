// Indicatori tecnici di base calcolati sulle chiusure giornaliere.

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

export function volatility(values, n = 20) {
  if (values.length <= n) return null;
  const rets = [];
  for (let i = values.length - n; i < values.length; i++) rets.push(Math.log(values[i] / values[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100; // annualizzata, in %
}

export function returnPct(values, n) {
  if (values.length <= n) return null;
  return (values.at(-1) / values.at(-1 - n) - 1) * 100;
}

export function summary(candles) {
  const closes = candles.map((c) => c.close);
  const round = (x) => (x == null ? null : Math.round(x * 100) / 100);
  return {
    last: round(closes.at(-1)),
    sma20: round(sma(closes, 20)),
    sma50: round(sma(closes, 50)),
    rsi14: round(rsi(closes, 14)),
    volatility20: round(volatility(closes, 20)),
    return5d: round(returnPct(closes, 5)),
    return20d: round(returnPct(closes, 20)),
    return60d: round(returnPct(closes, 60)),
  };
}
