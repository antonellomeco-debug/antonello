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
import { NETWORKS, NETWORK_IDS, PROVIDERS, pkcePair, hasLink, xLength, COSTS, youtubeTitle } from "./networks.js";
import * as media from "./media.js";
import { aiStatus } from "./imagegen.js";
import { stockStatus } from "./stock.js";
import { voiceStatus } from "./googletts.js";

const FILE = path.join(DATA_DIR, "social.json");
export const SOCIAL_REDIRECT_URI = `${PUBLIC_URL ?? `http://localhost:${PORT}`}/social/callback`;
const DEFAULT_MAX = { instagram: 3, threads: 5, linkedin: 2, x: 5, youtube: 5 };
// YouTube: copia automatica dei video usciti sugli altri social (le storie no: sono clip di pochi secondi), video
// pubblici, voce generata con IA dichiarata, testo fisso in fondo alla descrizione (link, newsletter…).
const YOUTUBE_DEFAULTS = { mirror: true, mirrorStories: false, privacy: "public", aiLabel: true, footer: "" };
const YT_PRIVACY = ["public", "unlisted", "private"];
// Le storie di Instagram hanno un massimo a parte: non tolgono posto ai Reel e ai caroselli del giorno.
const DEFAULT_MAX_STORIES = 5;
const MAX_POSTS_KEPT = 300;

let data = load();
function load() {
  const r = readJsonSafe(FILE);
  const d = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : {};
  const obj = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
  return { apps: obj(d.apps), accounts: obj(d.accounts), settings: obj(d.settings), posts: Array.isArray(d.posts) ? d.posts.filter((p) => p && p.id) : [], seen: obj(d.seen) };
}
function save() {
  writeFileAtomic(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}
const changed = () => bus.emit("event", { type: "social" });

function assertNetwork(net) {
  if (!NETWORK_IDS.includes(net)) throw new Error(`social sconosciuto "${net}": usa ${NETWORK_IDS.join(", ")}`);
  return net;
}
const settingsOf = (net) => ({ auto: false, maxPerDay: DEFAULT_MAX[net], ...(net === "instagram" ? { maxStoriesPerDay: DEFAULT_MAX_STORIES } : {}), ...(net === "youtube" ? YOUTUBE_DEFAULTS : {}), ...(data.settings[net] ?? {}) });
const label = (net) => NETWORKS[net].label;

// Pagina aziendale di LinkedIn: ogni post di LinkedIn esce anche lì (o solo lì). Pubblicare da soli su una pagina
// richiede il permesso w_organization_social (prodotto «Community Management API», approvato da LinkedIn): finché
// l'accesso non lo comprende, i post della pagina arrivano in Approvazioni e l'utente li pubblica a mano.
export const ORG_SCOPE = "w_organization_social";
function linkedinPage() {
  const s = settingsOf("linkedin");
  if (!s.pageId) return null;
  return { id: s.pageId, name: s.pageName || "pagina aziendale", only: Boolean(s.pageOnly), auto: Boolean(data.accounts.linkedin?.scopes?.includes(ORG_SCOPE)) };
}
const postLabel = (p) => (p.page ? `${label(p.network)} (pagina ${p.pageName || p.page})` : label(p.network));

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
    expired: msLeft <= 0 && !((net === "x" || net === "youtube") && a.refreshToken),
    expiresSoon: !renewable && msLeft < 10 * 86400_000,
    problem: a.problem ?? null,
  };
}

const MAX_REPLIES_PER_DAY = 30;
const isReply = (p) => Boolean(p.replyTo || p.replyToPost);
/** Post usciti oggi (ora italiana) su un social: i post veri e propri, oppure (replies) le risposte; page = sulla pagina
 * aziendale; story = le storie di Instagram, contate a parte. */
function todayCount(net, { replies = false, page = false, story = false } = {}) {
  const today = romeParts().date;
  return data.posts.filter(
    (p) =>
      p.network === net &&
      isReply(p) === replies &&
      Boolean(p.page) === page &&
      (p.format === "story") === story &&
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
        ...(net === "instagram" ? { storiesToday: todayCount(net, { story: true }) } : {}),
        ...(net === "linkedin" && linkedinPage() ? { pageToday: todayCount(net, { page: true }), pageAuto: linkedinPage().auto } : {}),
      };
    }),
    ai: aiStatus(),
    stock: stockStatus(),
    voice: voiceStatus(),
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
        ...(net === "instagram" ? { storie_oggi: `${todayCount(net, { story: true })} su ${s.maxStoriesPerDay} al giorno (contate a parte dai post)` } : {}),
        ...(net !== "linkedin" ? { risposte_ai_commenti: !acc ? "non possibili (social non collegato)" : `${(s.autoReplies ?? s.auto) ? "automatiche" : "con approvazione dell'utente"}; oggi ${todayCount(net, { replies: true })} su ${MAX_REPLIES_PER_DAY} (commenti nuovi con social_inbox)` } : {}),
        testo_max: NETWORKS[net].maxText,
        ...(net === "linkedin" && linkedinPage() ? { pagina_aziendale: pageForAgents() } : {}),
        ...(net === "youtube" ? { youtube: youtubeForAgents() } : {}),
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
      ...(p.page ? { pagina: p.pageName || p.page } : {}),
      stato: p.status,
      quando: p.publishedAt ?? p.publishAt ?? p.at,
      risponde_a: p.replyToPost ?? p.replyTo ?? null,
      testo: p.text.slice(0, 100),
      link: p.url ?? null,
      errore: p.error ?? null,
    })),
  };
}

function youtubeForAgents() {
  const s = settingsOf("youtube");
  return `un post = UN video (title = titolo fino a 100 caratteri, text = descrizione; facoltativo thumbnail = id di una miniatura 1280×720, ` +
    `usata solo nei video lunghi). Video ${({ public: "pubblici", unlisted: "non in elenco", private: "privati" })[s.privacy]}. ` +
    (s.mirror
      ? `Copia automatica ATTIVA: ogni video che esce su un altro social${s.mirrorStories ? " (anche le storie)" : " (non le storie)"} arriva da solo anche su YouTube, con titolo e descrizione presi dal post. ` +
        "Se vuoi un titolo e una descrizione scritti per YouTube, pubblica tu lo stesso video su YouTube prima che esca altrove (o mentre la copia aspetta): la tua versione prende il posto della copia. "
      : "Copia automatica spenta: i video su YouTube li pubblica solo chi chiama social_publish. ") +
    "Lo stesso video non va mai due volte su YouTube.";
}

function pageForAgents() {
  const pg = linkedinPage();
  return `${pg.name}: ogni post di LinkedIn esce ${pg.only ? "SOLO sulla pagina (non sul profilo)" : "sia sul profilo sia sulla pagina"} (lo fa il programma da solo, tu chiami social_publish una volta); ` +
    `${pg.auto ? "sulla pagina si pubblica col collegamento" : "sulla pagina lo pubblica l'utente a mano da Approvazioni"}. Post di oggi sulla pagina: ${todayCount("linkedin", { page: true })}. ` +
    "Scrivi pensando a entrambi: tono da azienda (Venturo), niente «io» troppo personale.";
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
  // LinkedIn con la pagina approvata: si chiede anche il permesso di pubblicare sulle pagine.
  const scopes = net === "linkedin" && settingsOf(net).pageApi ? [...PROVIDERS.linkedin.scopes, ORG_SCOPE] : PROVIDERS[net].scopes;
  pending.set(state, { net, verifier, scopes, at: Date.now() });
  return { url: PROVIDERS[net].authUrl({ clientId: app.clientId, redirectUri: SOCIAL_REDIRECT_URI, state, challenge, scopes }) };
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
  acc.scopes ??= p.scopes ?? null;
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

/** "146737411" o l'indirizzo della pagina (linkedin.com/company/146737411/...) → id numerico; "" = nessuna pagina. */
export function parsePageId(v) {
  const t = String(v ?? "").trim();
  if (!t) return null;
  const m = t.match(/^(?:https?:\/\/)?(?:[\w-]+\.)?linkedin\.com\/company\/(\d{3,15})(?:[/?#]|$)/i) ?? t.match(/^(?:urn:li:organization:)?(\d{3,15})$/);
  if (!m) throw new Error("Pagina LinkedIn: incolla l'indirizzo che vedi da amministratore (linkedin.com/company/NUMERO/admin/...) oppure solo il numero.");
  return m[1];
}

/** Solo dall'interfaccia: pubblicazione automatica, massimo di post al giorno e (LinkedIn) pagina aziendale. */
export function setNetworkSettings(net, { auto, maxPerDay, maxStoriesPerDay, autoReplies, pageId, pageName, pageOnly, pageApi, mirror, mirrorStories, privacy, aiLabel, footer } = {}) {
  assertNetwork(net);
  const s = settingsOf(net);
  if (auto !== undefined) s.auto = Boolean(auto);
  if (maxPerDay !== undefined) {
    const n = Number(maxPerDay);
    if (!Number.isInteger(n) || n < 0 || n > 50) throw new Error("Post al giorno: un numero da 0 a 50.");
    s.maxPerDay = n;
  }
  if (maxStoriesPerDay !== undefined && net === "instagram") {
    const n = Number(maxStoriesPerDay);
    if (!Number.isInteger(n) || n < 0 || n > 25) throw new Error("Storie al giorno: un numero da 0 a 25.");
    s.maxStoriesPerDay = n;
  }
  // Risposte ai commenti: automatiche, con approvazione, oppure (null) come i post.
  if (autoReplies !== undefined && net !== "linkedin") s.autoReplies = autoReplies === null || autoReplies === "" ? undefined : Boolean(autoReplies);
  if (net === "linkedin") {
    if (pageId !== undefined) {
      s.pageId = parsePageId(pageId);
      if (!s.pageId) Object.assign(s, { pageOnly: false, pageApi: false });
    }
    if (pageName !== undefined) s.pageName = String(pageName ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (pageOnly !== undefined) s.pageOnly = Boolean(pageOnly) && Boolean(s.pageId);
    if (pageApi !== undefined) s.pageApi = Boolean(pageApi) && Boolean(s.pageId);
  }
  if (net === "youtube") {
    if (mirror !== undefined) s.mirror = Boolean(mirror);
    if (mirrorStories !== undefined) s.mirrorStories = Boolean(mirrorStories);
    if (aiLabel !== undefined) s.aiLabel = Boolean(aiLabel);
    if (privacy !== undefined) {
      if (!YT_PRIVACY.includes(privacy)) throw new Error("Visibilità dei video: public, unlisted o private.");
      s.privacy = privacy;
    }
    if (footer !== undefined) {
      const f = String(footer ?? "").replace(/\r/g, "").trim();
      if ([...f].length > 1000) throw new Error("Testo in fondo alla descrizione: al massimo 1000 caratteri.");
      if (/[<>]/.test(f)) throw new Error("Testo in fondo alla descrizione: niente < e > (YouTube li rifiuta).");
      s.footer = f;
    }
  }
  data.settings[net] = s;
  save();
  changed();
  if (net === "youtube" && mirror !== undefined) log("social", "info", `YouTube: copia automatica dei video ${s.mirror ? "ATTIVA" : "spenta"}.`);
  if (auto !== undefined) log("social", "info", `${label(net)}: pubblicazione ${s.auto ? "AUTOMATICA (senza approvazione)" : "con approvazione"}.`);
  if (autoReplies !== undefined && net !== "linkedin") log("social", "info", `${label(net)}: risposte ai commenti ${s.autoReplies === undefined ? "come i post" : s.autoReplies ? "AUTOMATICHE" : "con approvazione"}.`);
  return socialStatus();
}

const refreshing = new Map();
/** Rinnova il codice di accesso quando serve (X ogni 2 ore, Instagram e Threads prima dei 60 giorni). */
async function account(net) {
  const acc = data.accounts[net];
  if (!acc) throw new Error(`${label(net)} non è collegato: l'utente deve collegarlo da 📣 Social.`);
  const left = acc.expiresAt ? Date.parse(acc.expiresAt) - Date.now() : Infinity;
  const age = Date.now() - Date.parse(acc.refreshedAt ?? acc.connectedAt ?? 0);
  const due = net === "x" || net === "youtube" ? left < 5 * 60_000 : (net === "instagram" || net === "threads") ? left < 20 * 86400_000 && age > 24 * 3600_000 : left < 86400_000;
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
    if (net === "x" || net === "youtube") continue;
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
    ...(p.network === "youtube" ? { title: p.title ?? null, mirrorOf: p.mirrorOf ?? null, note: p.note ?? null } : {}),
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
    page: p.page ? { id: p.page, name: p.pageName || "pagina aziendale" } : null,
  };
}

function setPost(p, patch) {
  const before = p.status;
  Object.assign(p, patch);
  // Post uscito (o non riuscito): lo dice anche alle notifiche sul telefono (lib/push.js).
  if (p.status !== before && ["published", "failed", "uncertain"].includes(p.status)) {
    bus.emit("event", { type: "post-status", status: p.status, label: postLabel(p), reply: Boolean(p.replyTo && !p.replyToPost), manual: Boolean(p.manual), text: p.text, url: p.url ?? null, error: p.error ?? null, agentName: p.agentName ?? null });
  }
  data.posts = data.posts.slice(-MAX_POSTS_KEPT);
  save();
  if (p.approvalId) {
    const st = { pending: "pending", rejected: "rejected", scheduled: "scheduled", publishing: "executing", published: "executed", failed: "failed", uncertain: "uncertain", cancelled: "rejected" }[p.status];
    const a = getState().approvals.find((x) => x.id === p.approvalId);
    if (a && st && a.status !== st) updateApproval(p.approvalId, { status: st, post: postView(p), error: p.error ?? undefined });
  }
  changed();
  if (p.status === "published" && before !== "published") mirrorToYouTube(p);
}

// ---------- copia automatica dei video su YouTube ----------

const LIVE = (p) => !["failed", "rejected", "cancelled"].includes(p.status);
const videoOf = (ids) => (ids ?? []).find((id) => {
  try {
    return media.getMedia(id).kind === "video";
  } catch {
    return false;
  }
});
/** Il post di YouTube (non annullato) con questo video, se c'è. */
const youtubeWith = (mediaId) => data.posts.find((x) => x.network === "youtube" && !isReply(x) && LIVE(x) && (x.media ?? []).includes(mediaId));

/** Didascalia di un altro social → titolo e descrizione per YouTube. */
function mirrorTexts(src, mediaId) {
  const text = String(src.text ?? "").replace(/\blink (in|nella) bio\b/gi, "link qui sotto nella descrizione").trim();
  const first = text.split("\n").map((l) => l.replace(/#[\p{L}\p{N}_]+/gu, "").trim()).find(Boolean);
  let title = youtubeTitle(first ?? "");
  if (!title) {
    try {
      title = youtubeTitle(media.getMedia(mediaId).title);
    } catch {
      // nessun titolo: resta quello generico
    }
  }
  return { title: title || "Venturo", text: [...text].slice(0, NETWORKS.youtube.maxText).join("") };
}

/**
 * Un video è uscito su un altro social: se la copia automatica è attiva e quel video non è già su YouTube (né in
 * attesa), lo si propone anche lì, con le regole di YouTube (approvazione o automatica, massimo al giorno).
 */
function mirrorToYouTube(src) {
  if (src.network === "youtube" || isReply(src)) return;
  const s = settingsOf("youtube");
  if (!s.mirror || s.maxPerDay === 0 || (src.format === "story" && !s.mirrorStories)) return;
  const vid = videoOf(src.media);
  if (!vid || youtubeWith(vid)) return;
  const { title, text } = mirrorTexts(src, vid);
  const who = { id: "copia-youtube", name: "Copia automatica su YouTube" };
  track(
    proposePost(who, { network: "youtube", title, text, media: [vid], reason: `Lo stesso video è uscito su ${postLabel(src)}: copia automatica su YouTube (si spegne in 📣 Social → YouTube).` }, { mirrorOf: src.id })
      .then((r) => log("social", "info", `YouTube: copia del video uscito su ${postLabel(src)} (${r.status}).`)),
  );
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
  if (net === "youtube") {
    if (replyTo && items.length) throw new Error("le risposte ai commenti di YouTube sono solo testo");
    if (!replyTo && (items.length !== 1 || items[0].kind !== "video")) throw new Error("su YouTube un post è UN video dell'archivio (create_motion_video, create_video o un video caricato): niente foto né solo testo");
    if (/[<>]/.test(text) && !replyTo) throw new Error("la descrizione di YouTube non può contenere < o >");
  }
  return items;
}

/** Un agente propone un post (o lo pubblica subito se l'utente ha attivato la pubblicazione automatica). */
export async function proposePost(agent, input = {}, { mirrorOf = null } = {}) {
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
  // YouTube: titolo (dal testo se manca), miniatura facoltativa e mai lo stesso video due volte.
  let yt = {};
  if (net === "youtube" && !replyTo) {
    const title = youtubeTitle(input.title || text.split("\n")[0] || media.getMedia(mediaIds[0]).title);
    if (!title) throw new Error("title: il titolo del video (fino a 100 caratteri)");
    let thumbnail = null;
    if (input.thumbnail) {
      thumbnail = String(input.thumbnail);
      if (media.getMedia(thumbnail).kind !== "image") throw new Error("thumbnail: serve una foto o una grafica (create_graphic, format youtube_thumb)");
    }
    const old = youtubeWith(mediaIds[0]);
    if (old) {
      if (old.mirrorOf && !mirrorOf && ["pending", "scheduled"].includes(old.status) && !inFlight.has(old.id)) {
        setPost(old, { status: "cancelled", error: `sostituito dalla versione preparata da ${agent.name}` });
      } else {
        throw new Error(`questo video è già su YouTube o in attesa di uscire (post ${old.id}, ${old.status}): lo stesso video non va due volte`);
      }
    }
    yt = { title, ...(thumbnail ? { thumbnail } : {}), ...(mirrorOf ? { mirrorOf } : {}) };
  }
  if (replyTo && answeredComments(net).has(replyTo)) throw new Error("a questo commento c'è già una risposta (pubblicata o in attesa in Approvazioni): non rispondere due volte");
  let publishAt = null;
  if (input.publish_at) {
    const d = parseRomeTime(input.publish_at);
    if (d.getTime() > Date.now() + 60_000) {
      if (d.getTime() > Date.now() + 30 * 86400_000) throw new Error("publish_at: al massimo tra 30 giorni");
      publishAt = d.toISOString();
    }
  }
  const s = settingsOf(net);
  if (format === "story" ? s.maxStoriesPerDay === 0 : s.maxPerDay === 0) throw new Error(`${label(net)}: l'utente ha messo 0 ${format === "story" ? "storie" : "post"} al giorno (pubblicazione ferma).`);
  const base = {
    network: net, text, media: mediaIds, format, replyTo, replyToPost, publishAt, ...yt,
    reason: String(input.reason ?? "").slice(0, 500),
    agentId: agent.id, agentName: agent.name,
  };
  // LinkedIn con la pagina aziendale: lo stesso post esce anche sulla pagina (o solo lì), come post a parte.
  const page = net === "linkedin" && !replyTo && !replyToPost ? linkedinPage() : null;
  const targets = page?.only ? [] : [{ manual }];
  if (page) targets.push({ manual: manual || !page.auto, page: page.id, pageName: page.name });
  const out = [];
  for (const t of targets) {
    try {
      // Le risposte ai commenti possono avere una regola loro (automatiche anche se i post chiedono l'approvazione, o il contrario).
      const auto = replyTo ? (s.autoReplies ?? s.auto) : s.auto;
      out.push(await dispatch(agent, { ...base, ...(t.page ? { page: t.page, pageName: t.pageName } : {}) }, t.manual, { ...s, auto }, input));
    } catch (err) {
      out.push({ error: err });
    }
  }
  if (out.length === 1) {
    if (out[0].error) throw out[0].error;
    return page ? { ...out[0], message: `Pagina ${page.name}: ${out[0].message}` } : out[0];
  }
  const [prof, pg] = out;
  const pageRes = pg.error ? { status: "failed", message: pg.error.message } : pg;
  if (prof.error) throw new Error(`${prof.error.message} (pagina ${page.name}: ${pageRes.message})`);
  return { ...prof, pagina: { nome: page.name, ...pageRes } };
}

/** Un post (del profilo o della pagina): pubblicato subito, programmato o messo in Approvazioni. */
async function dispatch(agent, fields, manual, s, input) {
  const net = fields.network;
  const p = {
    id: `p${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`,
    ...fields,
    at: new Date().toISOString(),
    status: "pending",
    ...(manual ? { manual: true } : {}),
  };
  data.posts.push(p);
  const where = postLabel(p);
  const costNote = net === "x" ? ` Costo su X: ${hasLink(p.text) ? "0,20 $ (contiene un link)" : "0,015 $"}.` : "";
  if (s.auto && !manual) {
    if (p.publishAt) {
      setPost(p, { status: "scheduled" });
      return { status: "scheduled", post_id: p.id, publish_at: input.publish_at, message: `Programmato: verrà pubblicato su ${where} all'ora indicata.${costNote}` };
    }
    await publishPost(p);
    if (p.status === "published") return { status: "published", post_id: p.id, social_id: p.remoteId, url: p.url, message: `Pubblicato su ${where}.${costNote}` };
    if (p.status === "scheduled") return { status: "scheduled", post_id: p.id, message: "Uscirà appena è pubblicato il post a cui risponde." };
    throw new Error(`pubblicazione su ${where} non riuscita: ${p.error}`);
  }
  const a = addApproval({ ...agent, target: { mode: "social", network: net, label: where } }, null, { kind: "post", postId: p.id, post: postView(p) });
  setPost(p, { approvalId: a.id });
  if (manual) {
    const why = data.accounts[net] ? "sulla pagina l'app non può ancora pubblicare da sola" : `${label(net)} non è collegato`;
    return {
      status: "pending_manual",
      post_id: p.id,
      message: `${why}: il post è in ✅ Approvazioni e l'utente lo pubblica a mano con un tocco${p.publishAt ? " (gli ricordiamo l'ora consigliata)" : ""}.`,
    };
  }
  return {
    status: "pending_approval",
    post_id: p.id,
    message: `Post proposto per ${where}: aspetta l'approvazione dell'utente in ✅ Approvazioni${p.publishAt ? " (poi partirà all'ora indicata)" : ""}.${costNote}`,
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
    media.markUsed(p.media ?? [], `${postLabel(p)} ${new Date().toISOString().slice(0, 10)}`);
    setPost(p, { status: "published", publishedAt: new Date().toISOString(), decidedAt: new Date().toISOString() });
    log(p.agentId ?? "social", "info", `Pubblicato a mano su ${postLabel(p)}.`);
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
    const story = p.format === "story";
    const full = isReply(p)
      ? todayCount(net, { replies: true }) >= MAX_REPLIES_PER_DAY
      : story
        ? todayCount(net, { story: true }) >= s.maxStoriesPerDay
        : todayCount(net, { page: Boolean(p.page) }) >= s.maxPerDay;
    if (full) {
      setPost(p, {
        status: "failed",
        error: isReply(p)
          ? `limite di ${MAX_REPLIES_PER_DAY} risposte al giorno su ${label(net)} già raggiunto`
          : story
            ? `limite di ${s.maxStoriesPerDay} storie al giorno su ${label(net)} già raggiunto (si cambia in 📣 Social)`
            : `limite di ${s.maxPerDay} post al giorno su ${postLabel(p)} già raggiunto (si cambia in 📣 Social)`,
      });
      return;
    }
    setPost(p, { status: "publishing", startedAt: new Date().toISOString(), sending: false });
    let acc;
    let files;
    try {
      acc = await account(net);
      if (p.page && !acc.scopes?.includes(ORG_SCOPE)) throw new Error(`l'accesso a LinkedIn non comprende la pubblicazione sulla pagina: in 📣 Social → LinkedIn spunta «LinkedIn ha approvato l'accesso alle pagine» e premi Ricollega`);
      checkPost(net, { text: p.text, mediaIds: p.media ?? [], format: p.format, replyTo: p.replyTo });
      files = await media.forPublishing([...(p.media ?? []), ...(p.thumbnail ? [p.thumbnail] : [])], { network: net, format: p.format });
      if (NETWORKS[net].needsPublicMedia && files.some((f) => !f.url)) throw new Error(`${label(net)} scarica i file da un indirizzo pubblico: funziona solo con il server online`);
    } catch (err) {
      setPost(p, { status: "failed", error: err.message });
      return;
    }
    setPost(p, { sending: true });
    try {
      const r = await PROVIDERS[net].publish(acc, net === "youtube" && !p.replyTo ? youtubeSend(p, s) : p, files);
      if (r.cost) addCost(r.cost);
      media.markUsed(p.media ?? [], `${postLabel(p)} ${new Date().toISOString().slice(0, 10)}`);
      setPost(p, { status: "published", publishedAt: new Date().toISOString(), remoteId: r.id ?? null, url: r.url ?? null, error: null, sending: false, ...(r.note ? { note: r.note } : {}) });
      if (r.note) log(p.agentId ?? "social", "warn", `${postLabel(p)}: ${r.note}`);
      log(p.agentId ?? "social", "info", `Pubblicato su ${postLabel(p)}${r.url ? `: ${r.url}` : ""}`);
    } catch (err) {
      // Errore di rete a metà: il post potrebbe essere uscito lo stesso.
      const status = err.network ? "uncertain" : "failed";
      setPost(p, { status, error: status === "uncertain" ? `risposta persa (${err.message}): controlla su ${postLabel(p)} prima di riproporlo` : err.message });
      log(p.agentId ?? "social", "warn", `${postLabel(p)}: pubblicazione non riuscita: ${err.message}`);
    }
  } finally {
    inFlight.delete(p.id);
  }
}

/** Il post così come va a YouTube: descrizione con il testo fisso in fondo, visibilità ed etichetta IA scelte dall'utente. */
function youtubeSend(p, s) {
  const text = s.footer ? `${p.text}\n\n${s.footer}` : p.text;
  return { ...p, text: [...text].slice(0, NETWORKS.youtube.maxText).join(""), privacy: s.privacy, synthetic: s.aiLabel !== false };
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

/** Commenti a cui c'è già una risposta (pubblicata, programmata o in attesa di approvazione). */
function answeredComments(net) {
  return new Set(data.posts.filter((p) => p.network === net && p.replyTo && !p.replyToPost && !["failed", "rejected", "cancelled"].includes(p.status)).map((p) => String(p.replyTo)));
}
const INBOX_NETWORKS = ["instagram", "threads", "x", "youtube"];
const MAX_INBOX = 30;

/**
 * Commenti nuovi sotto i post degli ultimi giorni, senza ancora una risposta: quelli già mostrati non tornano
 * (salvo include_seen), quelli dell'account stesso e quelli già risposti nemmeno. Su X si guardano solo i post
 * usciti dall'app negli ultimi 3 giorni (leggere costa).
 */
export async function inbox(net, { days, includeSeen = false } = {}) {
  assertNetwork(net);
  if (!INBOX_NETWORKS.includes(net)) throw new Error("LinkedIn non permette alle app di leggere i commenti: lì le risposte le dà l'utente.");
  const acc = await account(net);
  const d = Math.min(Math.max(Number(days) || 7, 1), net === "x" ? 3 : 14);
  const since = Date.now() - d * 86400_000;
  let posts;
  if (net === "x") {
    posts = data.posts
      .filter((p) => p.network === "x" && p.status === "published" && p.remoteId && !isReply(p) && Date.parse(p.publishedAt ?? 0) >= since)
      .slice(-5)
      .reverse()
      .map((p) => ({ id: p.remoteId, text: p.text }));
  } else {
    posts = (await PROVIDERS[net].recent(acc, 15)).filter((p) => (!p.date || Date.parse(p.date) >= since) && p.comments !== 0).slice(0, 10);
  }
  const answered = answeredComments(net);
  const seen = (data.seen[net] ??= {});
  const me = String(acc.username ?? "").replace(/^@/, "").toLowerCase();
  const found = [];
  const errors = [];
  let cost = 0;
  for (const post of posts) {
    let list;
    try {
      list = await PROVIDERS[net].comments(acc, String(post.id));
    } catch (err) {
      errors.push(`post ${post.id}: ${err.message}`);
      continue;
    }
    cost += list.cost ?? 0;
    for (const c of list) {
      const id = String(c?.id ?? "");
      if (!id || id === String(post.id) || c.mine || String(c.from ?? "").replace(/^@/, "").toLowerCase() === me) continue;
      if (answered.has(id) || (seen[id] && !includeSeen)) continue;
      found.push({ comment_id: id, post_id: String(post.id), post: String(post.text ?? "").replace(/\s+/g, " ").slice(0, 120), from: c.from, text: String(c.text ?? "").slice(0, 500), date: c.date ?? null });
    }
  }
  if (cost) addCost(cost);
  const out = found.slice(0, MAX_INBOX);
  const now = new Date().toISOString();
  for (const c of out) seen[c.comment_id] ??= now;
  for (const [id, at] of Object.entries(seen)) if (Date.now() - Date.parse(at) > 30 * 86400_000) delete seen[id];
  save();
  const s = settingsOf(net);
  return {
    network: net,
    post_controllati: posts.length,
    commenti: out,
    altri: Math.max(0, found.length - out.length),
    risposte: `${(s.autoReplies ?? s.auto) ? "escono subito" : "vanno in ✅ Approvazioni"}; oggi ${todayCount(net, { replies: true })} su ${MAX_REPLIES_PER_DAY}`,
    ...(errors.length ? { errori: errors.slice(0, 5) } : {}),
    ...(net === "x" && cost ? { nota_costo: `lettura costata circa ${cost.toFixed(3)} $` } : {}),
    come_rispondere: "social_publish con network, reply_to = comment_id e il testo. Non rispondere a spam, insulti o offerte sospette: ignorali.",
  };
}

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
