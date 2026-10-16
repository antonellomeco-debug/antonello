// Social collegati: credenziali delle app, accessi agli account, post proposti dagli agenti, approvazioni,
// pubblicazione (subito o all'ora scelta) e statistiche. Dati in <dati>/social.json.
// Sicurezza: collegare un account e attivare la pubblicazione senza approvazione si fa solo dall'interfaccia
// (né Orion né gli agenti possono farlo); ogni social ha un massimo di post al giorno.
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "../paths.js";
import { PUBLIC_URL, PORT } from "../env.js";
import { writeFileAtomic, readJsonSafe } from "../files.js";
import { addApproval, updateApproval, getState, log, addCost, bus } from "../store.js";
import { romeParts } from "../schedule.js";
import { NETWORKS, NETWORK_IDS, PROVIDERS, pkcePair, hasLink, xLength, COSTS } from "./networks.js";
import * as media from "./media.js";
import { aiStatus } from "./imagegen.js";
import { stockStatus } from "./stock.js";

const FILE = path.join(DATA_DIR, "social.json");
export const SOCIAL_REDIRECT_URI = `${PUBLIC_URL ?? `http://localhost:${PORT}`}/social/callback`;
const DEFAULT_MAX = { instagram: 3, threads: 5, linkedin: 2, x: 5 };
const MAX_POSTS_KEPT = 300;

let data = load();
function load() {
  const r = readJsonSafe(FILE);
  const d = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : {};
  const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
  return { apps: obj(d.apps), accounts: obj(d.accounts), settings: obj(d.settings), posts: Array.isArray(d.posts) ? d.posts.filter((p) => p && p.id) : [] };
}
function save() {
  writeFileAtomic(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}
const changed = () => bus.emit("event", { type: "social" });

function assertNetwork(net) {
  if (!NETWORK_IDS.includes(net)) throw new Error(`social sconosciuto "${net}": usa ${NETWORK_IDS.join(", ")}`);
  return net;
}
const settingsOf = (net) => ({ auto: false, maxPerDay: DEFAULT_MAX[net], ...(data.settings[net] ?? {}) });
const label = (net) => NETWORKS[net].label;

// ---------- stato ----------

function accountState(net) {
  const a = data.accounts[net];
  if (!a) return null;
  const msLeft = a.expiresAt ? Date.parse(a.expiresAt) - Date.now() : Infinity;
  const renewable = net !== "linkedin" || a.refreshToken;
  return {
    username: a.username,
    connectedAt: a.connectedAt,
    expiresAt: a.expiresAt ?? null,
    expired: msLeft <= 0 && !(net === "x" && a.refreshToken),
    expiresSoon: !renewable && msLeft < 10 * 86400_000,
    problem: a.problem ?? null,
  };
}

const MAX_REPLIES_PER_DAY = 30;
const isReply = (p) => Boolean(p.replyTo || p.replyToPost);
/** Post usciti oggi (ora italiana) su un social: i post veri e propri, oppure (replies) le risposte. */
function todayCount(net, { replies = false } = {}) {
  const today = romeParts().date;
  return data.posts.filter(
    (p) =>
      p.network === net &&
      isReply(p) === replies &&
      ["published", "publishing", "uncertain"].includes(p.status) &&
      romeParts(new Date(p.publishedAt ?? p.startedAt ?? p.at)).date === today,
  ).length;
}

/** Stato completo per l'interfaccia (mai i segreti). */
export function socialStatus() {
  return {
    redirectUri: SOCIAL_REDIRECT_URI,
    publicServer: Boolean(PUBLIC_URL),
    networks: NETWORK_IDS.map((net) => {
      const app = data.apps[net];
      return {
        id: net,
        ...NETWORKS[net],
        app: app?.clientId ? { clientId: app.clientId, hasSecret: Boolean(app.clientSecret) } : null,
        account: accountState(net),
        ...settingsOf(net),
        today: todayCount(net),
      };
    }),
    ai: aiStatus(),
    stock: stockStatus(),
    media: media.mediaUsage(),
    posts: data.posts.slice(-60).reverse().map(postView),
  };
}

/** Riassunto per gli agenti e per Orion. */
export function statusForAgents() {
  return {
    social: NETWORK_IDS.map((net) => {
      const acc = accountState(net);
      const s = settingsOf(net);
      return {
        network: net,
        collegato: acc ? (acc.expired ? "accesso scaduto: l'utente deve ricollegarlo" : `sì, come ${acc.username}`) : "no",
        pubblicazione: !acc
          ? "a mano: i post vanno in Approvazioni e l'utente li pubblica lui con un tocco (niente risposte ai commenti, niente statistiche)"
          : s.auto ? "automatica" : "con approvazione dell'utente",
        post_oggi: `${todayCount(net)} su ${s.maxPerDay} al giorno`,
        testo_max: NETWORKS[net].maxText,
      };
    }),
    immagini_ia: aiStatus().configured ? "attive (generate_image)" : "non attive (usa create_graphic)",
    repertorio: stockStatus().configured ? "attivo (stock_search, stock_add)" : "non attivo: l'utente deve mettere la chiave di Pixabay o di Pexels",
    note:
      "X costa 0,015 $ a post e 0,20 $ se il testo contiene un link (metti i link solo se indispensabili). " +
      "Instagram e Threads vogliono foto/video dall'archivio e funzionano solo con il server online. LinkedIn: solo pubblicazione, niente statistiche.",
    post_recenti: data.posts.slice(-15).reverse().map((p) => ({
      post_id: p.id,
      id_social: p.remoteId ?? null,
      network: p.network,
      stato: p.status,
      quando: p.publishedAt ?? p.publishAt ?? p.at,
      risponde_a: p.replyToPost ?? p.replyTo ?? null,
      testo: p.text.slice(0, 100),
      link: p.url ?? null,
      errore: p.error ?? null,
    })),
  };
}

// ---------- app e accesso ----------

export function setApp(net, { clientId, clientSecret } = {}) {
  assertNetwork(net);
  const id = String(clientId ?? "").trim();
  const secret = String(clientSecret ?? "").trim();
  if (!id) {
    delete data.apps[net];
    delete data.accounts[net];
  } else {
    if (!/^[\w.~-]{4,200}$/.test(id)) throw new Error("Il Client ID (o App ID) non sembra giusto: copialo di nuovo.");
    const old = data.apps[net];
    data.apps[net] = { clientId: id, clientSecret: secret || (old?.clientId === id ? old.clientSecret : "") };
    if (old?.clientId && old.clientId !== id) delete data.accounts[net];
  }
  save();
  changed();
  return socialStatus();
}

const pending = new Map(); // state → { net, verifier, at }

export function startAuth(net) {
  assertNetwork(net);
  const app = data.apps[net];
  if (!app?.clientId) throw new Error(`Prima inserisci le credenziali dell'app di ${label(net)}.`);
  if (!app.clientSecret && net !== "x") throw new Error(`Manca il Secret dell'app di ${label(net)}.`);
  if (NETWORKS[net].needsPublicMedia && !PUBLIC_URL) throw new Error(`${label(net)} si collega solo dal server online (vuole un indirizzo https): fallo dall'app sul server.`);
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60_000) pending.delete(k);
  const state = crypto.randomBytes(24).toString("base64url");
  const { verifier, challenge } = pkcePair();
  pending.set(state, { net, verifier, at: Date.now() });
  return { url: PROVIDERS[net].authUrl({ clientId: app.clientId, redirectUri: SOCIAL_REDIRECT_URI, state, challenge }) };
}

export const pendingStateMatches = (state) => Boolean(state) && pending.has(state);
export const pendingCancel = (state) => pending.delete(state);

export async function finishAuth(state, code) {
  const p = pending.get(state);
  if (!p) throw new Error("Collegamento scaduto o già usato: premi di nuovo «Collega» nell'app.");
  pending.delete(state);
  if (!code) throw new Error("Il social non ha mandato il codice di accesso.");
  const app = data.apps[p.net];
  const acc = await PROVIDERS[p.net].connect(app, code, SOCIAL_REDIRECT_URI, p.verifier);
  if (acc.cost) addCost(acc.cost);
  delete acc.cost;
  data.accounts[p.net] = { ...acc, connectedAt: new Date().toISOString() };
  save();
  changed();
  log("social", "info", `${label(p.net)} collegato come ${acc.username}.`);
  return { network: p.net, username: acc.username };
}

export function disconnect(net) {
  assertNetwork(net);
  delete data.accounts[net];
  save();
  changed();
  log("social", "info", `${label(net)} scollegato.`);
  return socialStatus();
}

/** Solo dall'interfaccia: pubblicazione automatica e massimo di post al giorno. */
export function setNetworkSettings(net, { auto, maxPerDay } = {}) {
  assertNetwork(net);
  const s = settingsOf(net);
  if (auto !== undefined) s.auto = Boolean(auto);
  if (maxPerDay !== undefined) {
    const n = Number(maxPerDay);
    if (!Number.isInteger(n) || n < 0 || n > 50) throw new Error("Post al giorno: un numero da 0 a 50.");
    s.maxPerDay = n;
  }
  data.settings[net] = s;
  save();
  changed();
  if (auto !== undefined) log("social", "info", `${label(net)}: pubblicazione ${s.auto ? "AUTOMATICA (senza approvazione)" : "con approvazione"}.`);
  return socialStatus();
}

const refreshing = new Map();
/** Rinnova il codice di accesso quando serve (X ogni 2 ore, Instagram e Threads prima dei 60 giorni). */
async function account(net) {
  const acc = data.accounts[net];
  if (!acc) throw new Error(`${label(net)} non è collegato: l'utente deve collegarlo da 📣 Social.`);
  const left = acc.expiresAt ? Date.parse(acc.expiresAt) - Date.now() : Infinity;
  const age = Date.now() - Date.parse(acc.refreshedAt ?? acc.connectedAt ?? 0);
  const due = net === "x" ? left < 5 * 60_000 : (net === "instagram" || net === "threads") ? left < 20 * 86400_000 && age > 24 * 3600_000 : left < 86400_000;
  if (due) {
    if (!refreshing.has(net)) {
      refreshing.set(net, (async () => {
        try {
          const patch = await PROVIDERS[net].refresh(data.apps[net] ?? {}, acc);
          if (patch) {
            Object.assign(acc, patch, { problem: null });
            save();
            changed();
          }
        } catch (err) {
          acc.problem = `Rinnovo dell'accesso non riuscito: ${err.message}`;
          save();
          changed();
          if (left <= 0) throw new Error(`${label(net)}: accesso scaduto, l'utente deve ricollegarlo da 📣 Social (${err.message}).`);
        } finally {
          refreshing.delete(net);
        }
      })());
    }
    await refreshing.get(net);
  }
  if (acc.expiresAt && Date.parse(acc.expiresAt) <= Date.now()) throw new Error(`${label(net)}: accesso scaduto, l'utente deve ricollegarlo da 📣 Social.`);
  return acc;
}

/** Ogni ora: rinnova per tempo i codici di Instagram e Threads anche se nessuno pubblica. */
export async function refreshTokens() {
  for (const net of Object.keys(data.accounts)) {
    if (net === "x") continue;
    await account(net).catch(() => {});
  }
}

// ---------- post ----------

/** Gli id scelti dagli agenti finiscono negli indirizzi delle API: solo lettere, numeri, _ e -. */
function safeId(v, field) {
  const id = String(v).trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error(`${field}: id non valido (usa l'id che trovi in social_stats, social_comments o social_status)`);
  return id;
}

/** "AAAA-MM-GG HH:MM" in ora italiana → Date. */
export function parseRomeTime(s) {
  const m = String(s ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) throw new Error('publish_at: scrivi data e ora italiana come "2026-10-16 18:30"');
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const r = romeParts(new Date(guess));
    const [ry, rmo, rd] = r.date.split("-").map(Number);
    const shown = Date.UTC(ry, rmo - 1, rd, Math.floor(r.minutes / 60), r.minutes % 60);
    guess += Date.UTC(y, mo - 1, d, h, mi) - shown;
  }
  const check = romeParts(new Date(guess));
  const want = `${m[1]}-${m[2]}-${m[3]} ${String(h).padStart(2, "0")}:${m[5]}`;
  if (`${check.date} ${check.time}` !== want) throw new Error(`publish_at: "${s}" non è una data e ora valida in Italia`);
  return new Date(guess);
}

function postView(p) {
  return {
    id: p.id,
    network: p.network,
    text: p.text,
    format: p.format ?? null,
    replyTo: p.replyTo ?? p.replyToPost ?? null,
    media: (p.media ?? []).map((id) => {
      try {
        return media.publicInfo(media.getMedia(id));
      } catch {
        return { id, missing: true };
      }
    }),
    status: p.status,
    agentName: p.agentName ?? null,
    reason: p.reason ?? "",
    at: p.at,
    publishAt: p.publishAt ?? null,
    publishedAt: p.publishedAt ?? null,
    url: p.url ?? null,
    error: p.error ?? null,
    approvalId: p.approvalId ?? null,
    manual: Boolean(p.manual),
  };
}

function setPost(p, patch) {
  Object.assign(p, patch);
  data.posts = data.posts.slice(-MAX_POSTS_KEPT);
  save();
  if (p.approvalId) {
    const st = { pending: "pending", rejected: "rejected", scheduled: "scheduled", publishing: "executing", published: "executed", failed: "failed", uncertain: "uncertain", cancelled: "rejected" }[p.status];
    const a = getState().approvals.find((x) => x.id === p.approvalId);
    if (a && st && a.status !== st) updateApproval(p.approvalId, { status: st, post: postView(p), error: p.error ?? undefined });
  }
  changed();
}

/** Controlli prima di proporre o pubblicare: testo, file e formato giusti per quel social. */
function checkPost(net, { text, mediaIds, format, replyTo }) {
  const max = NETWORKS[net].maxText;
  if (!text && !mediaIds.length) throw new Error("serve un testo o almeno un file");
  const len = net === "x" ? xLength(text) : [...text].length;
  if (len > max) throw new Error(`testo troppo lungo per ${label(net)}: ${len} caratteri${net === "x" ? " (come li conta X: link 23, emoji 2)" : ""}, massimo ${max}`);
  const items = mediaIds.map((id) => media.getMedia(id));
  const audio = items.find((m) => m.kind === "audio");
  if (audio) throw new Error(`${audio.id} è una musica: si usa dentro i video (create_video con music), non da sola in un post`);
  if (net === "instagram" && !replyTo && !items.length) throw new Error("su Instagram serve almeno una foto o un video dall'archivio (media_list, create_graphic o generate_image)");
  if (net === "x" && !text.trim() && !items.length) throw new Error("su X serve un testo");
  if (format === "story" && net !== "instagram") throw new Error("le storie esistono solo su Instagram");
  if (replyTo && items.length && net === "instagram") throw new Error("le risposte ai commenti di Instagram sono solo testo");
  return items;
}

/** Un agente propone un post (o lo pubblica subito se l'utente ha attivato la pubblicazione automatica). */
export async function proposePost(agent, input = {}) {
  const net = assertNetwork(String(input.network ?? "").toLowerCase());
  // Social non collegato: il post va comunque in Approvazioni e l'utente lo pubblica a mano, con un tocco su
  // «📲 Condividi» (foto e testo pronti) e poi «Fatto». Le risposte ai commenti richiedono il collegamento.
  const manual = !data.accounts[net];
  if (manual && input.reply_to) throw new Error(`${label(net)} non è collegato: le risposte e i thread si possono fare solo con il collegamento. Pubblica post singoli.`);
  const text = String(input.text ?? "").trim();
  const mediaIds = [...new Set([].concat(input.media ?? []).map(String))];
  const format = input.format === "story" ? "story" : null;
  let replyTo = input.reply_to ? safeId(input.reply_to, "reply_to") : null;
  // Thread su X o Threads: si può rispondere a un proprio post (post_id restituito da social_publish) anche prima
  // che sia uscito: la risposta parte subito dopo.
  let replyToPost = null;
  const parent = replyTo && data.posts.find((x) => x.id === replyTo);
  if (parent) {
    if (parent.network !== net || !["threads", "x"].includes(net)) throw new Error("reply_to con un post_id vale solo per i thread su Threads e su X, nello stesso social");
    replyToPost = parent.id;
    replyTo = null;
  }
  checkPost(net, { text, mediaIds, format, replyTo });
  let publishAt = null;
  if (input.publish_at) {
    const d = parseRomeTime(input.publish_at);
    if (d.getTime() > Date.now() + 60_000) {
      if (d.getTime() > Date.now() + 30 * 86400_000) throw new Error("publish_at: al massimo tra 30 giorni");
      publishAt = d.toISOString();
    }
  }
  const s = settingsOf(net);
  if (s.maxPerDay === 0) throw new Error(`${label(net)}: l'utente ha messo 0 post al giorno (pubblicazione ferma).`);
  const p = {
    id: `p${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`,
    network: net, text, media: mediaIds, format, replyTo, replyToPost, publishAt,
    reason: String(input.reason ?? "").slice(0, 500),
    agentId: agent.id, agentName: agent.name,
    at: new Date().toISOString(),
    status: "pending",
    ...(manual ? { manual: true } : {}),
  };
  data.posts.push(p);
  const costNote = net === "x" ? ` Costo su X: ${hasLink(text) ? "0,20 $ (contiene un link)" : "0,015 $"}.` : "";
  if (s.auto && !manual) {
    if (publishAt) {
      setPost(p, { status: "scheduled" });
      return { status: "scheduled", post_id: p.id, publish_at: input.publish_at, message: `Programmato: verrà pubblicato su ${label(net)} all'ora indicata.${costNote}` };
    }
    await publishPost(p);
    if (p.status === "published") return { status: "published", post_id: p.id, social_id: p.remoteId, url: p.url, message: `Pubblicato su ${label(net)}.${costNote}` };
    if (p.status === "scheduled") return { status: "scheduled", post_id: p.id, message: "Uscirà appena è pubblicato il post a cui risponde." };
    throw new Error(`pubblicazione su ${label(net)} non riuscita: ${p.error}`);
  }
  const a = addApproval({ ...agent, target: { mode: "social", network: net, label: label(net) } }, null, { kind: "post", postId: p.id, post: postView(p) });
  setPost(p, { approvalId: a.id });
  if (manual) {
    return {
      status: "pending_manual",
      post_id: p.id,
      message: `${label(net)} non è collegato: il post è in ✅ Approvazioni e l'utente lo pubblica a mano con un tocco${publishAt ? " (gli ricordiamo l'ora consigliata)" : ""}.`,
    };
  }
  return {
    status: "pending_approval",
    post_id: p.id,
    message: `Post proposto: aspetta l'approvazione dell'utente in ✅ Approvazioni${publishAt ? " (poi partirà all'ora indicata)" : ""}.${costNote}`,
  };
}

/** Decisione dell'utente su un post proposto. */
export async function decidePost(approvalId, approve) {
  const a = getState().approvals.find((x) => x.id === approvalId);
  const p = data.posts.find((x) => x.id === a?.postId);
  if (!a || !p) throw new Error("Proposta non trovata");
  if (p.status !== "pending") throw new Error("Proposta già decisa");
  if (!approve) {
    setPost(p, { status: "rejected", decidedAt: new Date().toISOString() });
    return getState().approvals.find((x) => x.id === approvalId);
  }
  if (p.manual) {
    // L'utente l'ha pubblicato lui (con «📲 Condividi») e ha premuto «Fatto».
    media.markUsed(p.media ?? [], `${label(p.network)} ${new Date().toISOString().slice(0, 10)}`);
    setPost(p, { status: "published", publishedAt: new Date().toISOString(), decidedAt: new Date().toISOString() });
    log(p.agentId ?? "social", "info", `Pubblicato a mano su ${label(p.network)}.`);
    return getState().approvals.find((x) => x.id === approvalId);
  }
  if (p.publishAt && Date.parse(p.publishAt) > Date.now() + 30_000) setPost(p, { status: "scheduled", decidedAt: new Date().toISOString() });
  // Si risponde subito: un video può richiedere molti minuti e il telefono non deve aspettare. Il post è già
  // "in pubblicazione" quando publishPost torna la prima volta (nessuno può più scartarlo o annullarlo).
  else track(publishPost(p));
  return getState().approvals.find((x) => x.id === approvalId);
}

const running = new Set();
function track(promise) {
  const pr = promise.catch((err) => log("social", "error", `Pubblicazione: ${err.message}`)).finally(() => running.delete(pr));
  running.add(pr);
}
/** Aspetta le pubblicazioni partite in sottofondo (per le prove e per una chiusura ordinata). */
export async function whenIdle() {
  while (running.size) await Promise.all([...running]);
}

/** Annulla un post programmato (dall'interfaccia). */
export function cancelPost(id) {
  const p = data.posts.find((x) => x.id === id);
  if (!p) throw new Error("Post non trovato");
  if ((p.status !== "scheduled" && p.status !== "pending") || inFlight.has(p.id)) throw new Error("Si possono annullare solo i post in attesa o programmati.");
  setPost(p, { status: "cancelled" });
  return postView(p);
}

const inFlight = new Set();
/**
 * Pubblica un post. Tutti i controlli e il passaggio a "in pubblicazione" avvengono prima della prima attesa:
 * due approvazioni ravvicinate, uno Scarta o un Annulla nel frattempo non possono far partire post in più.
 */
async function publishPost(p) {
  if (inFlight.has(p.id) || !["pending", "scheduled"].includes(p.status)) return;
  inFlight.add(p.id);
  try {
    const net = p.network;
    const s = settingsOf(net);
    if (p.replyToPost) {
      const parent = data.posts.find((x) => x.id === p.replyToPost);
      if (!parent || ["failed", "rejected", "cancelled", "uncertain"].includes(parent.status)) {
        setPost(p, { status: "failed", error: "il post a cui rispondere non è uscito" });
        return;
      }
      if (parent.status !== "published" || !parent.remoteId) {
        // Si aspetta il post precedente del thread (al massimo un giorno).
        const since = p.waitingSince ?? new Date().toISOString();
        if (Date.now() - Date.parse(since) > 86400_000) setPost(p, { status: "failed", error: "il post a cui rispondere non è uscito entro un giorno" });
        else setPost(p, { status: "scheduled", publishAt: new Date(Math.max(Date.now() + 30_000, Date.parse(parent.publishAt ?? 0) || 0)).toISOString(), waitingSince: since });
        return;
      }
      p.replyTo = parent.remoteId;
    }
    if (isReply(p) ? todayCount(net, { replies: true }) >= MAX_REPLIES_PER_DAY : todayCount(net) >= s.maxPerDay) {
      setPost(p, {
        status: "failed",
        error: isReply(p)
          ? `limite di ${MAX_REPLIES_PER_DAY} risposte al giorno su ${label(net)} già raggiunto`
          : `limite di ${s.maxPerDay} post al giorno su ${label(net)} già raggiunto (si cambia in 📣 Social)`,
      });
      return;
    }
    setPost(p, { status: "publishing", startedAt: new Date().toISOString(), sending: false });
    let acc;
    let files;
    try {
      acc = await account(net);
      checkPost(net, { text: p.text, mediaIds: p.media ?? [], format: p.format, replyTo: p.replyTo });
      files = await media.forPublishing(p.media ?? [], { network: net, format: p.format });
      if (NETWORKS[net].needsPublicMedia && files.some((f) => !f.url)) throw new Error(`${label(net)} scarica i file da un indirizzo pubblico: funziona solo con il server online`);
    } catch (err) {
      setPost(p, { status: "failed", error: err.message });
      return;
    }
    setPost(p, { sending: true });
    try {
      const r = await PROVIDERS[net].publish(acc, p, files);
      if (r.cost) addCost(r.cost);
      media.markUsed(p.media ?? [], `${label(net)} ${new Date().toISOString().slice(0, 10)}`);
      setPost(p, { status: "published", publishedAt: new Date().toISOString(), remoteId: r.id ?? null, url: r.url ?? null, error: null, sending: false });
      log(p.agentId ?? "social", "info", `Pubblicato su ${label(net)}${r.url ? `: ${r.url}` : ""}`);
    } catch (err) {
      // Errore di rete a metà: il post potrebbe essere uscito lo stesso.
      const status = err.network ? "uncertain" : "failed";
      setPost(p, { status, error: status === "uncertain" ? `risposta persa (${err.message}): controlla su ${label(net)} prima di riproporlo` : err.message });
      log(p.agentId ?? "social", "warn", `${label(net)}: pubblicazione non riuscita: ${err.message}`);
    }
  } finally {
    inFlight.delete(p.id);
  }
}

/** Ogni minuto: pubblica i post programmati arrivati all'ora giusta. */
export async function publishDue() {
  const due = data.posts.filter((p) => p.status === "scheduled" && Date.parse(p.publishAt ?? 0) <= Date.now());
  for (const p of due) await publishPost(p);
  return due.length;
}

/** All'avvio: post rimasti "in pubblicazione" perché il programma si è chiuso a metà. */
export function recoverInterruptedPosts() {
  for (const p of data.posts.filter((x) => x.status === "publishing")) {
    if (p.sending === false) setPost(p, { status: "failed", error: "il programma si è chiuso prima dell'invio: il post non è uscito, si può riproporre" });
    else setPost(p, { status: "uncertain", error: `il programma si è chiuso durante la pubblicazione: controlla su ${label(p.network)} prima di riproporlo` });
  }
}

// ---------- statistiche e commenti ----------

export async function stats(net, { limit } = {}) {
  assertNetwork(net);
  const acc = await account(net);
  const r = await PROVIDERS[net].stats(acc, { limit: Math.min(Math.max(Number(limit) || 10, 1), 20) });
  if (r.cost) addCost(r.cost);
  if (net === "x") r.nota_costo = `questa lettura è costata circa ${r.cost.toFixed(3)} $: non ripeterla spesso`;
  delete r.cost;
  return r;
}

export async function comments(net, postId) {
  assertNetwork(net);
  if (!postId) throw new Error("post_id: l'id del post (da social_stats)");
  postId = safeId(postId, "post_id");
  const acc = await account(net);
  const list = await PROVIDERS[net].comments(acc, String(postId));
  if (list.cost) addCost(list.cost);
  return { network: net, post_id: postId, comments: [...list] };
}

export { NETWORKS, NETWORK_IDS, COSTS };

/** Per le prove: rilegge il file. */
export function _reload() {
  data = load();
}
