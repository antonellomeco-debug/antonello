// I quattro social: accesso (OAuth), pubblicazione, statistiche e commenti, ognuno con le sue API ufficiali.
// - Instagram: "Instagram API con accesso Instagram" (account Professionale, senza Pagina Facebook), graph.instagram.com.
// - Threads: API di Threads, graph.threads.net.
// - LinkedIn: prodotto "Share on LinkedIn" (post sul profilo personale), api.linkedin.com/rest.
// - X: API v2 a consumo (ogni post si paga, vedi COSTS), api.x.com.
// Instagram e Threads scaricano foto e video da un indirizzo pubblico: servono il server con l'indirizzo https.
import fs from "node:fs";
import crypto from "node:crypto";
import { call, request, endpoint, pollPause } from "./http.js";

export const NETWORKS = {
  instagram: {
    label: "Instagram",
    icon: "📸",
    maxText: 2200,
    console: "https://developers.facebook.com/apps",
    needsPublicMedia: true,
  },
  threads: { label: "Threads", icon: "🧵", maxText: 500, console: "https://developers.facebook.com/apps", needsPublicMedia: true },
  linkedin: { label: "LinkedIn", icon: "💼", maxText: 3000, console: "https://www.linkedin.com/developers/apps" },
  x: { label: "X", icon: "𝕏", maxText: 280, console: "https://console.x.com" },
};
export const NETWORK_IDS = Object.keys(NETWORKS);

// Prezzi di X (pagamento a consumo, ottobre 2026): post 0,015 $, post con un link 0,20 $, lettura di un post 0,005 $,
// lettura di un profilo 0,01 $. Si sommano alla spesa mostrata nell'app.
export const COSTS = { xPost: 0.015, xPostWithLink: 0.2, xRead: 0.005, xUser: 0.01 };
export const hasLink = (text) => /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|it|net|org|io|ly|co|eu|me|app|dev|ai)\b(\/\S*)?/i.test(String(text ?? ""));

const IG = "https://graph.instagram.com";
const TH = "https://graph.threads.net/v1.0";
const LI = "https://api.linkedin.com";
const XA = "https://api.x.com";

const nowPlus = (sec) => (sec ? new Date(Date.now() + Number(sec) * 1000).toISOString() : null);

/** Aspetta che un contenuto caricato (video, carosello) sia pronto: check() restituisce "ok", "wait" o lancia. */
async function waitUntil(check, { tries = 120, factor = 1 } = {}) {
  for (let i = 0; i < tries; i++) {
    const s = await check();
    if (s === "ok") return;
    await pollPause(factor);
  }
  throw new Error("il social non ha finito di preparare il file in tempo: riprova più tardi");
}

// ---------------------------------------------------------------- Instagram

const instagram = {
  scopes: ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_insights", "instagram_business_manage_comments"],
  authUrl({ clientId, redirectUri, state }) {
    const u = new URL("https://www.instagram.com/oauth/authorize");
    u.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: this.scopes.join(","), state, enable_fb_login: "0", force_reauth: "true" });
    return endpoint(u.toString());
  },
  async connect({ clientId, clientSecret }, code, redirectUri) {
    const short = await call("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      form: { client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code: code.replace(/#_$/, "") },
    });
    const first = Array.isArray(short?.data) ? short.data[0] : short; // la risposta può essere { data: [ … ] }
    if (!first?.access_token) throw new Error("Instagram non ha dato il codice di accesso");
    const long = await call(`${IG}/access_token`, { query: { grant_type: "ig_exchange_token", client_secret: clientSecret, access_token: first.access_token } });
    const me = await call(`${IG}/me`, { query: { fields: "user_id,username,account_type", access_token: long.access_token } });
    return {
      userId: String(me.user_id ?? first.user_id),
      username: me.username,
      accountType: me.account_type ?? null,
      token: long.access_token,
      expiresAt: nowPlus(long.expires_in ?? 60 * 86400),
      refreshedAt: new Date().toISOString(),
    };
  },
  /** Il codice dura 60 giorni e si rinnova (dopo almeno 24 ore) senza rifare l'accesso. */
  async refresh(_app, acc) {
    const r = await call(`${IG}/refresh_access_token`, { query: { grant_type: "ig_refresh_token", access_token: acc.token } });
    return { token: r.access_token, expiresAt: nowPlus(r.expires_in ?? 60 * 86400), refreshedAt: new Date().toISOString() };
  },
  async publish(acc, post, media) {
    const token = acc.token;
    if (post.replyTo) {
      const r = await call(`${IG}/${post.replyTo}/replies`, { method: "POST", form: { message: post.text, access_token: token } });
      return { id: r.id, url: null };
    }
    if (!media.length) throw new Error("Instagram pubblica solo con almeno una foto o un video");
    const create = async (params) => (await call(`${IG}/${acc.userId}/media`, { method: "POST", form: { ...params, access_token: token } })).id;
    const ready = (id, factor = 1) =>
      waitUntil(async () => {
        const s = await call(`${IG}/${id}`, { query: { fields: "status_code,status", access_token: token } });
        if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return "ok";
        if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`Instagram non accetta il file: ${s.status ?? s.status_code}`);
        return "wait";
      }, { factor });
    const one = (m, extra) => (m.kind === "video" ? { video_url: m.url, ...extra } : { image_url: m.url, ...extra });
    let containerId;
    if (post.format === "story") {
      if (media.length !== 1) throw new Error("una storia contiene una sola foto o un solo video");
      containerId = await create({ media_type: "STORIES", ...one(media[0]) });
    } else if (media.length === 1) {
      const m = media[0];
      containerId = await create(m.kind === "video" ? { media_type: "REELS", video_url: m.url, caption: post.text, share_to_feed: "true" } : { image_url: m.url, caption: post.text });
    } else {
      if (media.length > 10) throw new Error("un carosello di Instagram ha al massimo 10 foto o video");
      const children = [];
      for (const m of media) {
        const id = await create(m.kind === "video" ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: "true" } : { image_url: m.url, is_carousel_item: "true" });
        await ready(id, m.kind === "video" ? 2 : 1);
        children.push(id);
      }
      containerId = await create({ media_type: "CAROUSEL", children: children.join(","), caption: post.text });
    }
    await ready(containerId, media.some((m) => m.kind === "video") ? 2 : 1);
    const published = await call(`${IG}/${acc.userId}/media_publish`, { method: "POST", form: { creation_id: containerId, access_token: token } });
    let url = null;
    try {
      url = (await call(`${IG}/${published.id}`, { query: { fields: "permalink", access_token: token } })).permalink ?? null;
    } catch {
      // il link si può leggere anche dopo
    }
    return { id: published.id, url };
  },
  async stats(acc, { limit = 10 } = {}) {
    const token = acc.token;
    const profile = await call(`${IG}/${acc.userId}`, { query: { fields: "username,followers_count,follows_count,media_count", access_token: token } });
    const list = await call(`${IG}/${acc.userId}/media`, {
      query: { fields: "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count", limit, access_token: token },
    });
    const posts = [];
    for (const m of list.data ?? []) {
      const p = { id: m.id, date: m.timestamp, type: m.media_product_type ?? m.media_type, text: (m.caption ?? "").slice(0, 160), url: m.permalink, likes: m.like_count, comments: m.comments_count };
      try {
        const ins = await call(`${IG}/${m.id}/insights`, { query: { metric: "reach,saved,shares,views", access_token: token } });
        Object.assign(p, metrics(ins));
      } catch {
        // alcuni tipi di post non hanno tutte le statistiche
      }
      posts.push(p);
    }
    return { account: `@${profile.username}`, followers: profile.followers_count, following: profile.follows_count, posts_total: profile.media_count, recent_posts: posts };
  },
  async comments(acc, postId) {
    const r = await call(`${IG}/${postId}/comments`, { query: { fields: "id,text,username,timestamp,like_count", limit: 50, access_token: acc.token } });
    return (r.data ?? []).map((c) => ({ id: c.id, from: c.username, text: c.text, date: c.timestamp, likes: c.like_count }));
  },
};

/** Statistiche di Meta ({data:[{name, values:[{value}]} | {name, total_value:{value}}]}) → { nome: valore }. */
function metrics(res) {
  const out = {};
  for (const m of res?.data ?? []) out[m.name] = m.total_value?.value ?? m.values?.at(-1)?.value ?? null;
  return out;
}

// ---------------------------------------------------------------- Threads

const threads = {
  scopes: ["threads_basic", "threads_content_publish", "threads_manage_insights", "threads_read_replies", "threads_manage_replies"],
  authUrl({ clientId, redirectUri, state }) {
    const u = new URL("https://threads.net/oauth/authorize");
    u.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: this.scopes.join(","), state });
    return endpoint(u.toString());
  },
  async connect({ clientId, clientSecret }, code, redirectUri) {
    const short = await call("https://graph.threads.net/oauth/access_token", {
      method: "POST",
      form: { client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code: code.replace(/#_$/, "") },
    });
    const long = await call("https://graph.threads.net/access_token", { query: { grant_type: "th_exchange_token", client_secret: clientSecret, access_token: short.access_token } });
    const me = await call(`${TH}/me`, { query: { fields: "id,username", access_token: long.access_token } });
    return { userId: String(me.id ?? short.user_id), username: me.username, token: long.access_token, expiresAt: nowPlus(long.expires_in ?? 60 * 86400), refreshedAt: new Date().toISOString() };
  },
  async refresh(_app, acc) {
    const r = await call("https://graph.threads.net/refresh_access_token", { query: { grant_type: "th_refresh_token", access_token: acc.token } });
    return { token: r.access_token, expiresAt: nowPlus(r.expires_in ?? 60 * 86400), refreshedAt: new Date().toISOString() };
  },
  async publish(acc, post, media) {
    const token = acc.token;
    const create = async (params) => (await call(`${TH}/me/threads`, { method: "POST", form: { ...params, access_token: token } })).id;
    const ready = (id, factor = 1) =>
      waitUntil(async () => {
        const s = await call(`${TH}/${id}`, { query: { fields: "status,error_message", access_token: token } });
        if (!s.status || s.status === "FINISHED" || s.status === "PUBLISHED") return "ok";
        if (s.status === "ERROR" || s.status === "EXPIRED") throw new Error(`Threads non accetta il file: ${s.error_message ?? s.status}`);
        return "wait";
      }, { factor });
    const reply = post.replyTo ? { reply_to_id: post.replyTo } : {};
    const item = (m) => (m.kind === "video" ? { media_type: "VIDEO", video_url: m.url } : { media_type: "IMAGE", image_url: m.url });
    let containerId;
    if (!media.length) containerId = await create({ media_type: "TEXT", text: post.text, ...reply });
    else if (media.length === 1) containerId = await create({ ...item(media[0]), text: post.text, ...reply });
    else {
      if (media.length > 20) throw new Error("un carosello di Threads ha al massimo 20 foto o video");
      const children = [];
      for (const m of media) {
        const id = await create({ ...item(m), is_carousel_item: "true" });
        await ready(id, m.kind === "video" ? 2 : 1);
        children.push(id);
      }
      containerId = await create({ media_type: "CAROUSEL", children: children.join(","), text: post.text, ...reply });
    }
    await ready(containerId, media.some((m) => m.kind === "video") ? 2 : 1);
    const published = await call(`${TH}/me/threads_publish`, { method: "POST", form: { creation_id: containerId, access_token: token } });
    let url = null;
    try {
      url = (await call(`${TH}/${published.id}`, { query: { fields: "permalink", access_token: token } })).permalink ?? null;
    } catch {
      // il link si può leggere anche dopo
    }
    return { id: published.id, url };
  },
  async stats(acc, { limit = 10 } = {}) {
    const token = acc.token;
    let account = {};
    try {
      account = metrics(await call(`${TH}/me/threads_insights`, { query: { metric: "views,likes,replies,reposts,quotes,followers_count", access_token: token } }));
    } catch {
      // statistiche del profilo non disponibili (es. permesso non concesso)
    }
    const list = await call(`${TH}/me/threads`, { query: { fields: "id,text,timestamp,permalink,media_type", limit, access_token: token } });
    const posts = [];
    for (const t of list.data ?? []) {
      const p = { id: t.id, date: t.timestamp, type: t.media_type, text: (t.text ?? "").slice(0, 160), url: t.permalink };
      try {
        Object.assign(p, metrics(await call(`${TH}/${t.id}/insights`, { query: { metric: "views,likes,replies,reposts,quotes,shares", access_token: token } })));
      } catch {
        // post troppo recente o senza statistiche
      }
      posts.push(p);
    }
    return { account: `@${acc.username}`, last_days: account, recent_posts: posts };
  },
  async comments(acc, postId) {
    const r = await call(`${TH}/${postId}/replies`, { query: { fields: "id,text,username,timestamp", access_token: acc.token } });
    return (r.data ?? []).map((c) => ({ id: c.id, from: c.username, text: c.text, date: c.timestamp }));
  },
};

// ---------------------------------------------------------------- LinkedIn

/**
 * Versione delle API di LinkedIn (AAAAMM): ogni versione resta attiva circa un anno. Si usa quella di due mesi fa;
 * se LinkedIn non la riconosce si prova il mese prima (LINKEDIN_VERSION per fissarla a mano).
 */
function liVersion(back = 2) {
  if (process.env.LINKEDIN_VERSION) return process.env.LINKEDIN_VERSION;
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - back);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
async function liRequest(url, opts) {
  for (let back = 2; ; back++) {
    try {
      return await request(url, { ...opts, headers: { "LinkedIn-Version": liVersion(back), "X-Restli-Protocol-Version": "2.0.0", ...(opts.headers ?? {}) } });
    } catch (err) {
      const versionProblem = err.status === 426 || /version/i.test(String(err.body?.code ?? "")) || /NONEXISTENT_VERSION|VERSION_MISSING/i.test(err.message);
      if (!versionProblem || back >= 6 || process.env.LINKEDIN_VERSION) throw err;
    }
  }
}

/** Testo dei post di LinkedIn ("little text"): alcuni simboli vanno protetti, gli hashtag hanno un formato loro. */
export function linkedinText(text) {
  return String(text ?? "")
    .split(/(#[\p{L}\p{N}_]+)/u)
    .map((part, i) => (i % 2 === 1 ? `{hashtag|\\#|${part.slice(1)}}` : part.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`)))
    .join("");
}

const linkedin = {
  scopes: ["openid", "profile", "w_member_social"],
  authUrl({ clientId, redirectUri, state }) {
    const u = new URL("https://www.linkedin.com/oauth/v2/authorization");
    u.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, scope: this.scopes.join(" ") });
    return endpoint(u.toString());
  },
  async connect({ clientId, clientSecret }, code, redirectUri) {
    const tok = await call("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      form: { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret },
    });
    const me = await call(`${LI}/v2/userinfo`, { token: tok.access_token });
    return {
      userId: String(me.sub),
      username: me.name ?? [me.given_name, me.family_name].filter(Boolean).join(" "),
      token: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: nowPlus(tok.expires_in ?? 60 * 86400),
    };
  },
  /** Con "Share on LinkedIn" di solito non c'è un codice di rinnovo: dopo 60 giorni si ricollega dall'app. */
  async refresh({ clientId, clientSecret }, acc) {
    if (!acc.refreshToken) return null;
    const tok = await call("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      form: { grant_type: "refresh_token", refresh_token: acc.refreshToken, client_id: clientId, client_secret: clientSecret },
    });
    return { token: tok.access_token, refreshToken: tok.refresh_token ?? acc.refreshToken, expiresAt: nowPlus(tok.expires_in ?? 60 * 86400) };
  },
  async uploadImage(acc, m) {
    const owner = `urn:li:person:${acc.userId}`;
    const init = await liRequest(`${LI}/rest/images?action=initializeUpload`, { method: "POST", token: acc.token, json: { initializeUploadRequest: { owner } } });
    const { uploadUrl, image } = init.data.value;
    await request(uploadUrl, { method: "PUT", token: acc.token, body: fs.readFileSync(m.path), headers: { "content-type": m.mime } });
    return image;
  },
  async uploadVideo(acc, m) {
    const owner = `urn:li:person:${acc.userId}`;
    const size = fs.statSync(m.path).size;
    const init = await liRequest(`${LI}/rest/videos?action=initializeUpload`, {
      method: "POST",
      token: acc.token,
      json: { initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } },
    });
    const { video, uploadInstructions, uploadToken } = init.data.value;
    const fd = fs.openSync(m.path, "r");
    const etags = [];
    try {
      for (const part of uploadInstructions) {
        const len = part.lastByte - part.firstByte + 1;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, part.firstByte);
        const r = await request(part.uploadUrl, { method: "PUT", body: buf, headers: { "content-type": "application/octet-stream" } });
        etags.push(r.headers.get("etag"));
      }
    } finally {
      fs.closeSync(fd);
    }
    await liRequest(`${LI}/rest/videos?action=finalizeUpload`, {
      method: "POST",
      token: acc.token,
      json: { finalizeUploadRequest: { video, uploadToken: uploadToken ?? "", uploadedPartIds: etags } },
    });
    await waitUntil(async () => {
      const s = (await liRequest(`${LI}/rest/videos/${encodeURIComponent(video)}`, { token: acc.token })).data;
      if (s.status === "AVAILABLE") return "ok";
      if (s.status === "PROCESSING_FAILED") throw new Error("LinkedIn non è riuscito a elaborare il video");
      return "wait";
    }, { factor: 2 });
    return video;
  },
  async publish(acc, post, media) {
    if (post.replyTo) throw new Error("su LinkedIn gli agenti non possono rispondere ai commenti (l'API per i profili personali non lo permette)");
    const body = {
      author: `urn:li:person:${acc.userId}`,
      commentary: linkedinText(post.text),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    if (media.length === 1) {
      const m = media[0];
      body.content = { media: m.kind === "video" ? { id: await this.uploadVideo(acc, m), title: (m.title || "Video").slice(0, 200) } : { id: await this.uploadImage(acc, m), altText: (m.description || m.title || "").slice(0, 4086) } };
    } else if (media.length > 1) {
      if (media.some((m) => m.kind === "video")) throw new Error("su LinkedIn un post con più file può contenere solo foto (un video va da solo)");
      if (media.length > 20) throw new Error("su LinkedIn al massimo 20 foto per post");
      const images = [];
      for (const m of media) images.push({ id: await this.uploadImage(acc, m), altText: (m.description || m.title || "").slice(0, 4086) });
      body.content = { multiImage: { images } };
    }
    const r = await liRequest(`${LI}/rest/posts`, { method: "POST", token: acc.token, json: body });
    const id = r.headers.get("x-restli-id") ?? r.data?.id ?? null;
    return { id, url: id ? `https://www.linkedin.com/feed/update/${id}/` : null };
  },
  async stats() {
    throw new Error("LinkedIn non dà le statistiche dei profili personali alle app (servirebbe un'autorizzazione da partner). Per i risultati chiedi all'utente o guarda il profilo pubblico con web_search.");
  },
  async comments() {
    throw new Error("LinkedIn non permette alle app di leggere i commenti dei profili personali.");
  },
};

// ---------------------------------------------------------------- X

const x = {
  scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
  pkce: true,
  authUrl({ clientId, redirectUri, state, challenge }) {
    const u = new URL("https://x.com/i/oauth2/authorize");
    u.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: this.scopes.join(" "), state, code_challenge: challenge, code_challenge_method: "S256" });
    return endpoint(u.toString());
  },
  basic: ({ clientId, clientSecret }) => (clientSecret ? { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` } : {}),
  async connect(app, code, redirectUri, verifier) {
    const tok = await call(`${XA}/2/oauth2/token`, {
      method: "POST",
      headers: this.basic(app),
      form: { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier, client_id: app.clientId },
    });
    const me = await call(`${XA}/2/users/me`, { token: tok.access_token });
    return {
      userId: String(me.data.id),
      username: me.data.username,
      token: tok.access_token,
      refreshToken: tok.refresh_token ?? null,
      expiresAt: nowPlus(tok.expires_in ?? 7200),
      cost: COSTS.xUser,
    };
  },
  /** Il codice di X dura 2 ore; il codice di rinnovo cambia a ogni rinnovo (va salvato subito). */
  async refresh(app, acc) {
    if (!acc.refreshToken) return null;
    const tok = await call(`${XA}/2/oauth2/token`, {
      method: "POST",
      headers: this.basic(app),
      form: { grant_type: "refresh_token", refresh_token: acc.refreshToken, client_id: app.clientId },
    });
    return { token: tok.access_token, refreshToken: tok.refresh_token ?? acc.refreshToken, expiresAt: nowPlus(tok.expires_in ?? 7200) };
  },
  async uploadMedia(acc, m) {
    const size = fs.statSync(m.path).size;
    const category = m.kind === "video" ? "tweet_video" : m.mime === "image/gif" ? "tweet_gif" : "tweet_image";
    const init = await call(`${XA}/2/media/upload/initialize`, { method: "POST", token: acc.token, json: { media_type: m.mime, total_bytes: size, media_category: category } });
    const id = init.data?.id ?? init.data?.media_id;
    const CHUNK = 4 * 1024 * 1024;
    const fd = fs.openSync(m.path, "r");
    try {
      for (let i = 0, at = 0; at < size; i++, at += CHUNK) {
        const len = Math.min(CHUNK, size - at);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, at);
        const form = new FormData();
        form.append("segment_index", String(i));
        form.append("media", new Blob([buf], { type: "application/octet-stream" }), "media");
        await request(`${XA}/2/media/upload/${id}/append`, { method: "POST", token: acc.token, body: form });
      }
    } finally {
      fs.closeSync(fd);
    }
    const fin = await call(`${XA}/2/media/upload/${id}/finalize`, { method: "POST", token: acc.token });
    let info = fin.data?.processing_info;
    while (info && info.state !== "succeeded") {
      if (info.state === "failed") throw new Error(`X non accetta il file: ${info.error?.message ?? "elaborazione fallita"}`);
      await pollPause(Math.min(Math.max(Number(info.check_after_secs) || 1, 1), 10) / 2);
      info = (await call(`${XA}/2/media/upload`, { token: acc.token, query: { command: "STATUS", media_id: id } })).data?.processing_info;
    }
    return String(id);
  },
  async publish(acc, post, media) {
    if (media.length > 4) throw new Error("su X al massimo 4 foto (oppure 1 video) per post");
    if (media.length > 1 && media.some((m) => m.kind === "video")) throw new Error("su X un video va da solo nel post");
    const ids = [];
    for (const m of media) ids.push(await this.uploadMedia(acc, m));
    const body = { text: post.text };
    if (ids.length) body.media = { media_ids: ids };
    if (post.replyTo) body.reply = { in_reply_to_tweet_id: String(post.replyTo) };
    const r = await call(`${XA}/2/tweets`, { method: "POST", token: acc.token, json: body });
    return { id: r.data.id, url: `https://x.com/${acc.username}/status/${r.data.id}`, cost: hasLink(post.text) ? COSTS.xPostWithLink : COSTS.xPost };
  },
  async stats(acc, { limit = 10 } = {}) {
    const n = Math.min(Math.max(limit, 5), 20);
    const me = await call(`${XA}/2/users/me`, { token: acc.token, query: { "user.fields": "public_metrics" } });
    const list = await call(`${XA}/2/users/${acc.userId}/tweets`, { token: acc.token, query: { max_results: n, "tweet.fields": "created_at,public_metrics" } });
    const posts = (list.data ?? []).map((t) => ({ id: t.id, date: t.created_at, text: t.text.slice(0, 160), url: `https://x.com/${acc.username}/status/${t.id}`, ...t.public_metrics }));
    return { account: `@${acc.username}`, ...me.data.public_metrics, recent_posts: posts, cost: COSTS.xUser + posts.length * COSTS.xRead };
  },
  async comments(acc, postId) {
    const r = await call(`${XA}/2/tweets/search/recent`, {
      token: acc.token,
      query: { query: `conversation_id:${postId}`, max_results: 20, "tweet.fields": "author_id,created_at", expansions: "author_id", "user.fields": "username" },
    });
    const users = Object.fromEntries((r.includes?.users ?? []).map((u) => [u.id, u.username]));
    const list = (r.data ?? []).map((t) => ({ id: t.id, from: users[t.author_id] ?? t.author_id, text: t.text, date: t.created_at }));
    return Object.assign(list, { cost: list.length * COSTS.xRead });
  },
};

export const PROVIDERS = { instagram, threads, linkedin, x };

/** Coppia verifier/challenge per l'accesso con PKCE (X). */
export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}
