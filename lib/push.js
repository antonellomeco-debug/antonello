// Notifiche sul telefono (Web Push): quando c'è qualcosa da approvare, una domanda di un agente, un post uscito o
// non riuscito. Sull'iPhone funzionano nell'app installata sulla schermata Home (iOS 16.4 o più recente).
// Le chiavi VAPID del server si creano alla prima richiesta e restano in <dati>/push.json (non entra nei backup:
// gli iscritti valgono solo per questo server). Più eventi in pochi secondi diventano una sola notifica.
import path from "node:path";
import { createRequire } from "node:module";
import { DATA_DIR } from "./paths.js";
import { PUBLIC_URL } from "./env.js";
import { writeFileAtomic, readJsonSafe } from "./files.js";
import { bus, getState, log } from "./store.js";

const require = createRequire(import.meta.url);
const webpush = require("web-push");

const FILE = path.join(DATA_DIR, "push.json");
const MAX_SUBS = 20;
const BATCH_MS = Number(process.env.PUSH_BATCH_MS) || 15_000;
// Servizi delle notifiche dei browser: il server manda richieste solo lì (mai a indirizzi qualsiasi).
const PUSH_HOSTS = [/(^|\.)push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
export const DEFAULT_PREFS = { approvals: true, published: true, replies: false, reports: true };

let data = load();
function load() {
  const r = readJsonSafe(FILE);
  const d = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : {};
  return {
    vapid: d.vapid?.publicKey && d.vapid?.privateKey ? d.vapid : null,
    subs: Array.isArray(d.subs) ? d.subs.filter((s) => s?.endpoint && s.keys?.p256dh && s.keys?.auth) : [],
    prefs: { ...DEFAULT_PREFS, ...(d.prefs && typeof d.prefs === "object" ? d.prefs : {}) },
  };
}
function save() {
  writeFileAtomic(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function vapid() {
  if (!data.vapid) {
    data.vapid = webpush.generateVAPIDKeys();
    save();
  }
  return data.vapid;
}
// Contatto richiesto dai servizi delle notifiche: l'indirizzo del server (https) o la pagina del progetto.
const subject = () => (PUBLIC_URL?.startsWith("https://") ? PUBLIC_URL : "https://github.com/antonellomeco-debug/antonello");

export function pushStatus() {
  return { publicKey: vapid().publicKey, devices: data.subs.map(({ endpoint, label, at }) => ({ endpoint, label, at })), prefs: data.prefs };
}

function allowedEndpoint(endpoint) {
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  const testPrefix = process.env.PUSH_TEST_ENDPOINT_PREFIX;
  if (testPrefix && endpoint.startsWith(testPrefix)) return true;
  return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

/** Iscrive questo dispositivo (dati da pushManager.subscribe nel browser). */
export function subscribe(sub, label = "") {
  const endpoint = String(sub?.endpoint ?? "");
  const keys = { p256dh: String(sub?.keys?.p256dh ?? ""), auth: String(sub?.keys?.auth ?? "") };
  if (!allowedEndpoint(endpoint)) throw new Error("Iscrizione alle notifiche non valida: riprova da Safari o dall'app installata.");
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(keys.auth)) throw new Error("Iscrizione alle notifiche non valida (chiavi).");
  const entry = { endpoint, keys, label: String(label).replace(/[^\p{L}\p{N} ._()-]/gu, "").slice(0, 40) || "dispositivo", at: new Date().toISOString() };
  data.subs = [...data.subs.filter((s) => s.endpoint !== endpoint), entry].slice(-MAX_SUBS);
  save();
  return pushStatus();
}

export function unsubscribe(endpoint) {
  data.subs = data.subs.filter((s) => s.endpoint !== String(endpoint ?? ""));
  save();
  return pushStatus();
}

/** Quali notifiche mandare (valgono per tutti i dispositivi). */
export function setPrefs(prefs = {}) {
  for (const k of Object.keys(DEFAULT_PREFS)) if (prefs[k] !== undefined) data.prefs[k] = Boolean(prefs[k]);
  save();
  return pushStatus();
}

/** Da approvare + domande aperte: il numerino sull'icona dell'app. */
function pendingCount() {
  const st = getState();
  return st.approvals.filter((a) => a.status === "pending").length + (st.requests ?? []).filter((r) => r.status === "open").length;
}

async function sendAll(payload) {
  if (!data.subs.length) return { sent: 0 };
  const body = JSON.stringify({ ...payload, badge: pendingCount() });
  const keys = vapid();
  let sent = 0;
  await Promise.all(
    data.subs.map(async (sub) => {
      try {
        const req = webpush.generateRequestDetails(sub, body, {
          vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 24 * 3600,
          urgency: payload.urgent ? "high" : "normal",
          ...(payload.tag ? { topic: String(payload.tag).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined } : {}),
        });
        const r = await fetch(req.endpoint, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(15_000) });
        if (r.status === 404 || r.status === 410) {
          data.subs = data.subs.filter((s) => s.endpoint !== sub.endpoint); // dispositivo disiscritto o app tolta
          save();
        } else if (!r.ok) {
          log("programma", "warn", `Notifica non consegnata (${sub.label}): risposta ${r.status}.`);
        } else sent++;
      } catch (err) {
        log("programma", "warn", `Notifica non consegnata (${sub.label}): ${err.message}`);
      }
    }),
  );
  return { sent };
}

/** Notifica di prova (pulsante nell'app). */
export function sendTest() {
  return sendAll({ title: "🔔 Notifiche attive", body: "Da ora ti avviso quando c'è qualcosa da approvare o quando esce un post.", url: "/", tag: "prova" });
}

// ---------- eventi → notifiche (raggruppate) ----------

const queues = { approvals: [], published: [], failed: [], reports: [] };
let timer = null;
const seenApprovals = new Set();
const seenRequests = new Set();
/** Quello che c'era già all'avvio non si notifica di nuovo. */
function seedSeen() {
  for (const a of getState().approvals) seenApprovals.add(a.id);
  for (const r of getState().requests ?? []) seenRequests.add(r.id);
}
seedSeen();
const short = (t, n = 110) => {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function queue(kind, item) {
  queues[kind].push(item);
  timer ??= setTimeout(flush, BATCH_MS);
  timer.unref?.();
}

export async function flush() {
  clearTimeout(timer);
  timer = null;
  const out = [];
  const a = queues.approvals.splice(0);
  if (a.length === 1) out.push({ ...a[0], url: "/#approvals", tag: "approvazioni", urgent: true });
  else if (a.length > 1) out.push({ title: `✅ ${a.length} cose da approvare`, body: a.map((x) => x.short).join(" · "), url: "/#approvals", tag: "approvazioni", urgent: true });
  const p = queues.published.splice(0);
  if (p.length === 1) out.push({ ...p[0], tag: "pubblicati" });
  else if (p.length > 1) out.push({ title: `📣 ${p.length} post pubblicati`, body: p.map((x) => x.short).join(" · "), url: "/#social", tag: "pubblicati" });
  const f = queues.failed.splice(0);
  if (f.length) out.push({ title: f.length === 1 ? f[0].title : `⚠️ ${f.length} post non pubblicati`, body: f.length === 1 ? f[0].body : f.map((x) => x.short).join(" · "), url: "/#social", tag: "errori", urgent: true });
  const r = queues.reports.splice(0);
  if (r.length === 1) out.push({ ...r[0], url: "/#costs", tag: "report" });
  else if (r.length > 1) out.push({ title: `📑 ${r.length} report delle spese`, body: r.map((x) => x.short).join(" · "), url: "/#costs", tag: "report" });
  for (const n of out) await sendAll(n);
  return out.length;
}

function onEvent(ev) {
  if (!data.subs.length) return;
  if (ev.type === "approval" && ev.approval?.status === "pending" && !seenApprovals.has(ev.approval.id)) {
    seenApprovals.add(ev.approval.id);
    if (!data.prefs.approvals) return;
    const ap = ev.approval;
    if (ap.kind === "post") {
      const where = ap.target?.label ?? ap.post?.network ?? "social";
      const what = ap.post?.replyTo ? "Risposta" : "Post";
      queue("approvals", { title: `✅ ${what} da approvare · ${where}`, body: `${ap.agentName}: ${short(ap.post?.text)}`, short: `${what} ${where}` });
    } else {
      const o = ap.order ?? {};
      const desc = [o.action === "close" ? "Chiusura" : o.side === "buy" ? "Acquisto" : o.side === "sell" ? "Vendita" : "Ordine", o.symbol, o.lots ? `${o.lots} lotti` : o.qty ? `${o.qty}` : ""].filter(Boolean).join(" ");
      queue("approvals", { title: "✅ Ordine da approvare", body: `${ap.agentName}: ${desc}`, short: desc });
    }
  } else if (ev.type === "request" && ev.request?.status === "open" && !seenRequests.has(ev.request.id)) {
    seenRequests.add(ev.request.id);
    if (!data.prefs.approvals) return;
    queue("approvals", { title: `❓ Domanda di ${ev.request.agentName}`, body: short(ev.request.text, 150), short: `domanda di ${ev.request.agentName}` });
  } else if (ev.type === "report" && ev.report) {
    if (!data.prefs.reports) return;
    const first = String(ev.report.text).replace(/^[\s*#]*REPORT SPESE[\s:—–-]*/i, "");
    queue("reports", { title: `📑 Report delle spese · ${ev.report.agentName}`, body: short(first, 150), short: ev.report.agentName });
  } else if (ev.type === "post-status" && !ev.manual) {
    if (ev.status === "published") {
      if (!(ev.reply ? data.prefs.replies : data.prefs.published)) return;
      queue("published", { title: `📣 ${ev.reply ? "Risposta pubblicata" : "Pubblicato"} su ${ev.label}`, body: short(ev.text) || "(senza testo)", url: ev.url || "/#social", short: ev.label });
    } else if (data.prefs.published) {
      queue("failed", { title: `⚠️ Non pubblicato su ${ev.label}`, body: short(ev.error || ev.text, 150), short: ev.label });
    }
  }
}
bus.on("event", onEvent);

/** Per le prove. */
export function _reload() {
  data = load();
  seenApprovals.clear();
  seenRequests.clear();
  seedSeen();
}
