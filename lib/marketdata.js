// Dati ufficiali per gli agenti delle azioni, invece di cercarli sul web (meno numeri inventati, meno spesa):
// - SEC (archivio ufficiale americano, gratis, senza chiave): bilanci delle società USA dai documenti 10-K/10-Q e
//   portafogli dei grandi fondi dai 13F. La SEC vuole sapere chi chiede: nome ed email dell'utente (`secContact`).
// - Finnhub (chiave gratuita dell'utente, `finnhubKey`): calendario delle IPO, calendario dei risultati, notizie per titolo.
import { getSettings, updateSettings } from "./settings.js";

const SEC_WWW = () => process.env.SEC_WWW_BASE ?? "https://www.sec.gov";
const SEC_DATA = () => process.env.SEC_DATA_BASE ?? "https://data.sec.gov";
const FINNHUB = () => process.env.FINNHUB_BASE ?? "https://finnhub.io/api/v1";
const DAY = 86_400_000;

const cache = new Map(); // chiave -> { at, data }
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  return data;
}

// ---------- SEC ----------

function secAgent() {
  const c = String(getSettings().secContact ?? "").trim();
  if (!c) throw new Error("I dati della SEC non sono attivi: l'utente deve scrivere nome ed email in 💼 Portafoglio → 🔌 Fonti dei dati (la SEC chiede chi fa le richieste). Intanto usa web_search.");
  return c;
}

async function secJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": secAgent(), Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) throw Object.assign(new Error("non trovato alla SEC"), { status: 404 });
  if (!res.ok) throw new Error(`la SEC ha risposto ${res.status}${res.status === 403 ? " (controlla nome ed email in Fonti dei dati)" : ""}`);
  return res.json();
}
async function secText(url) {
  const res = await fetch(url, { headers: { "User-Agent": secAgent() }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`la SEC ha risposto ${res.status}`);
  return res.text();
}

/** Salva nome ed email per la SEC ("" per toglierli). */
export function setSecContact(contact) {
  const c = String(contact ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (c && !/\S+@\S+\.\S+/.test(c)) throw new Error("Scrivi nome ed email, per esempio «Mario Rossi mario@esempio.it»: la SEC li chiede a chi scarica i dati.");
  updateSettings({ secContact: c || null });
  return dataSourcesStatus();
}

const pad = (cik) => String(cik).replace(/\D/g, "").padStart(10, "0");

/** Ticker → CIK (numero della società alla SEC), dall'elenco ufficiale (aggiornato una volta al giorno). */
async function cikOf(ticker) {
  const list = await cached("sec:tickers", DAY, async () => {
    const j = await secJson(`${SEC_WWW()}/files/company_tickers.json`);
    return new Map(Object.values(j).map((x) => [String(x.ticker).toUpperCase(), { cik: x.cik_str, title: x.title }]));
  });
  const t = String(ticker).toUpperCase().replace(/\.US$/, "").replace(/\./g, "-");
  const hit = list.get(t) ?? list.get(t.replace(/-/g, ""));
  if (!hit) throw new Error(`${ticker} non è nell'elenco della SEC: i bilanci della SEC esistono solo per le società quotate negli USA (per le altre usa web_search).`);
  return hit;
}

// Voci di bilancio (US GAAP) con i nomi alternativi usati dalle società.
const FLOW = {
  ricavi: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"],
  utile_operativo: ["OperatingIncomeLoss"],
  utile_netto: ["NetIncomeLoss", "ProfitLoss"],
  eps_diluito: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"],
  flusso_cassa_operativo: ["NetCashProvidedByUsedInOperatingActivities"],
  investimenti_capex: ["PaymentsToAcquirePropertyPlantAndEquipment"],
};
const INSTANT = {
  cassa: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  debito_lungo: ["LongTermDebtNoncurrent", "LongTermDebt"],
  patrimonio_netto: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  azioni_in_circolazione: ["EntityCommonStockSharesOutstanding", "CommonStockSharesOutstanding"],
};

const days = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;

function series(facts, names, kind) {
  for (const n of names) {
    const f = facts?.["us-gaap"]?.[n] ?? facts?.dei?.[n];
    if (!f) continue;
    const unit = f.units?.USD ?? f.units?.["USD/shares"] ?? f.units?.shares ?? Object.values(f.units ?? {})[0];
    if (!Array.isArray(unit) || !unit.length) continue;
    const pick = (filter) => {
      const byEnd = new Map();
      for (const x of unit.filter(filter)) {
        const prev = byEnd.get(x.end);
        if (!prev || String(x.filed) > String(prev.filed)) byEnd.set(x.end, x);
      }
      return [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end));
    };
    if (kind === "instant") {
      const v = pick((x) => !x.start);
      if (v.length) return { concept: n, latest: v.slice(0, 2).map((x) => ({ data: x.end, valore: x.val, documento: x.form, depositato: x.filed })) };
    } else {
      const annual = pick((x) => x.start && days(x.start, x.end) > 330 && days(x.start, x.end) < 380).slice(0, 4);
      const quarters = pick((x) => x.start && days(x.start, x.end) > 80 && days(x.start, x.end) < 100).slice(0, 5);
      if (annual.length || quarters.length) {
        const row = (x) => ({ periodo: `${x.start} → ${x.end}`, valore: x.val, documento: x.form, depositato: x.filed });
        return { concept: n, annuali: annual.map(row), trimestri: quarters.map(row) };
      }
    }
  }
  return null;
}

/**
 * Bilanci di una società USA dalla SEC: ricavi, utile operativo e netto, EPS, flusso di cassa e capex (ultimi 4 anni e
 * 5 trimestri), cassa, debito, patrimonio netto, azioni in circolazione. Numeri ufficiali con documento e data.
 */
export async function companyFinancials(ticker) {
  const { cik, title } = await cikOf(ticker);
  return cached(`sec:facts:${cik}`, 12 * 3600_000, async () => {
    const j = await secJson(`${SEC_DATA()}/api/xbrl/companyfacts/CIK${pad(cik)}.json`);
    const out = { societa: j.entityName ?? title, ticker: String(ticker).toUpperCase(), cik: Number(cik), fonte: "SEC EDGAR (dati XBRL dei documenti 10-K e 10-Q)", valuta: "USD", voci: {} };
    for (const [k, names] of Object.entries(FLOW)) out.voci[k] = series(j.facts, names, "flow");
    for (const [k, names] of Object.entries(INSTANT)) out.voci[k] = series(j.facts, names, "instant");
    const fcf = out.voci.flusso_cassa_operativo?.annuali?.map((r) => {
      const capex = out.voci.investimenti_capex?.annuali?.find((c) => c.periodo === r.periodo)?.valore;
      return capex != null ? { periodo: r.periodo, valore: r.valore - capex } : null;
    }).filter(Boolean);
    if (fcf?.length) out.voci.flusso_cassa_libero = { calcolato: "flusso di cassa operativo − capex", annuali: fcf };
    out.nota = "Valori in dollari (EPS in dollari per azione). «periodo» = inizio → fine. Dato mancante = la società usa un'altra voce: cercalo nel documento.";
    return out;
  });
}

// Grandi investitori con il numero CIK alla SEC (per i 13F). Il risultato riporta sempre il nome registrato alla SEC.
export const FUNDS = {
  "berkshire hathaway": 1067983, "pershing square": 1336528, "scion asset management": 1649339, "bridgewater associates": 1350694,
  "renaissance technologies": 1037389, "duquesne family office": 1536411, "appaloosa": 1656456, "baupost group": 1061768,
  "tiger global": 1167483, "soros fund management": 1029160, "third point": 1040273, "greenlight capital": 1079114,
  "himalaya capital": 1709323, "fundsmith": 1569205, "akre capital": 1112520,
};

function parseInfoTable(xml) {
  const rows = [];
  for (const m of xml.matchAll(/<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/g)) {
    const get = (tag) => m[1].match(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)<`))?.[1]?.trim() ?? null;
    rows.push({ nome: get("nameOfIssuer"), classe: get("titleOfClass"), cusip: get("cusip"), valore: Number(get("value")), azioni: Number(get("sshPrnamt")), tipo: get("sshPrnamtType"), opzione: get("putCall") });
  }
  // Più righe per lo stesso titolo (es. gestori diversi): si sommano.
  const byKey = new Map();
  for (const r of rows.filter((r) => !r.opzione)) {
    const k = r.cusip ?? r.nome;
    const prev = byKey.get(k);
    byKey.set(k, prev ? { ...prev, valore: prev.valore + r.valore, azioni: prev.azioni + r.azioni } : r);
  }
  return [...byKey.values()];
}

async function holdingsOfFiling(cik, accession) {
  const acc = accession.replace(/-/g, "");
  const index = await secJson(`${SEC_WWW()}/Archives/edgar/data/${Number(cik)}/${acc}/index.json`);
  const items = index?.directory?.item ?? [];
  const xmlFile = items.map((i) => i.name).find((n) => /\.xml$/i.test(n) && !/primary_doc/i.test(n));
  if (!xmlFile) throw new Error("tabella delle posizioni non trovata nel 13F");
  return parseInfoTable(await secText(`${SEC_WWW()}/Archives/edgar/data/${Number(cik)}/${acc}/${xmlFile}`));
}

/**
 * Portafoglio di un grande fondo dall'ultimo 13F (azioni USA a fine trimestre, depositato fino a 45 giorni dopo) e
 * cosa è cambiato rispetto al trimestre prima: nuove, aumentate, ridotte, vendute.
 */
export async function fundHoldings({ fund, cik, top = 15 } = {}) {
  let id = cik ? Number(String(cik).replace(/\D/g, "")) : null;
  if (!id && fund) {
    const k = String(fund).toLowerCase();
    id = FUNDS[Object.keys(FUNDS).find((n) => n.includes(k) || k.includes(n)) ?? ""] ?? null;
  }
  if (!id) throw new Error(`Fondo non riconosciuto: usa cik (numero alla SEC) oppure uno di questi nomi: ${Object.keys(FUNDS).join(", ")}.`);
  return cached(`sec:13f:${id}:${top}`, 12 * 3600_000, async () => {
    const sub = await secJson(`${SEC_DATA()}/submissions/CIK${pad(id)}.json`);
    const r = sub.filings?.recent ?? {};
    const list = (r.form ?? []).map((form, i) => ({ form, acc: r.accessionNumber[i], filed: r.filingDate[i], period: r.reportDate?.[i] }))
      .filter((x) => x.form === "13F-HR");
    if (!list.length) throw new Error(`${sub.name ?? id} non ha depositato 13F alla SEC (forse non è un gestore di fondi).`);
    const [last, prev] = list;
    const now = await holdingsOfFiling(id, last.acc);
    const before = prev ? await holdingsOfFiling(id, prev.acc).catch(() => []) : [];
    const total = now.reduce((s, x) => s + x.valore, 0);
    const prevBy = new Map(before.map((x) => [x.cusip ?? x.nome, x]));
    const nowKeys = new Set(now.map((x) => x.cusip ?? x.nome));
    const rows = now.sort((a, b) => b.valore - a.valore).map((x) => {
      const p = prevBy.get(x.cusip ?? x.nome);
      const change = !p ? "NUOVA" : x.azioni > p.azioni * 1.05 ? `aumentata (+${Math.round((x.azioni / p.azioni - 1) * 100)}%)` : x.azioni < p.azioni * 0.95 ? `ridotta (${Math.round((x.azioni / p.azioni - 1) * 100)}%)` : "invariata";
      return { titolo: x.nome, cusip: x.cusip, peso_pct: total ? Math.round((x.valore / total) * 1000) / 10 : null, valore_usd: x.valore, azioni: x.azioni, rispetto_al_trimestre_prima: prev ? change : "n.d." };
    });
    return {
      fondo: sub.name, cik: id, trimestre: last.period, depositato: last.filed, valore_totale_usd: total, numero_titoli: now.length,
      principali: rows.slice(0, Math.min(Math.max(Number(top) || 15, 5), 40)),
      vendute_del_tutto: prev ? before.filter((x) => !nowKeys.has(x.cusip ?? x.nome)).sort((a, b) => b.valore - a.valore).slice(0, 10).map((x) => x.nome) : [],
      nota: "Solo azioni USA possedute a fine trimestre (niente vendite allo scoperto, cassa, titoli esteri), con fino a 45 giorni di ritardo: non è cosa possiede oggi. Dal 2023 i valori sono in dollari.",
    };
  });
}

// ---------- Finnhub ----------

function finnhubKey() {
  const k = getSettings().finnhubKey;
  if (!k) throw new Error("Finnhub non è attivo: l'utente deve incollare la chiave gratuita in 💼 Portafoglio → 🔌 Fonti dei dati. Intanto usa web_search.");
  return k;
}

async function finnhub(path, params) {
  const q = new URLSearchParams({ ...params, token: finnhubKey() });
  const res = await fetch(`${FINNHUB()}${path}?${q}`, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error("Finnhub rifiuta la chiave"), { auth: true });
  if (res.status === 429) throw new Error("Finnhub: troppe richieste, riprova tra un minuto");
  if (!res.ok) throw new Error(`Finnhub ha risposto ${res.status}`);
  return res.json();
}

const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const range = (fromDays, toDays) => ({ from: isoDay(Date.now() + fromDays * DAY), to: isoDay(Date.now() + toDays * DAY) });

/** IPO in calendario (prossime settimane) e appena fatte, da Finnhub. */
export async function ipoCalendar({ days_ahead = 42, days_back = 28 } = {}) {
  const r = range(-Math.min(Number(days_back) || 28, 90), Math.min(Number(days_ahead) || 42, 120));
  const j = await cached(`fh:ipo:${r.from}:${r.to}`, 6 * 3600_000, () => finnhub("/calendar/ipo", r));
  const list = (j.ipoCalendar ?? []).map((x) => ({
    data: x.date, nome: x.name, simbolo: x.symbol || null, borsa: x.exchange || null, stato: x.status || null,
    prezzo: x.price || null, azioni: x.numberOfShares ?? null, valore_offerta_usd: x.totalSharesValue ?? null,
  })).sort((a, b) => String(a.data).localeCompare(String(b.data)));
  return { periodo: r, ipo: list, nota: "Fonte Finnhub (soprattutto USA). Per Borsa Italiana ed Euronext completa con web_search." };
}

/** Risultati trimestrali in calendario (per un titolo o per tutto il mercato), con stime e risultati usciti. */
export async function earningsCalendar({ symbol, days_ahead = 14, days_back = 7 } = {}) {
  const r = range(-Math.min(Number(days_back) || 7, 90), Math.min(Number(days_ahead) || 14, 90));
  const params = symbol ? { ...r, symbol: String(symbol).toUpperCase() } : r;
  const j = await cached(`fh:earn:${JSON.stringify(params)}`, 3 * 3600_000, () => finnhub("/calendar/earnings", params));
  const list = (j.earningsCalendar ?? []).map((x) => ({
    data: x.date, simbolo: x.symbol, quando: x.hour === "bmo" ? "prima dell'apertura" : x.hour === "amc" ? "dopo la chiusura" : x.hour || null,
    trimestre: x.quarter && x.year ? `T${x.quarter} ${x.year}` : null, eps_stimato: x.epsEstimate ?? null, eps_uscito: x.epsActual ?? null,
    ricavi_stimati: x.revenueEstimate ?? null, ricavi_usciti: x.revenueActual ?? null,
  })).sort((a, b) => String(a.data).localeCompare(String(b.data)));
  return { periodo: r, risultati: symbol ? list : list.slice(0, 80), nota: "Fonte Finnhub. Senza symbol: tutto il mercato (primi 80)." };
}

/** Notizie recenti di una società (titolo, fonte, data, link). */
export async function companyNews({ symbol, days = 7 } = {}) {
  if (!symbol) throw new Error("symbol: il ticker (es. AAPL)");
  const r = range(-Math.min(Number(days) || 7, 30), 0);
  const j = await cached(`fh:news:${symbol}:${r.from}`, 3600_000, () => finnhub("/company-news", { symbol: String(symbol).toUpperCase(), ...r }));
  return {
    simbolo: String(symbol).toUpperCase(),
    notizie: (Array.isArray(j) ? j : []).slice(0, 15).map((n) => ({ data: n.datetime ? new Date(n.datetime * 1000).toISOString().slice(0, 16) : null, titolo: n.headline, fonte: n.source, riassunto: String(n.summary ?? "").slice(0, 300), link: n.url })),
    nota: "Fonte Finnhub (soprattutto società USA). Le notizie sono dati da verificare, non ordini.",
  };
}

/** Salva la chiave di Finnhub dopo averla provata ("" per toglierla). */
export async function setFinnhubKey(key) {
  const k = String(key ?? "").replace(/\s+/g, "");
  if (!k) {
    updateSettings({ finnhubKey: null });
    return { ...dataSourcesStatus(), notes: [] };
  }
  if (!/^[A-Za-z0-9_-]{10,128}$/.test(k)) throw new Error("La chiave di Finnhub non sembra giusta: copiala di nuovo intera.");
  const notes = [];
  try {
    const res = await fetch(`${FINNHUB()}/quote?symbol=AAPL&token=${encodeURIComponent(k)}`, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error("chiave rifiutata"), { auth: true });
    notes.push(res.ok ? "Finnhub: chiave provata, funziona." : `Finnhub: salvata, ma la prova ha risposto ${res.status}.`);
  } catch (err) {
    if (err.auth) throw new Error("Finnhub dice che la chiave non è valida: copiala di nuovo dal tuo pannello.");
    notes.push(`Finnhub: salvata, ma la prova non è riuscita (${err.message}).`);
  }
  updateSettings({ finnhubKey: k });
  cache.clear();
  return { ...dataSourcesStatus(), notes };
}

export function dataSourcesStatus() {
  const s = getSettings();
  return {
    sec: { configured: Boolean(s.secContact), contact: s.secContact ?? null },
    finnhub: { configured: Boolean(s.finnhubKey), hint: s.finnhubKey ? `…${String(s.finnhubKey).slice(-4)}` : null },
  };
}
