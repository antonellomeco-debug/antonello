// SCANNER DEI MERCATI: controlla tutti i mercati del broker (o la watchlist) con regole fisse e scrive la classifica
// delle occasioni migliori. Non usa Claude: è gratis. Gli agenti di analisi leggono la classifica e studiano solo
// quei mercati. Non apre ordini.
//
// params (tutti facoltativi):
//   groups      gruppi da controllare: forex, metalli, energia, indici, cripto, azioni, altro
//               (predefinito: tutti tranne azioni, che sono migliaia)
//   period      candele usate: H1 (predefinito), H4, D1
//   top         quanti mercati in classifica (predefinito 5)
//   maxSymbols  quanti mercati al massimo per giro (predefinito 150)
//   minScore    punteggio minimo per entrare in classifica (predefinito 55)
//   include     mercati da controllare sempre, es. ["XAUUSD"]
//   exclude     mercati da saltare
//   pauseMs     pausa tra un mercato e l'altro, per i limiti di cTrader (predefinito 250)
//   maxSpreadAtr spread massimo in rapporto all'escursione media di una candela (predefinito 0.2 = 20%): i mercati con
//               costi più alti (coppie esotiche, orari morti) escono dalla classifica. 0 = nessun filtro.

const GROUPS = [
  ["metalli", /metal|gold|silver|oro|argento|precious|xau|xag/i],
  ["energia", /energ|oil|petrol|gas|brent|wti|commod/i],
  ["cripto", /crypto|cripto|bitcoin|coin/i],
  ["indici", /indic|index|indices/i],
  ["azioni", /stock|share|equit|azion|cfd su azioni|nasdaq stocks|nyse/i],
  ["forex", /forex|fx|currenc|valut|major|minor|exotic|cross/i],
];

/** Gruppo di un mercato dal nome della classe e della categoria del broker. */
export function groupOf({ assetClass = "", category = "", symbol = "" }) {
  const text = `${assetClass} ${category}`;
  if (/^(XAU|XAG|XPT|XPD)/i.test(symbol)) return "metalli";
  if (/^(BTC|ETH|LTC|XRP|SOL|ADA|DOGE|BCH|DOT)/i.test(symbol)) return "cripto";
  for (const [g, re] of GROUPS) if (re.test(text)) return g;
  if (/^[A-Z]{6}$/.test(symbol)) return "forex";
  return "altro";
}

/** Un mercato per gruppo a turno: se il limite taglia l'elenco, restano rappresentati tutti i gruppi. */
function roundRobin(items) {
  const by = new Map();
  for (const m of items) by.set(m.group, [...(by.get(m.group) ?? []), m]);
  const queues = [...by.values()];
  const out = [];
  while (queues.some((q) => q.length)) for (const q of queues) if (q.length) out.push(q.shift());
  return out;
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** ATR (escursione media) delle ultime n candele. */
function atr(candles, n = 14) {
  if (candles.length <= n) return null;
  const tr = [];
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1].close;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
  }
  return avg(tr);
}

/** Punteggio 0–100 per il rialzo e per il ribasso, con i motivi in italiano. */
export function scoreMarket(candles, { sma, rsi }) {
  if (!candles || candles.length < 60) return null;
  const closes = candles.map((c) => c.close);
  const price = closes.at(-1);
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const aOld = atr(candles.slice(0, -14), 14);
  if (!s20 || !s50 || r == null || !a || !price) return null;
  const past = candles.slice(-21, -1);
  const hi = Math.max(...past.map((c) => c.high));
  const lo = Math.min(...past.map((c) => c.low));
  const move = (price - closes.at(-21)) / a; // movimento delle ultime 20 candele, in «ATR»
  const expanding = aOld && a > aOld * 1.2;

  const side = (dir) => {
    const up = dir === "rialzo";
    let score = 0;
    const why = [];
    const trend = up ? price > s50 && s20 > s50 : price < s50 && s20 < s50;
    if (trend) {
      score += 30;
      why.push(up ? "sopra la media a 50 con la media a 20 che sale sopra" : "sotto la media a 50 con la media a 20 sotto");
    }
    const breakout = up ? price > hi : price < lo;
    if (breakout) {
      score += 20;
      why.push(up ? "rottura del massimo delle ultime 20 candele" : "rottura del minimo delle ultime 20 candele");
    }
    const m = up ? move : -move;
    if (m > 0) {
      score += Math.min(25, Math.round(m * 5));
      if (m >= 2) why.push(`spinta forte (${m.toFixed(1)} volte l'escursione media)`);
    }
    const healthy = up ? r > 50 && r < 70 : r < 50 && r > 30;
    if (healthy) {
      score += 15;
      why.push(`RSI ${Math.round(r)}`);
    }
    const stretched = up ? r >= 75 : r <= 25;
    if (stretched) {
      score -= 15;
      why.push(`RSI ${Math.round(r)}: già molto ${up ? "comprato" : "venduto"}, attenzione ai ritorni`);
    }
    if (expanding) {
      score += 10;
      why.push("volatilità in aumento");
    }
    return { dir, score: Math.max(0, Math.min(100, score)), why };
  };
  const best = [side("rialzo"), side("ribasso")].sort((x, y) => y.score - x.score)[0];
  return { ...best, price, atrPct: (a / price) * 100, rsi: r };
}

const fmt = (x) => (Math.abs(x) >= 100 ? x.toFixed(2) : Math.abs(x) >= 1 ? x.toFixed(4) : x.toFixed(5)).replace(".", ",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function ({ agent, params, market, notes, log }) {
  const {
    groups = ["forex", "metalli", "energia", "indici", "cripto", "altro"],
    period = "H1",
    top = 5,
    maxSymbols = 150,
    minScore = 55,
    include = [],
    exclude = [],
    pauseMs = 250,
    maxSpreadAtr = 0.2,
  } = params;
  const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const skip = new Set(exclude.map(norm));
  const wanted = new Set(groups);

  // Elenco: tutti i mercati del broker dei gruppi scelti; senza cTrader la watchlist dell'agente.
  const catalog = await market.symbols?.().catch((e) => {
    log(`elenco dei mercati non disponibile (${e.message}): uso la watchlist`);
    return null;
  });
  let list = catalog
    ? roundRobin(catalog.filter((m) => wanted.has(groupOf(m))).map((m) => ({ symbol: m.symbol, group: groupOf(m) })))
    : agent.watchlist.map((s) => ({ symbol: s, group: "watchlist" }));
  for (const s of [...include].reverse()) if (!list.some((m) => norm(m.symbol) === norm(s))) list.unshift({ symbol: s, group: "scelto" });
  list = list.filter((m) => !skip.has(norm(m.symbol))).slice(0, maxSymbols);
  if (!list.length) return "nessun mercato da controllare: controlla groups, include o la watchlist";

  const results = [];
  let failed = 0;
  for (const m of list) {
    try {
      const h = await market.getHistory(m.symbol, catalog ? { period, count: 120 } : {});
      const s = scoreMarket(h.candles, market.indicators);
      if (s) results.push({ ...m, ...s });
    } catch {
      failed++;
    }
    if (pauseMs) await sleep(pauseMs);
  }
  const candidates = results.filter((r) => r.score >= minScore).sort((a, b) => b.score - a.score);
  // Costo d'entrata: lo spread del broker in rapporto all'escursione media. Si controlla solo chi entrerebbe in classifica.
  const ranked = [];
  let costly = 0;
  for (const r of candidates) {
    if (ranked.length >= top) break;
    if (catalog && maxSpreadAtr > 0) {
      let q = null;
      try {
        q = market.getQuote ? await market.getQuote(r.symbol) : null;
      } catch {
        // senza prezzo si tiene il mercato: il filtro è solo una protezione in più
      }
      const atrAbs = (r.atrPct / 100) * r.price;
      if (q?.spread != null && atrAbs > 0) {
        r.spreadAtr = q.spread / atrAbs;
        if (r.spreadAtr > maxSpreadAtr) {
          costly++;
          continue;
        }
      }
    }
    ranked.push(r);
  }
  const when = new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date());
  const groupsSeen = [...new Set(list.map((m) => m.group))].join(", ");
  const head = `CLASSIFICA SCANNER · ${catalog ? period : "D1"} · ${when} — ${results.length} mercati controllati (${groupsSeen})${failed ? `, ${failed} senza dati` : ""}${costly ? `, ${costly} scartati per spread troppo alto` : ""}.`;
  const body = ranked.length
    ? ranked
        .map((r, i) => `${i + 1}. ${r.symbol} · ${r.dir.toUpperCase()} · punteggio ${r.score} — ${r.why.join("; ")}. Prezzo ${fmt(r.price)} · escursione media ${r.atrPct.toFixed(2).replace(".", ",")}%${r.spreadAtr != null ? ` · spread ${Math.round(r.spreadAtr * 100)}% dell'escursione` : ""}`)
        .join("\n")
    : `Nessun mercato sopra ${minScore} punti: niente di chiaro in questo momento.`;
  notes.post(`${head}\n${body}\nÈ un filtro a regole fisse per gli analisti, non un segnale per operare.`, ["SCANNER", ...ranked.map((r) => r.symbol)]);
  return `${results.length} mercati controllati, ${ranked.length} in classifica${ranked.length ? `: ${ranked.map((r) => `${r.symbol} ${r.dir}`).join(", ")}` : ""}`;
}
