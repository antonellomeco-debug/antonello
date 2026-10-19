// Collegamento con cTrader: credenziali dell'app, token, conti, prezzi, candele, posizioni e ordini.
// Configurazione e token restano solo sul computer, in data/ctrader.json.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../paths.js";
import { Connection, CTraderError } from "./client.js";
import { authorizationUrl, exchangeCode, refreshTokens } from "./oauth.js";
import { bus } from "../store.js";

const FILE = path.join(DATA_DIR, "ctrader.json");
const PRICE = 100_000; // prezzi del protocollo: interi in 1/100000
const TOKEN_ERRORS = new Set(["CH_ACCESS_TOKEN_INVALID", "OA_AUTH_TOKEN_EXPIRED"]);
const RATE_ERRORS = new Set(["BLOCKED_PAYLOAD_TYPE", "REQUEST_FREQUENCY_EXCEEDED"]);
export const PERIOD_MS = { M1: 6e4, M5: 3e5, M15: 9e5, M30: 18e5, H1: 36e5, H4: 144e5, D1: 864e5, W1: 6048e5 };

let cfg = load();
const conns = {};
const ready = {}; // env -> promise della connessione autorizzata per l'app
const accountReady = new Map(); // "env:id" -> promise dell'autorizzazione del conto
const cache = new Map(); // id conto -> { list, byNorm, details, assets, loadedAt }
const spots = new Map(); // "id:symbolId" -> { bid, ask, at }
const subscribed = new Map(); // id conto -> Set(symbolId)
const envOf = new Map(); // id conto -> "demo" | "live"
const execListeners = new Set();
let pendingAuth = null;
let refreshing = null;
let lastError = null;
let refreshError = null; // rinnovo dell'accesso non riuscito: resta visibile finché un rinnovo non riesce
let refreshRetryAt = 0; // dopo un rinnovo fallito si riprova più tardi, continuando a usare il token ancora valido


function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!d || typeof d !== "object" || Array.isArray(d)) return { accounts: [] };
    // Forma sicura anche per un file rovinato o importato male: senza questo il programma si fermerebbe.
    const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
    return {
      ...d,
      accounts: Array.isArray(d.accounts) ? d.accounts.filter(isObj) : [],
      token: isObj(d.token) ? d.token : null,
      ...(typeof d.clientId === "string" ? {} : { clientId: undefined }),
      ...(typeof d.clientSecret === "string" ? {} : { clientSecret: undefined }),
    };
  } catch {
    return { accounts: [] };
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(`${FILE}.tmp`, FILE);
  fs.chmodSync(FILE, 0o600);
}

const notify = () => bus.emit("event", { type: "broker" });
export const norm = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

// ---------- errori in italiano ----------

const ITALIAN = {
  MARKET_CLOSED: "il mercato di questo strumento è chiuso",
  NOT_ENOUGH_MONEY: "margine insufficiente sul conto",
  TRADING_DISABLED: "il trading su questo strumento è disattivato dal broker",
  TRADING_NOT_ALLOWED: "il conto è in sola lettura",
  CHANNEL_IS_BLOCKED: "il broker non permette operazioni su questo conto tramite API",
  TRADING_BAD_VOLUME: "quantità non valida per questo strumento",
  TRADING_BAD_STOPS: "stop loss o take profit non validi",
  PROTECTION_IS_TOO_CLOSE_TO_MARKET: "stop loss o take profit troppo vicini al prezzo",
  POSITION_NOT_FOUND: "posizione non trovata (forse già chiusa)",
  POSITION_NOT_OPEN: "la posizione non è aperta",
  SHORT_SELLING_NOT_ALLOWED: "la vendita allo scoperto non è permessa su questo strumento",
  SYMBOL_NOT_FOUND: "strumento non trovato",
  SYMBOL_HAS_HOLIDAY: "oggi è festivo per questo strumento",
  TOO_MANY_POSITIONS: "il conto ha raggiunto il numero massimo di posizioni",
  MAX_EXPOSURE_REACHED: "raggiunta l'esposizione massima consentita dal broker",
  NO_QUOTES: "nessun prezzo disponibile in questo momento",
  CH_CLIENT_AUTH_FAILURE: "Client ID o Client Secret non validi, oppure l'app cTrader non è ancora stata approvata",
  CH_OA_CLIENT_NOT_FOUND: "Client ID non trovato: controlla di averlo copiato bene",
  CH_ACCESS_TOKEN_INVALID: "accesso scaduto o revocato: premi di nuovo «Collega cTrader»",
  OA_AUTH_TOKEN_EXPIRED: "accesso scaduto: premi di nuovo «Collega cTrader»",
  CH_CTID_TRADER_ACCOUNT_NOT_FOUND: "conto non trovato tra quelli autorizzati",
  RET_ACCOUNT_DISABLED: "il conto è disattivato",
  SERVER_IS_UNDER_MAINTENANCE: "i server di cTrader sono in manutenzione, riprova più tardi",
  CONNECTIONS_LIMIT_EXCEEDED: "troppe connessioni aperte con questa app",
};

function friendly(err) {
  if (!(err instanceof CTraderError)) return err;
  const it = ITALIAN[err.code];
  const e = new Error(`cTrader: ${it ?? err.description ?? err.code}${it ? "" : ` (${err.code})`}`);
  e.code = err.code;
  return e;
}

// ---------- configurazione e accesso ----------

export function status() {
  return {
    configured: Boolean(cfg.clientId && cfg.clientSecret),
    clientId: cfg.clientId ? `${cfg.clientId.slice(0, 6)}…` : null,
    linked: Boolean(cfg.token?.accessToken),
    tokenExpiresAt: cfg.token?.expiresAt ?? null,
    scope: cfg.scope ?? null,
    accounts: cfg.accounts,
    dataAccountId: dataAccountId(),
    connections: { demo: conns.demo?.state ?? "closed", live: conns.live?.state ?? "closed" },
    lastError: lastError ?? refreshError,
  };
}

export const isReady = () => Boolean(cfg.clientId && cfg.clientSecret && cfg.token?.accessToken && cfg.accounts.length);
export const account = (id) => cfg.accounts.find((a) => String(a.ctidTraderAccountId) === String(id)) ?? null;
export function dataAccountId() {
  if (cfg.dataAccountId && account(cfg.dataAccountId)) return cfg.dataAccountId;
  return (cfg.accounts.find((a) => !a.isLive) ?? cfg.accounts[0])?.ctidTraderAccountId ?? null;
}

export function setCredentials({ clientId, clientSecret }) {
  const id = String(clientId ?? "").trim();
  const secret = String(clientSecret ?? "").trim();
  if (id.length < 6 || secret.length < 6 || /\s/.test(id + secret)) throw new Error("Client ID e Client Secret sembrano incompleti: copiali di nuovo da openapi.ctrader.com.");
  const changed = id !== cfg.clientId;
  cfg.clientId = id;
  cfg.clientSecret = secret;
  if (changed) {
    // Un'app diversa: i vecchi token non valgono più.
    dropAllSessions();
    cfg.token = null;
    cfg.accounts = [];
    resetConnections();
  }
  save();
  notify();
}

const AUTH_TTL = 15 * 60_000;

export function startAuth(redirectUri) {
  if (!cfg.clientId) throw new Error("Inserisci prima Client ID e Client Secret.");
  pendingAuth = { redirectUri, at: Date.now(), state: crypto.randomBytes(16).toString("base64url") };
  return authorizationUrl({ clientId: cfg.clientId, redirectUri, state: pendingAuth.state });
}

/** Il "state" ricevuto corrisponde all'ultimo «Collega cTrader» ancora valido (non scaduto, non già usato)? */
export function pendingStateMatches(state) {
  const want = pendingAuth?.state;
  if (!want || typeof state !== "string" || Date.now() - pendingAuth.at > AUTH_TTL) return false;
  const a = Buffer.from(state);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Completa l'accesso con il codice ricevuto da cTrader (dal ritorno automatico o incollato dall'utente).
 * Dal ritorno automatico arriva anche lo "state": se c'è deve essere quello giusto, e vale una volta sola.
 */
export async function finishAuth(code, redirectUri, { state } = {}) {
  if (state != null) {
    const ok = pendingStateMatches(String(state));
    if (pendingAuth) pendingAuth.state = null; // usato: non vale una seconda volta
    if (!ok) throw new Error("Questo collegamento non corrisponde all'ultima richiesta (o è già stato usato): premi di nuovo «Collega cTrader».");
  }
  if (!code) throw new Error("Codice di accesso mancante.");
  const uri = redirectUri ?? pendingAuth?.redirectUri;
  if (!uri) throw new Error("Premi prima «Collega cTrader».");
  if (!pendingAuth || Date.now() - pendingAuth.at > AUTH_TTL) throw new Error("Accesso scaduto: premi di nuovo «Collega cTrader».");
  let token;
  try {
    token = await exchangeCode({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: uri, code });
  } catch (err) {
    if (/Impossibile raggiungere/.test(err.message)) throw err;
    // Il codice vale circa un minuto e una sola volta.
    throw new Error(`${err.message}. Premi di nuovo «Collega cTrader» e completa l'accesso subito (il codice scade dopo circa un minuto); se succede ancora, ricontrolla Client ID e Secret.`);
  }
  pendingAuth = null;
  cfg.token = token;
  refreshRetryAt = 0;
  save();
  dropAllSessions();
  await refreshAccounts();
  lastError = null;
  refreshError = null;
  notify();
  return status();
}

export function unlink() {
  dropAllSessions();
  cfg.token = null;
  cfg.accounts = [];
  cfg.dataAccountId = null;
  resetConnections();
  save();
  notify();
}

export function setDataAccount(id) {
  if (!account(id)) throw new Error("Conto non trovato.");
  cfg.dataAccountId = account(id).ctidTraderAccountId;
  save();
  notify();
}

async function ensureToken() {
  if (!cfg.token?.accessToken) throw new Error("cTrader non collegato: premi «Collega cTrader» nella sezione Broker.");
  if (cfg.token.expiresAt - Date.now() >= 2 * 86_400_000 || Date.now() < refreshRetryAt) return;
  try {
    await refresh();
  } catch (err) {
    // Rinnovo anticipato non riuscito: finché il token vale ancora si continua a usarlo
    // (così si possono sempre chiudere le posizioni), e si riprova tra qualche minuto.
    refreshRetryAt = Date.now() + 5 * 60_000;
    if (cfg.token.expiresAt <= Date.now()) throw err;
  }
}

/** Rinnova i token; il nuovo refresh token viene salvato subito (quello vecchio non vale più). */
function refresh() {
  refreshing ??= (async () => {
    try {
      const t = await refreshTokens({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, refreshToken: cfg.token.refreshToken });
      cfg.token = { ...t, refreshToken: t.refreshToken ?? cfg.token.refreshToken };
      refreshRetryAt = 0;
      save();
      // Con il nuovo token il server chiude le sessioni dei conti: si rifanno accesso e abbonamenti ai prezzi.
      dropAllSessions();
      lastRefreshAt = Date.now();
      lastError = null;
      refreshError = null;
      notify();
    } catch (err) {
      refreshError = `Rinnovo dell'accesso non riuscito: ${err.message}. Premi di nuovo «Collega cTrader».`;
      notify();
      throw new Error(refreshError);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ---------- connessioni ----------

let lastRefreshAt = 0;

function resetConnections() {
  for (const env of ["demo", "live"]) conns[env]?.close();
}

/** Dimentica la sessione di un conto (autorizzazione e prezzi in abbonamento): al prossimo uso si rifà tutto. */
function dropAccountSession(id) {
  for (const k of [...accountReady.keys()]) if (k.endsWith(`:${id}`)) accountReady.delete(k);
  subscribed.delete(String(id));
  for (const k of [...spots.keys()]) if (k.startsWith(`${id}:`)) spots.delete(k);
}
function dropAllSessions() {
  accountReady.clear();
  subscribed.clear();
  spots.clear();
  cache.clear();
  candleCache.clear();
}

function onClosed(env) {
  ready[env] = null;
  for (const key of [...accountReady.keys()]) {
    if (key.startsWith(`${env}:`)) dropAccountSession(key.slice(env.length + 1));
  }
  // Conti di questo ambiente anche se non hanno ancora un'autorizzazione registrata
  for (const id of [...subscribed.keys()]) if (envOf.get(id) === env) dropAccountSession(id);
  notify();
}

function onMessage(env, msg) {
  const d = msg.data;
  switch (msg.name) {
    case "ProtoOASpotEvent": {
      const key = `${d.ctidTraderAccountId}:${d.symbolId}`;
      const prev = spots.get(key) ?? {};
      // bid o ask possono mancare: si tiene l'ultimo valore noto.
      spots.set(key, { bid: d.bid ?? prev.bid, ask: d.ask ?? prev.ask, at: Date.now() });
      break;
    }
    case "ProtoOAExecutionEvent":
      for (const fn of execListeners) fn(d);
      notify();
      break;
    case "ProtoOAAccountsTokenInvalidatedEvent":
      for (const id of d.ctidTraderAccountIds ?? []) dropAccountSession(id);
      // Dopo un nostro rinnovo è normale: le sessioni si rifanno da sole con il nuovo token.
      if (Date.now() - lastRefreshAt > 60_000) lastError = `cTrader ha invalidato l'accesso${d.reason ? ` (${d.reason})` : ""}.`;
      notify();
      break;
    case "ProtoOAAccountDisconnectEvent":
      dropAccountSession(d.ctidTraderAccountId);
      break;
    case "ProtoOAClientDisconnectEvent":
      lastError = `cTrader ha chiuso la connessione${d.reason ? `: ${d.reason}` : ""}.`;
      notify();
      break;
  }
}

function connection(env) {
  ready[env] ??= (async () => {
    if (!cfg.clientId || !cfg.clientSecret) throw new Error("Inserisci prima Client ID e Client Secret dell'app cTrader.");
    let c = conns[env];
    if (!c) {
      c = conns[env] = new Connection(env);
      c.on("message", (m) => onMessage(env, m));
      c.on("close", () => onClosed(env));
      c.on("warning", () => {});
    }
    await c.connect();
    try {
      await c.request("ProtoOAApplicationAuthReq", { clientId: cfg.clientId, clientSecret: cfg.clientSecret });
    } catch (err) {
      if (err.code !== "CH_CLIENT_ALREADY_AUTHENTICATED") throw err;
    }
    lastError = null;
    notify();
    return c;
  })().catch((err) => {
    ready[env] = null;
    lastError = friendly(err).message;
    notify();
    throw friendly(err);
  });
  return ready[env];
}

async function accountConnection(id) {
  await ensureToken();
  const acc = account(id);
  if (!acc) throw new Error("Conto cTrader non trovato: aggiorna l'elenco dei conti nella sezione Broker.");
  const env = acc.isLive ? "live" : "demo";
  const c = await connection(env);
  const key = `${env}:${acc.ctidTraderAccountId}`;
  envOf.set(String(acc.ctidTraderAccountId), env);
  if (!accountReady.has(key)) {
    const p = c
      .request("ProtoOAAccountAuthReq", { ctidTraderAccountId: Number(acc.ctidTraderAccountId), accessToken: cfg.token.accessToken })
      .then(
        () => {
          // Accesso al conto riuscito: l'avviso di accesso invalidato non vale più.
          if (lastError?.startsWith("cTrader ha invalidato")) {
            lastError = null;
            notify();
          }
        },
        (err) => {
          if (err.code === "ALREADY_LOGGED_IN") return;
          accountReady.delete(key);
          throw err;
        },
      );
    accountReady.set(key, p);
  }
  await accountReady.get(key);
  return c;
}

/**
 * Richiesta per un conto, con rinnovo dell'accesso e attesa sui limiti di velocità.
 * opts.guard (facoltativo) viene richiamato subito prima di ogni invio: se lancia un errore la richiesta non parte.
 */
async function call(id, name, fields = {}, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      // Un errore nel collegarsi al conto non riguarda la richiesta: non è mai stata inviata.
      const c = await accountConnection(id).catch((e) => {
        if (e?.sent) e.sent = false;
        throw e;
      });
      opts.guard?.();
      return await c.request(name, { ctidTraderAccountId: Number(id), ...fields }, opts);
    } catch (err) {
      if (attempt < 2 && err instanceof CTraderError) {
        if (TOKEN_ERRORS.has(err.code)) {
          await refresh();
          continue;
        }
        if (RATE_ERRORS.has(err.code)) {
          await sleep(Math.min(Number(err.retryAfter) || 1, 30) * 1000);
          continue;
        }
        if (err.code === "ACCOUNT_NOT_AUTHORIZED") {
          for (const k of [...accountReady.keys()]) if (k.endsWith(`:${id}`)) accountReady.delete(k);
          continue;
        }
      }
      throw friendly(err);
    }
  }
}

// ---------- conti ----------

export async function refreshAccounts() {
  await ensureToken();
  const c = await connection("demo");
  let res;
  try {
    res = await c.request("ProtoOAGetAccountListByAccessTokenReq", { accessToken: cfg.token.accessToken });
  } catch (err) {
    throw friendly(err);
  }
  cfg.scope = res.data.permissionScope ?? null;
  cfg.accounts = (res.data.ctidTraderAccount ?? []).map((a) => ({
    ctidTraderAccountId: a.ctidTraderAccountId,
    isLive: Boolean(a.isLive),
    traderLogin: a.traderLogin ?? null,
    broker: a.brokerTitleShort ?? "",
  }));
  save();
  notify();
  return cfg.accounts;
}

async function assets(id) {
  const c = symbolsCache(id);
  if (!c.assets) {
    const res = await call(id, "ProtoOAAssetListReq");
    c.assets = new Map((res.data.asset ?? []).map((a) => [a.assetId, a.displayName || a.name]));
  }
  return c.assets;
}

/** Saldo, valuta, leva e tipo di conto. */
export async function accountInfo(id) {
  const res = await call(id, "ProtoOATraderReq");
  const t = res.data.trader;
  const digits = t.moneyDigits ?? 2;
  const currency = (await assets(id)).get(t.depositAssetId) ?? "";
  return {
    id: t.ctidTraderAccountId,
    login: t.traderLogin ?? account(id)?.traderLogin,
    isLive: account(id)?.isLive ?? false,
    broker: t.brokerName || account(id)?.broker,
    balance: t.balance / 10 ** digits,
    currency,
    leverage: t.leverageInCents ? t.leverageInCents / 100 : null,
    accountType: t.accountType ?? "HEDGED",
    balanceVersion: t.balanceVersion ?? null,
  };
}

/** Depositi e prelievi veri (non swap, commissioni o dividendi): non vanno scambiati per guadagni o perdite. */
const CASH_TYPES = /^BALANCE_(DEPOSIT|WITHDRAW)(_TRANSFER|_TO_SUBACCOUNT|_FROM_SUBACCOUNT|_FOR_SUBACCOUNT)?$/;

/** Movimenti di denaro tra due istanti (massimo una settimana): [{ amount, balanceVersion, at }]. */
export async function cashFlows(id, fromTimestamp, toTimestamp = Date.now()) {
  const from = Math.max(Math.round(fromTimestamp), toTimestamp - 7 * 86_400_000 + 1000);
  const res = await call(id, "ProtoOACashFlowHistoryListReq", { fromTimestamp: from, toTimestamp: Math.round(toTimestamp) });
  return (res.data.depositWithdraw ?? [])
    .filter((dw) => CASH_TYPES.test(String(dw.operationType ?? "")))
    .map((dw) => ({
      amount: (Math.abs(Number(dw.delta) || 0) / 10 ** (dw.moneyDigits ?? 2)) * (String(dw.operationType).includes("WITHDRAW") ? -1 : 1),
      balanceVersion: dw.balanceVersion ?? null,
      at: dw.changeBalanceTimestamp ?? null,
    }));
}

const WEEK = 7 * 86_400_000;
const dealCache = new Map();
/** Dopo una chiusura fatta dall'app lo storico si rilegge subito. */
export const forgetDeals = () => dealCache.clear();

/**
 * Operazioni chiuse (deal di chiusura) degli ultimi `days` giorni, dalla più recente: per ogni chiusura mercato, lato
 * della posizione, lotti chiusi, prezzo di entrata e di uscita, risultato lordo, swap, commissioni e netto nella valuta
 * del conto, saldo dopo. cTrader dà al massimo una settimana per richiesta: si chiede una settimana alla volta.
 */
export async function closedDeals(id, { days = 30 } = {}) {
  const key = `${id}:${days}`;
  const hit = dealCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const now = Date.now();
  const start = now - Math.min(Math.max(Number(days) || 30, 1), 365) * 86_400_000;
  const deals = [];
  for (let to = now; to > start; to -= WEEK) {
    const from = Math.max(start, to - WEEK + 1);
    const res = await call(id, "ProtoOADealListReq", { fromTimestamp: Math.round(from), toTimestamp: Math.round(to), maxRows: 1000 });
    deals.push(...(res.data.deal ?? []));
  }
  const { list: symbols } = await symbolList(id);
  const nameOf = new Map(symbols.map((s) => [String(s.symbolId), s.symbolName]));
  // Quando è stata aperta ogni posizione (se il deal di apertura è nel periodo).
  const openedAt = new Map();
  for (const d of deals) {
    if (d.closePositionDetail) continue;
    const t = Number(d.executionTimestamp) || null;
    const k = String(d.positionId);
    if (t && (!openedAt.has(k) || t < openedAt.get(k))) openedAt.set(k, t);
  }
  const out = [];
  for (const d of deals) {
    const c = d.closePositionDetail;
    if (!c || !/FILLED/.test(String(d.dealStatus ?? "FILLED"))) continue;
    const m = 10 ** (c.moneyDigits ?? d.moneyDigits ?? 2);
    const det = await details(id, d.symbolId).catch(() => null);
    const gross = Number(c.grossProfit ?? 0) / m;
    const swap = Number(c.swap ?? 0) / m;
    const commission = Number(c.commission ?? 0) / m;
    const fee = Number(c.pnlConversionFee ?? 0) / m;
    out.push({
      dealId: d.dealId,
      positionId: d.positionId,
      symbol: nameOf.get(String(d.symbolId)) ?? String(d.symbolId),
      side: d.tradeSide === "SELL" ? "buy" : "sell", // il deal di chiusura va al contrario della posizione
      lots: det?.lotSize ? round(Number(c.closedVolume ?? d.filledVolume ?? 0) / det.lotSize, 4) : null,
      entryPrice: c.entryPrice ?? null,
      closePrice: d.executionPrice ?? null,
      openedAt: openedAt.has(String(d.positionId)) ? new Date(openedAt.get(String(d.positionId))).toISOString() : null,
      closedAt: new Date(Number(d.executionTimestamp)).toISOString(),
      gross: round(gross, 2),
      swap: round(swap, 2),
      commission: round(commission, 2),
      net: round(gross + swap + commission + fee, 2),
      balance: round(Number(c.balance ?? 0) / m, 2),
    });
  }
  out.sort((a, b) => b.closedAt.localeCompare(a.closedAt));
  dealCache.set(key, { at: Date.now(), list: out });
  return out;
}

/** Prezzi e distanze del protocollo: multipli di 10^(5 - digits) (es. oro con 2 decimali → multipli di 1000). */
export function priceStep(d) {
  return 10 ** Math.max(0, 5 - (d.digits ?? 5));
}

/** Controlla quantità e strumento di un ordine senza inviarlo; restituisce il nome dello strumento sul broker. */
export async function validateOrder(id, symbol, lots) {
  const s = await findSymbol(id, symbol);
  lotsToVolume(lots, await details(id, s.symbolId));
  return s.symbolName;
}

// ---------- strumenti e prezzi ----------

function symbolsCache(id) {
  const key = String(id);
  if (!cache.has(key)) cache.set(key, { details: new Map() });
  return cache.get(key);
}

async function symbolList(id) {
  const c = symbolsCache(id);
  if (!c.list || Date.now() - c.loadedAt > 3_600_000) {
    const res = await call(id, "ProtoOASymbolsListReq", { includeArchivedSymbols: false });
    c.list = (res.data.symbol ?? []).filter((s) => s.enabled !== false && s.symbolName);
    c.byNorm = new Map(c.list.map((s) => [norm(s.symbolName), s]));
    c.loadedAt = Date.now();
  }
  return c;
}

/**
 * Tutti gli strumenti del conto con categoria e classe (Forex, Metalli, Indici…), come nell'elenco di cTrader.
 * Per lo scanner dei mercati: [{ symbol, description, category, assetClass }] nell'ordine del broker.
 */
export async function catalog(id) {
  const c = await symbolList(id);
  if (!c.categories || Date.now() - c.categoriesAt > 3_600_000) {
    const [cats, classes] = await Promise.all([
      call(id, "ProtoOASymbolCategoryListReq").then((r) => r.data.symbolCategory ?? []).catch(() => []),
      call(id, "ProtoOAAssetClassListReq").then((r) => r.data.assetClass ?? []).catch(() => []),
    ]);
    const classById = new Map(classes.map((a) => [String(a.id), a.name ?? ""]));
    c.categories = new Map(cats.map((k) => [String(k.id), { name: k.name ?? "", assetClass: classById.get(String(k.assetClassId)) ?? "" }]));
    c.categoriesAt = Date.now();
  }
  return [...c.list]
    .sort((a, b) => (a.sortingNumber ?? 1e9) - (b.sortingNumber ?? 1e9))
    .map((s) => {
      const k = c.categories.get(String(s.symbolCategoryId)) ?? { name: "", assetClass: "" };
      return { symbol: s.symbolName, description: s.description ?? "", category: k.name, assetClass: k.assetClass };
    });
}

export async function findSymbol(id, name) {
  const c = await symbolList(id);
  const s = c.byNorm.get(norm(name));
  if (!s) throw new Error(`Lo strumento "${name}" non esiste su questo conto cTrader: cercalo con search_symbols (es. EURUSD, XAUUSD, US500).`);
  return s;
}

export async function hasSymbol(id, name) {
  try {
    return Boolean((await symbolList(id)).byNorm.get(norm(name)));
  } catch {
    return false;
  }
}

export async function search(id, query, limit = 20) {
  const q = norm(query);
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const c = await symbolList(id);
  return c.list
    .filter((s) => norm(s.symbolName).includes(q) || words.every((w) => (s.description ?? "").toLowerCase().includes(w)))
    .sort((a, b) => (a.sortingNumber ?? 1e9) - (b.sortingNumber ?? 1e9))
    .slice(0, limit)
    .map((s) => ({ symbol: s.symbolName, description: s.description ?? "" }));
}

async function details(id, symbolId) {
  const c = symbolsCache(id);
  if (!c.details.has(symbolId)) {
    const res = await call(id, "ProtoOASymbolByIdReq", { symbolId: [symbolId] });
    const d = res.data.symbol?.[0];
    if (!d) throw new Error("Dettagli dello strumento non disponibili.");
    c.details.set(symbolId, d);
  }
  return c.details.get(symbolId);
}

async function subscribe(id, symbolId) {
  const key = String(id);
  const set = subscribed.get(key) ?? new Set();
  subscribed.set(key, set);
  if (set.has(symbolId)) return;
  set.add(symbolId);
  try {
    await call(id, "ProtoOASubscribeSpotsReq", { symbolId: [symbolId] });
  } catch (err) {
    if (err.code === "ALREADY_SUBSCRIBED") return;
    set.delete(symbolId);
    throw err;
  }
}

async function waitSpot(key, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const s = spots.get(key);
    if (s && (s.bid != null || s.ask != null)) return s;
    if (Date.now() > end) throw new Error("Nessun prezzo ricevuto da cTrader per questo strumento (mercato chiuso o strumento non quotato?).");
    await sleep(100);
  }
}

/** Ultimo prezzo (denaro/lettera) e variazione rispetto alla chiusura del giorno prima. */
export async function quote(id, name) {
  const s = await findSymbol(id, name);
  await subscribe(id, s.symbolId);
  const spot = await waitSpot(`${id}:${s.symbolId}`, 6000);
  const d = await details(id, s.symbolId);
  const bid = spot.bid != null ? spot.bid / PRICE : null;
  const ask = spot.ask != null ? spot.ask / PRICE : null;
  const price = bid != null && ask != null ? (bid + ask) / 2 : (bid ?? ask);
  let changePct = null;
  try {
    const bars = await candles(id, name, "D1", 10);
    const today = new Date().toISOString().slice(0, 10);
    const prev = bars.filter((b) => b.date < today).at(-1);
    if (prev) changePct = round(((price - prev.close) / prev.close) * 100, 2);
  } catch {
    /* la variazione è facoltativa */
  }
  return {
    symbol: s.symbolName,
    description: s.description ?? "",
    price: round(price, d.digits),
    bid: round(bid, d.digits),
    ask: round(ask, d.digits),
    spread: bid != null && ask != null ? round(ask - bid, d.digits) : null,
    changePct,
    date: new Date(spot.at).toISOString(),
    source: account(id)?.isLive ? "ctrader-live" : "ctrader-demo",
  };
}

const candleCache = new Map();
// Intervalli massimi per richiesta (come negli esempi ufficiali di Spotware); se il server li rifiuta si dimezzano.
const MAX_WINDOW = { M1: 302_400_000, M5: 302_400_000, M15: 21_168_000_000, M30: 21_168_000_000, H1: 21_168_000_000, H4: 31_622_400_000, D1: 31_622_400_000, W1: 158_112_000_000 };

/** Candele storiche: period M1, M5, M15, M30, H1, H4, D1, W1. */
export async function candles(id, name, period = "D1", count = 200) {
  if (!PERIOD_MS[period]) throw new Error(`Periodo non valido: ${period}. Usa ${Object.keys(PERIOD_MS).join(", ")}.`);
  const s = await findSymbol(id, name);
  const key = `${id}:${s.symbolId}:${period}:${count}`;
  const hit = candleCache.get(key);
  const ttl = Math.min(PERIOD_MS[period], 300_000);
  if (hit && Date.now() - hit.at < ttl) return hit.bars;
  const to = Date.now();
  // Finestra larga (il server restituisce al massimo `count` candele, le più recenti prima di toTimestamp):
  // così ci stanno anche weekend, festivi e strumenti con poche ore di contrattazione al giorno.
  let span = Math.min(MAX_WINDOW[period], PERIOD_MS[period] * count * 4 + 4 * 86_400_000);
  let res;
  for (let i = 0; ; i++) {
    try {
      res = await call(id, "ProtoOAGetTrendbarsReq", { fromTimestamp: Math.max(0, Math.round(to - span)), toTimestamp: to, period, symbolId: s.symbolId, count });
      break;
    } catch (err) {
      if (err.code === "INCORRECT_BOUNDARIES" && i < 4) {
        span /= 2; // intervallo troppo lungo per questo periodo: si riduce
        continue;
      }
      throw err;
    }
  }
  const bars = (res.data.trendbar ?? [])
    .map((b) => {
      const low = b.low ?? 0;
      const time = (b.utcTimestampInMinutes ?? 0) * 60_000;
      return {
        time,
        date: new Date(time).toISOString().slice(0, 10),
        open: (low + (b.deltaOpen ?? 0)) / PRICE,
        high: (low + (b.deltaHigh ?? 0)) / PRICE,
        low: low / PRICE,
        close: (low + (b.deltaClose ?? 0)) / PRICE,
        volume: b.volume ?? 0,
      };
    })
    .sort((a, b) => a.time - b.time)
    .slice(-count);
  candleCache.set(key, { at: Date.now(), bars });
  return bars;
}

// ---------- posizioni e ordini ----------

/** Converte lotti nel volume del protocollo (centesimi di unità), rispettando minimo, massimo e passo. */
export function lotsToVolume(lots, d) {
  if (!d.lotSize) throw new Error("Il broker non indica la dimensione del lotto per questo strumento.");
  const step = d.stepVolume || 1;
  const volume = Math.floor(Math.round(Number(lots) * d.lotSize) / step) * step;
  if (!(volume > 0) || (d.minVolume && volume < d.minVolume)) {
    throw new Error(`Quantità troppo piccola: il minimo per questo strumento è ${d.minVolume / d.lotSize} lotti.`);
  }
  if (d.maxVolume && volume > d.maxVolume) throw new Error(`Quantità troppo grande: il massimo è ${d.maxVolume / d.lotSize} lotti.`);
  return volume;
}

/** Posizioni aperte. Con requirePnl il P&L è obbligatorio (serve al controllo della perdita del giorno). */
export async function positions(id, { requirePnl = false } = {}) {
  const res = await call(id, "ProtoOAReconcileReq", {});
  const list = res.data.position ?? [];
  let pnl = new Map();
  if (list.length) {
    try {
      const r = await call(id, "ProtoOAGetPositionUnrealizedPnLReq");
      const digits = r.data.moneyDigits ?? 2;
      pnl = new Map((r.data.positionUnrealizedPnL ?? []).map((p) => [p.positionId, p.netUnrealizedPnL / 10 ** digits]));
    } catch (err) {
      if (requirePnl) throw new Error(`P&L delle posizioni non disponibile: ${friendly(err).message}`);
    }
    if (requirePnl && list.some((p) => !pnl.has(p.positionId))) throw new Error("P&L delle posizioni non disponibile.");
  }
  const { list: symbols } = await symbolList(id);
  const nameOf = new Map(symbols.map((s) => [s.symbolId, s.symbolName]));
  const out = [];
  for (const p of list) {
    const t = p.tradeData;
    const d = await details(id, t.symbolId);
    out.push({
      positionId: p.positionId,
      symbol: nameOf.get(t.symbolId) ?? String(t.symbolId),
      side: t.tradeSide === "SELL" ? "sell" : "buy",
      lots: d.lotSize ? round(t.volume / d.lotSize, 4) : null,
      units: t.volume / 100,
      volume: t.volume,
      price: p.price ?? null,
      stopLoss: p.stopLoss ?? null,
      takeProfit: p.takeProfit ?? null,
      label: t.label ?? "",
      comment: t.comment ?? "",
      openedAt: t.openTimestamp ? new Date(t.openTimestamp).toISOString() : null,
      pnl: pnl.has(p.positionId) ? round(pnl.get(p.positionId), 2) : null,
    });
  }
  return out;
}

/** Aspetta l'esecuzione (FILLED) di un ordine; gli eventi possono arrivare prima della risposta. */
function executionWatcher(id) {
  const events = [];
  const fn = (d) => String(d.ctidTraderAccountId) === String(id) && events.push(d);
  execListeners.add(fn);
  return {
    async waitFill(orderId, positionId, ms = 15_000) {
      const mine = (e) => (orderId ? e.order?.orderId === orderId : positionId && e.position?.positionId === positionId);
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const related = events.filter(mine);
        const filled = related.find((e) => e.executionType === "ORDER_FILLED" || e.executionType === "ORDER_PARTIAL_FILL");
        if (filled) return filled;
        const bad = related.find((e) => ["ORDER_REJECTED", "ORDER_CANCELLED", "ORDER_EXPIRED"].includes(e.executionType));
        if (bad) {
          const why = bad.errorCode ? ` (${ITALIAN[bad.errorCode] ?? bad.errorCode})` : "";
          throw new Error(`Ordine ${bad.executionType === "ORDER_REJECTED" ? "rifiutato" : "annullato"} da cTrader${why}.`);
        }
        await sleep(100);
      }
      return null; // accettato ma esecuzione non ancora confermata
    },
    stop: () => execListeners.delete(fn),
  };
}

/**
 * Ordine a mercato. stopLossPct/takeProfitPct sono distanze in % dal prezzo attuale.
 * label identifica chi ha aperto la posizione (es. "agenti:trader").
 */
export async function placeOrder(id, { symbol, side, lots, stopLossPct, takeProfitPct, label, comment, guard }) {
  const s = await findSymbol(id, symbol);
  const d = await details(id, s.symbolId);
  const volume = lotsToVolume(lots, d);
  const q = await quote(id, symbol);
  const ref = side === "buy" ? (q.ask ?? q.price) : (q.bid ?? q.price);
  const fields = {
    symbolId: s.symbolId,
    orderType: "MARKET",
    tradeSide: side === "buy" ? "BUY" : "SELL",
    volume,
    label: String(label ?? "agenti").slice(0, 100),
    comment: String(comment ?? "").slice(0, 512),
  };
  // Su ordini a mercato cTrader accetta solo SL/TP "relativi": distanza in 1/100000 di prezzo,
  // arrotondata ai decimali dello strumento (altrimenti "invalid precision").
  const step = priceStep(d);
  const rel = (pct) => Math.max(step, Math.round(((ref * pct) / 100) * PRICE / step) * step);
  if (stopLossPct > 0) fields.relativeStopLoss = rel(stopLossPct);
  if (takeProfitPct > 0) fields.relativeTakeProfit = rel(takeProfitPct);

  const watch = executionWatcher(id);
  try {
    let res;
    try {
      res = await call(id, "ProtoOANewOrderReq", fields, { timeoutMs: 30_000, guard });
    } catch (err) {
      // Ordine inviato ma risposta persa (linea caduta o attesa scaduta): potrebbe essere stato eseguito.
      if (err.sent && !err.code && err.request === "ProtoOANewOrderReq") {
        const e = new Error("Esito dell'ordine incerto (connessione interrotta): controlla le posizioni aperte in Broker prima di riprovare.");
        e.uncertain = true;
        throw e;
      }
      throw err;
    }
    const ev = res.data;
    const filled =
      ev.executionType === "ORDER_FILLED" || ev.executionType === "ORDER_PARTIAL_FILL"
        ? ev
        : await watch.waitFill(ev.order?.orderId, ev.position?.positionId);
    const final = filled ?? ev;
    return {
      status: filled ? "filled" : "accepted",
      orderId: final.order?.orderId ?? null,
      positionId: final.position?.positionId ?? null,
      symbol: s.symbolName,
      side,
      lots: round(volume / d.lotSize, 4),
      units: volume / 100,
      price: final.deal?.executionPrice ?? final.position?.price ?? ref,
      stopLoss: final.position?.stopLoss ?? null,
      takeProfit: final.position?.takeProfit ?? null,
      source: q.source,
    };
  } finally {
    watch.stop();
  }
}

export async function closePosition(id, positionId, lots) {
  const all = await positions(id);
  const p = all.find((x) => String(x.positionId) === String(positionId));
  if (!p) throw new Error("Posizione non trovata (forse è già stata chiusa).");
  let volume = p.volume;
  if (lots) {
    const s = await findSymbol(id, p.symbol);
    volume = Math.min(p.volume, lotsToVolume(lots, await details(id, s.symbolId)));
  }
  const watch = executionWatcher(id);
  try {
    const res = await call(id, "ProtoOAClosePositionReq", { positionId: Number(p.positionId), volume }, { timeoutMs: 30_000 });
    const ev = res.data;
    const filled = ev.executionType === "ORDER_FILLED" ? ev : await watch.waitFill(ev.order?.orderId, p.positionId);
    return {
      status: filled ? "closed" : "accepted",
      positionId: p.positionId,
      symbol: p.symbol,
      lots: p.lots && volume !== p.volume ? round((p.lots * volume) / p.volume, 4) : p.lots,
      price: filled?.deal?.executionPrice ?? null,
    };
  } finally {
    watch.stop();
  }
}

/** Chiude tutte le posizioni aperte dagli agenti (etichetta che inizia con "agenti") su un conto. */
export async function closeAgentPositions(id) {
  const results = [];
  for (const p of await positions(id)) {
    if (!p.label.startsWith("agenti")) continue;
    try {
      results.push(await closePosition(id, p.positionId));
    } catch (err) {
      results.push({ positionId: p.positionId, symbol: p.symbol, error: err.message });
    }
  }
  return results;
}
