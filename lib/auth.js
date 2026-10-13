// Accesso con password, per l'app sul server in cloud (o con APP_PASSWORD). Sul Mac, senza password, non serve.
// - La password sta solo nella variabile APP_PASSWORD del servizio di hosting: qui se ne tiene l'impronta scrypt.
// - Chi entra riceve un cookie con un codice casuale; in data/auth.json si salva solo l'impronta (sha256) del
//   codice, così le sessioni sopravvivono ai riavvii ma una copia del file non basta per entrare.
// - Tentativi sbagliati: dopo 10 in un'ora ogni tentativo aspetta sempre di più (mai un blocco definitivo);
//   dietro un proxy noto (TRUST_PROXY) c'è anche un limite per indirizzo: 5 errori in 15 minuti.
import crypto from "node:crypto";
import path from "node:path";
import { DATA_DIR } from "./paths.js";
import { writeFileAtomic, readJsonSafe } from "./files.js";
import { log } from "./store.js";
import { AUTH_ENABLED, APP_PASSWORD, COOKIE_NAME, HTTPS, TRUST_PROXY, FAIL_CLOSED } from "./env.js";

const FILE = path.join(DATA_DIR, "auth.json");
// scrypt: N=2^15, r=8 → circa 32 MB di memoria e qualche decina di millisecondi per ogni controllo.
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;
const SESSION_MS = 60 * 86_400_000; // 60 giorni, rinnovati a ogni uso
const SLIDE_EVERY_MS = 60 * 60_000; // il rinnovo si salva al massimo una volta l'ora per sessione
const MAX_SESSIONS = 50;

const GLOBAL_WINDOW = 60 * 60_000;
const GLOBAL_FREE = 10; // errori in un'ora prima delle attese
const MAX_DELAY = 30_000;
const MAX_QUEUE = 50;
const IP_WINDOW = 15 * 60_000;
const IP_MAX = 5;

let data = { password: null, sessions: {} };
let key = null; // { salt, hash } della password attuale

const digest = (token) => crypto.createHash("sha256").update(token).digest("hex");
const normalizePw = (pw) => String(pw).normalize("NFC");

function scrypt(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(normalizePw(password), salt, KEYLEN, SCRYPT, (err, k) => (err ? reject(err) : resolve(k))),
  );
}

// ---------- file data/auth.json ----------

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  writeFileAtomic(FILE, JSON.stringify(data, null, 1), { mode: 0o600 });
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1000);
}
process.on("exit", () => saveTimer && save());

function prune() {
  const now = Date.now();
  const entries = Object.entries(data.sessions).filter(([, s]) => s?.expires > now);
  entries.sort((a, b) => b[1].lastSeen - a[1].lastSeen);
  data.sessions = Object.fromEntries(entries.slice(0, MAX_SESSIONS));
}

/** All'avvio: impronta della password e sessioni salvate. Se APP_PASSWORD è cambiata, tutti rifanno l'accesso. */
function init() {
  if (!AUTH_ENABLED || FAIL_CLOSED) return;
  const loaded = readJsonSafe(FILE);
  if (loaded.corrupt) log("accesso", "warn", `Il file auth.json era rovinato (messo da parte): tutti i dispositivi devono rifare l'accesso.`);
  const stored = loaded.data?.password;
  let same = false;
  if (stored?.salt && stored?.hash && stored.N === SCRYPT.N && stored.r === SCRYPT.r && stored.p === SCRYPT.p) {
    const h = crypto.scryptSync(normalizePw(APP_PASSWORD), Buffer.from(stored.salt, "base64"), KEYLEN, SCRYPT);
    const want = Buffer.from(stored.hash, "base64");
    same = want.length === h.length && crypto.timingSafeEqual(h, want);
  }
  if (same) {
    data = { password: stored, sessions: { ...(loaded.data.sessions ?? {}) } };
    prune();
  } else {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(normalizePw(APP_PASSWORD), salt, KEYLEN, SCRYPT);
    data = {
      password: { algo: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64"), hash: hash.toString("base64") },
      sessions: {},
    };
    if (stored) log("accesso", "warn", "La password dell'app è cambiata: tutti i dispositivi devono rifare l'accesso.");
  }
  key = { salt: Buffer.from(data.password.salt, "base64"), hash: Buffer.from(data.password.hash, "base64") };
  save();
}
init();

// ---------- cookie e sessioni ----------

/** Legge l'intestazione Cookie (senza librerie). */
export function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(value, maxAgeMs) {
  return [`${COOKIE_NAME}=${value}`, `Max-Age=${Math.floor(maxAgeMs / 1000)}`, "Path=/", "HttpOnly", "SameSite=Lax", ...(HTTPS ? ["Secure"] : [])].join("; ");
}

/** Sessione valida della richiesta, oppure null. */
function sessionOf(req) {
  if (req._session !== undefined) return req._session;
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  let s = null;
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const id = digest(token);
    const rec = data.sessions[id];
    if (rec && rec.expires > Date.now()) s = { id, token, rec };
    else if (rec) {
      delete data.sessions[id];
      saveSoon();
    }
  }
  req._session = s;
  return s;
}

/** Scadenza "scorrevole": ogni uso sposta la scadenza a 60 giorni da adesso (e rinnova il cookie). */
function touch(s, res) {
  const now = Date.now();
  if (now - s.rec.lastSeen < SLIDE_EVERY_MS) return;
  s.rec.lastSeen = now;
  s.rec.expires = now + SESSION_MS;
  saveSoon();
  res.append("Set-Cookie", cookie(s.token, SESSION_MS));
}

function createSession(res) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  data.sessions[digest(token)] = { created: now, lastSeen: now, expires: now + SESSION_MS };
  prune();
  save();
  res.append("Set-Cookie", cookie(token, SESSION_MS));
}

/** La sessione della richiesta è ancora valida? (per la diretta SSE: uscita o scadenza chiudono il flusso) */
export function sessionAlive(req) {
  if (!AUTH_ENABLED) return true;
  const s = req._session;
  return Boolean(s && data.sessions[s.id]?.expires > Date.now());
}

export const isLoggedIn = (req) => !AUTH_ENABLED || Boolean(sessionOf(req));

// ---------- tentativi e limiti ----------

const ipFails = new Map(); // indirizzo -> [istanti degli errori]
const inFlight = new Map(); // indirizzo -> controlli in corso
// Due "corsie" separate: i tentativi di accesso (anche di sconosciuti) non rallentano né bloccano le conferme con
// password di chi è già dentro (sblocco del conto reale, importazione…), e viceversa.
const newLane = () => ({ fails: [], queue: Promise.resolve(), queued: 0, nextAt: 0 });
const lanes = { login: newLane(), stepUp: newLane() };

/** Indirizzo di chi si collega: quello vero solo se il proxy davanti all'app è noto (TRUST_PROXY). */
const clientIp = (req) => (TRUST_PROXY != null ? req.ip : req.socket?.remoteAddress) ?? "?";

function ipRetryAfter(ip) {
  if (TRUST_PROXY == null) return 0; // senza proxy noto tutti sembrerebbero lo stesso indirizzo
  const now = Date.now();
  const list = (ipFails.get(ip) ?? []).filter((t) => now - t < IP_WINDOW);
  if (list.length) ipFails.set(ip, list);
  else ipFails.delete(ip);
  if (list.length < IP_MAX) return 0;
  return Math.max(1, Math.ceil((list[list.length - IP_MAX] + IP_WINDOW - now) / 1000));
}

function globalDelay(lane) {
  const now = Date.now();
  lane.fails = lane.fails.filter((t) => now - t < GLOBAL_WINDOW);
  const extra = lane.fails.length - GLOBAL_FREE;
  return extra < 0 ? 0 : Math.min(1000 * 2 ** extra, MAX_DELAY);
}

function recordFailure(lane, ip, what) {
  const now = Date.now();
  lane.fails.push(now);
  lane.nextAt = now + globalDelay(lane); // dopo troppi errori il tentativo successivo aspetta (senza fare la fila)
  if (TRUST_PROXY != null) {
    ipFails.set(ip, [...(ipFails.get(ip) ?? []), now]);
    if (ipFails.size > 10_000) for (const k of ipFails.keys()) if (ipRetryAfter(k) === 0) ipFails.delete(k);
  }
  const n = lane.fails.filter((t) => now - t < GLOBAL_WINDOW).length;
  const text = `${what}: password sbagliata (indirizzo ${ip}; errori nell'ultima ora: ${n})`;
  // Nel registro dell'app solo i primi errori dell'ora, per non spingere fuori le righe del trading.
  if (n <= 5) log("accesso", "warn", text);
  else console.log(`${new Date().toISOString()} [warn] accesso: ${text}`);
}

async function verify(password) {
  if (!key || typeof password !== "string" || !password || password.length > 1024) {
    await scrypt("x", crypto.randomBytes(16)); // stesso tempo di una password vera
    return false;
  }
  const h = await scrypt(password, key.salt);
  return crypto.timingSafeEqual(h, key.hash);
}

/** Forme da provare: un testo (dal corpo JSON) oppure le forme di headerPassword(); mai un elenco scelto da chi scrive. */
const formsOf = (password) =>
  typeof password === "string" ? [password] : Array.isArray(password?.forms) ? password.forms.slice(0, 3) : [];

/**
 * Controlla una password: un tentativo alla volta per corsia, con le attese se ci sono stati troppi errori.
 * Le forme di headerPassword() (com'è scritta e decodificata) contano come un solo tentativo.
 * Restituisce { ok } oppure { limited, retryAfter } (secondi).
 */
async function checkPassword(password, ip, what, laneName = "login") {
  const lane = lanes[laneName];
  const wait = ipRetryAfter(ip);
  if (wait) return { ok: false, limited: true, retryAfter: wait };
  // Con un proxy noto, un solo controllo alla volta per indirizzo: tanti tentativi insieme non superano il limite.
  if (TRUST_PROXY != null && inFlight.get(ip)) return { ok: false, limited: true, retryAfter: 5 };
  // Niente file d'attesa: dopo troppi errori si risponde subito «riprova tra poco» finché l'attesa non è passata,
  // e anche i tentativi già in corso contano, così una raffica non tiene ferma per minuti una password giusta.
  const now = Date.now();
  if (now < lane.nextAt) return { ok: false, limited: true, retryAfter: Math.ceil((lane.nextAt - now) / 1000) };
  const pending = lane.fails.filter((t) => now - t < GLOBAL_WINDOW).length + lane.queued;
  if (lane.queued >= (pending >= GLOBAL_FREE ? 1 : MAX_QUEUE)) return { ok: false, limited: true, retryAfter: Math.max(1, Math.ceil(globalDelay(lane) / 1000)) };
  lane.queued++;
  inFlight.set(ip, (inFlight.get(ip) ?? 0) + 1);
  const run = lane.queue.then(async () => {
    try {
      const forms = formsOf(password);
      let ok = false;
      for (const p of forms.length ? forms : [null]) if (!ok) ok = await verify(p);
      if (ok) ipFails.delete(ip);
      else recordFailure(lane, ip, what);
      return ok;
    } finally {
      lane.queued--;
      const n = (inFlight.get(ip) ?? 1) - 1;
      if (n > 0) inFlight.set(ip, n);
      else inFlight.delete(ip);
    }
  });
  lane.queue = run.catch(() => false);
  return { ok: await run };
}

function tooMany(res, retryAfter, extra = {}) {
  const min = Math.max(1, Math.ceil(retryAfter / 60));
  const when = retryAfter < 60 ? `${retryAfter} ${retryAfter === 1 ? "secondo" : "secondi"}` : `${min} ${min === 1 ? "minuto" : "minuti"}`;
  res.set("Retry-After", String(retryAfter));
  return res.status(429).json({ error: `Troppi tentativi: riprova tra ${when}`, retryAfter, ...extra });
}

/**
 * Password arrivata in un'intestazione HTTP (es. X-Agenti-Password): le intestazioni non possono contenere
 * caratteri come € o le emoji, quindi l'interfaccia può mandarla codificata (encodeURIComponent).
 * Si provano la forma ricevuta e quella decodificata.
 */
export function headerPassword(value) {
  if (typeof value !== "string" || !value) return { forms: [] };
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    /* non codificata */
  }
  // Le intestazioni arrivano come latin1: una password con lettere accentate mandata così com'è va riletta in UTF-8.
  const utf8 = Buffer.from(value, "latin1").toString("utf8");
  return { forms: [...new Set([value, decoded, utf8])].filter(Boolean) };
}

/** Password scritta in un modulo (corpo JSON): vale solo un testo, non un elenco di tentativi. */
export const bodyPassword = (req) => (typeof req.body?.password === "string" ? req.body.password : "");

// ---------- pagine e richieste ----------

/** Dove tornare dopo l'accesso: solo un percorso di questo sito ("/…"), mai un altro sito. */
export function safeNext(next) {
  const s = typeof next === "string" ? next : "";
  if (!s.startsWith("/") || s.startsWith("//") || s.length > 2000 || /[\\\u0000-\u001f\u007f]/.test(s)) return "/";
  if (/^\/login(?:[?#/.]|$)/.test(s)) return "/";
  try {
    const u = new URL(s, "http://app.invalid");
    // "/.//sito.it" diventa "//sito.it" (indirizzo di un altro sito): si restituisce solo la forma già normalizzata.
    if (u.origin !== "http://app.invalid" || u.pathname.startsWith("//")) return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}

// Raggiungibili senza aver fatto l'accesso (pagina di accesso, icone e file dell'app installabile).
const PUBLIC_GET = new Set(["/login", "/login.js", "/manifest.webmanifest", "/sw.js", "/offline.html", "/favicon.ico", "/healthz", "/api/session"]);
const PUBLIC_POST = new Set(["/api/login", "/api/logout"]);
export function isPublic(req) {
  const p = req.path;
  if (req.method === "GET" || req.method === "HEAD") return PUBLIC_GET.has(p) || (/^\/icons\/[A-Za-z0-9_.-]+$/.test(p) && !p.includes(".."));
  return req.method === "POST" && PUBLIC_POST.has(p);
}

/**
 * Middleware: senza sessione valida le richieste /api/* ricevono 401, le pagine vanno a /login?next=….
 * allow(req) permette eccezioni (es. il ritorno da cTrader con lo "state" giusto).
 */
export function requireSession({ allow } = {}) {
  return (req, res, next) => {
    if (!AUTH_ENABLED) return next();
    const s = sessionOf(req);
    if (s) {
      touch(s, res);
      return next();
    }
    if (isPublic(req) || allow?.(req)) return next();
    if (req.path === "/api" || req.path.startsWith("/api/") || (req.method !== "GET" && req.method !== "HEAD")) {
      return res.status(401).json({ error: "Accesso richiesto", login: true });
    }
    res.redirect(302, `/login?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
  };
}

/** POST /api/login {password} */
export async function login(req, res) {
  if (!AUTH_ENABLED) return res.json({ ok: true });
  const ip = clientIp(req);
  const r = await checkPassword(bodyPassword(req), ip, "Accesso");
  if (r.limited) return tooMany(res, r.retryAfter);
  if (!r.ok) return res.status(401).json({ error: "Password sbagliata" });
  createSession(res);
  log("accesso", "info", `Accesso riuscito (indirizzo ${ip}).`);
  res.json({ ok: true });
}

/** POST /api/logout: chiude la sessione di questo dispositivo. */
export function logout(req, res) {
  const s = AUTH_ENABLED ? sessionOf(req) : null;
  if (s) {
    delete data.sessions[s.id];
    save();
    log("accesso", "info", "Uscita da un dispositivo.");
  }
  res.append("Set-Cookie", cookie("", 0));
  res.json({ ok: true });
}

/**
 * Middleware: per le azioni delicate (sbloccare il conto reale, cancellare i dati, importare una copia)
 * si richiede di nuovo la password. when(req) dice se serve; password(req) dove leggerla.
 */
export function requireStepUp({ when = () => true, password }) {
  return async (req, res, next) => {
    if (!AUTH_ENABLED || !when(req)) return next();
    const pw = password(req);
    if (!formsOf(pw).some(Boolean)) return res.status(401).json({ error: "Password sbagliata", stepUp: true });
    const r = await checkPassword(pw, clientIp(req), `Conferma con password (${req.method} ${req.path})`, "stepUp");
    if (r.limited) return tooMany(res, r.retryAfter, { stepUp: true });
    if (!r.ok) return res.status(401).json({ error: "Password sbagliata", stepUp: true });
    next();
  };
}
