// Finto server di Instagram, Threads, LinkedIn, X e Gemini per le prove (SOCIAL_API_BASE): risponde come le API
// vere ai percorsi /<host originale>/<percorso>. Le pagine di accesso approvano subito e rimandano al redirect_uri.
// Instagram e Threads scaricano davvero foto e video dagli indirizzi pubblici, come fanno i server di Meta.
// Si può anche avviare da solo: node test/helpers/fake-social.js [porta] (per le prove nel browser).
import http from "node:http";
import crypto from "node:crypto";
import sharp from "sharp";

const PNG = await sharp({ create: { width: 64, height: 80, channels: 3, background: "#3366cc" } }).png().toBuffer();

export async function startFakeSocial({ port = 0 } = {}) {
  const calls = [];
  const fetched = [];
  const challenges = new Map(); // codice di X → code_challenge
  const opts = { geminiFirstModel404: true, videoPolls: 1, failPublish: null };
  let seq = 0;
  const polls = new Map();

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const u = new URL(req.url, "http://x");
    const [, host, ...rest] = u.pathname.split("/");
    const p = `/${rest.join("/")}`;
    const ct = String(req.headers["content-type"] ?? "");
    let body = {};
    if (ct.includes("application/x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(raw.toString()));
    else if (ct.includes("application/json")) body = JSON.parse(raw.toString() || "{}");
    const q = Object.fromEntries(u.searchParams);
    const call = { host, method: req.method, path: p, query: q, body, headers: req.headers, size: raw.length };
    calls.push(call);
    const json = (status, data, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    const consent = () => {
      const back = new URL(q.redirect_uri);
      back.searchParams.set("code", `${host}-code-${++seq}`);
      back.searchParams.set("state", q.state);
      if (host === "x.com") challenges.set(back.searchParams.get("code"), q.code_challenge);
      res.writeHead(302, { location: back.toString() });
      res.end();
    };
    /** Come Meta: scarica il file dall'indirizzo pubblico e controlla che sia una foto o un video. */
    const download = async (url) => {
      const r = await fetch(url);
      const buf = Buffer.from(await r.arrayBuffer());
      fetched.push({ url, status: r.status, type: r.headers.get("content-type"), size: buf.length });
      if (!r.ok) throw new Error(`download ${r.status}`);
      return { type: r.headers.get("content-type"), buf };
    };
    const metaError = (msg) => json(400, { error: { message: msg, type: "OAuthException", code: 9004 } });

    try {
      // ---------------- Instagram
      if (host === "www.instagram.com" && p === "/oauth/authorize") return consent();
      if (host === "api.instagram.com" && p === "/oauth/access_token") {
        if (!body.code || !body.client_secret) return metaError("codice mancante");
        return json(200, { data: [{ access_token: "ig-short", user_id: "1784140001", permissions: "instagram_business_basic" }] });
      }
      if (host === "graph.instagram.com") {
        if (p === "/access_token") return json(200, { access_token: "ig-long", token_type: "bearer", expires_in: 5184000 });
        if (p === "/refresh_access_token") return json(200, { access_token: "ig-long-2", token_type: "bearer", expires_in: 5184000 });
        if (p === "/me") return json(200, { user_id: "1784140001", username: "antonello.prova", account_type: "BUSINESS" });
        const m = p.match(/^\/([\w-]+)\/media$/);
        if (m && req.method === "POST") {
          if (opts.failPublish === "instagram") return metaError("Media non valido");
          for (const k of ["image_url", "video_url"]) {
            if (body[k]) {
              const f = await download(body[k]);
              if (k === "image_url" && f.type !== "image/jpeg") return metaError("Only JPEG images are supported");
              if (k === "image_url") {
                const meta = await sharp(f.buf).metadata();
                const r = meta.width / meta.height;
                if (body.media_type !== "STORIES" && (r < 0.8 - 0.01 || r > 1.91 + 0.01)) return metaError("The aspect ratio is not supported.");
              }
            }
          }
          const id = `igc${++seq}`;
          polls.set(id, body.video_url ? opts.videoPolls : 0);
          return json(200, { id });
        }
        if (m && req.method === "GET") {
          return json(200, { data: [{ id: "ig-post-1", caption: "Primo post", media_type: "IMAGE", media_product_type: "FEED", timestamp: "2026-10-14T10:00:00+0000", permalink: "https://www.instagram.com/p/AAA/", like_count: 12, comments_count: 3 }] });
        }
        if (/^\/[\w-]+\/media_publish$/.test(p)) return json(200, { id: `igp${++seq}` });
        if (/^\/[\w-]+\/insights$/.test(p)) return json(200, { data: [{ name: "reach", period: "lifetime", values: [{ value: 340 }] }, { name: "views", period: "lifetime", values: [{ value: 512 }] }] });
        if (/^\/[\w-]+\/comments$/.test(p)) return json(200, { data: [{ id: "c-1", text: "Bellissimo!", username: "mario", timestamp: "2026-10-14T11:00:00+0000", like_count: 1 }] });
        if (/^\/[\w-]+\/replies$/.test(p)) return json(200, { id: `igr${++seq}` });
        const one = p.match(/^\/([\w-]+)$/);
        if (one) {
          const id = one[1];
          if (q.fields?.includes("status_code")) {
            const left = polls.get(id) ?? 0;
            polls.set(id, left - 1);
            return json(200, { status_code: left > 0 ? "IN_PROGRESS" : "FINISHED", id });
          }
          if (q.fields?.includes("permalink")) return json(200, { permalink: `https://www.instagram.com/p/${id}/`, id });
          return json(200, { username: "antonello.prova", followers_count: 1200, follows_count: 300, media_count: 45, id });
        }
      }
      // ---------------- Threads
      if (host === "threads.net" && p === "/oauth/authorize") return consent();
      if (host === "graph.threads.net") {
        if (p === "/oauth/access_token") return json(200, { access_token: "th-short", user_id: "9001" });
        if (p === "/access_token") return json(200, { access_token: "th-long", token_type: "bearer", expires_in: 5184000 });
        if (p === "/refresh_access_token") return json(200, { access_token: "th-long-2", token_type: "bearer", expires_in: 5184000 });
        if (p === "/v1.0/me") return json(200, { id: "9001", username: "antonello.prova" });
        if (p === "/v1.0/me/threads" && req.method === "POST") {
          if (body.text && [...body.text].length > 500) return metaError("testo troppo lungo");
          for (const k of ["image_url", "video_url"]) if (body[k]) await download(body[k]);
          return json(200, { id: `thc${++seq}` });
        }
        if (p === "/v1.0/me/threads" && req.method === "GET") return json(200, { data: [{ id: "th-post-1", text: "Ciao Threads", timestamp: "2026-10-14T09:00:00+0000", permalink: "https://www.threads.net/@antonello.prova/post/X", media_type: "TEXT_POST" }] });
        if (p === "/v1.0/me/threads_publish") return json(200, { id: `thp${++seq}` });
        if (p === "/v1.0/me/threads_insights") return json(200, { data: [{ name: "views", values: [{ value: 900 }] }, { name: "followers_count", total_value: { value: 150 } }] });
        if (/\/insights$/.test(p)) return json(200, { data: [{ name: "likes", total_value: { value: 7 } }, { name: "replies", total_value: { value: 2 } }] });
        if (/\/replies$/.test(p)) return json(200, { data: [{ id: "tr-1", text: "Vero!", username: "lucia", timestamp: "2026-10-14T10:00:00+0000" }] });
        const one = p.match(/^\/v1\.0\/([\w-]+)$/);
        if (one) return json(200, q.fields?.includes("permalink") ? { permalink: `https://www.threads.net/@antonello.prova/post/${one[1]}` } : { status: "FINISHED", id: one[1] });
      }
      // ---------------- LinkedIn
      if (host === "www.linkedin.com" && p === "/oauth/v2/authorization") return consent();
      if (host === "www.linkedin.com" && p === "/oauth/v2/accessToken") return json(200, { access_token: "li-token", expires_in: 5183999, scope: "openid,profile,w_member_social" });
      if (host === "api.linkedin.com") {
        if (p === "/v2/userinfo") return json(200, { sub: "abc123", name: "Antonello Prova" });
        if (!req.headers["linkedin-version"] || req.headers["x-restli-protocol-version"] !== "2.0.0") return json(400, { message: "VERSION_MISSING", status: 400 });
        if (p === "/rest/images" && q.action === "initializeUpload") {
          const id = `urn:li:image:img${++seq}`;
          return json(200, { value: { uploadUrlExpiresAt: Date.now() + 3600_000, uploadUrl: `https://upload.linkedin.com/put/${encodeURIComponent(id)}`, image: id } });
        }
        if (p === "/rest/posts") return json(201, {}, { "x-restli-id": `urn:li:share:${++seq}` });
      }
      if (host === "upload.linkedin.com") {
        res.writeHead(201, { etag: `etag-${seq}` });
        return res.end();
      }
      // ---------------- X
      if (host === "x.com" && p === "/i/oauth2/authorize") return consent();
      if (host === "api.x.com") {
        if (p === "/2/oauth2/token") {
          if (!String(req.headers.authorization ?? "").startsWith("Basic ")) return json(401, { error: "unauthorized_client", error_description: "Missing valid authorization header" });
          if (body.grant_type === "authorization_code") {
            const ch = challenges.get(body.code);
            const ok = ch && crypto.createHash("sha256").update(body.code_verifier ?? "").digest("base64url") === ch;
            if (!ok) return json(400, { error: "invalid_request", error_description: "Value passed for the authorization code was invalid." });
            return json(200, { token_type: "bearer", expires_in: 7200, access_token: "x-access-1", refresh_token: "x-refresh-1", scope: "tweet.write" });
          }
          if (body.grant_type === "refresh_token") {
            const n = Number(String(body.refresh_token).split("-").at(-1)) + 1;
            return json(200, { token_type: "bearer", expires_in: 7200, access_token: `x-access-${n}`, refresh_token: `x-refresh-${n}` });
          }
        }
        const auth = String(req.headers.authorization ?? "");
        if (!auth.startsWith("Bearer x-access-")) return json(401, { title: "Unauthorized", detail: "Unauthorized", status: 401 });
        if (p === "/2/users/me") return json(200, { data: { id: "44196397", name: "Antonello", username: "antonello_prova", public_metrics: { followers_count: 80, following_count: 20, tweet_count: 300 } } });
        if (p === "/2/media/upload/initialize") return json(200, { data: { id: `${1000 + ++seq}`, media_key: `3_${seq}`, expires_after_secs: 86400 } });
        if (/^\/2\/media\/upload\/\d+\/append$/.test(p)) {
          res.writeHead(204);
          return res.end();
        }
        if (/^\/2\/media\/upload\/\d+\/finalize$/.test(p)) return json(200, { data: { id: p.split("/")[4], processing_info: { state: "pending", check_after_secs: 1 } } });
        if (p === "/2/media/upload" && q.command === "STATUS") return json(200, { data: { id: q.media_id, processing_info: { state: "succeeded" } } });
        if (p === "/2/tweets") {
          if ([...String(body.text ?? "")].length > 280) return json(400, { title: "Invalid Request", detail: "text too long" });
          return json(201, { data: { id: `18${++seq}`, text: body.text } });
        }
        if (/^\/2\/users\/\d+\/tweets$/.test(p)) return json(200, { data: [{ id: "1801", text: "Post su X", created_at: "2026-10-14T08:00:00.000Z", public_metrics: { like_count: 4, retweet_count: 1, reply_count: 0, impression_count: 230 } }] });
        if (p === "/2/tweets/search/recent") return json(200, { data: [{ id: "1802", text: "@antonello_prova bello", author_id: "7", created_at: "2026-10-14T09:00:00.000Z" }], includes: { users: [{ id: "7", username: "pino" }] } });
      }
      // ---------------- Gemini
      if (host === "generativelanguage.googleapis.com") {
        if (p === "/v1beta/models") {
          const k = String(req.headers["x-goog-api-key"] ?? "");
          if (k.startsWith("AQ.rifiutata")) return json(401, { error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED", details: [{ reason: "ACCESS_TOKEN_TYPE_UNSUPPORTED" }] } });
          if (!k || k.includes("sbagliata")) return json(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } });
          return json(200, { models: [{ name: "models/gemini-2.5-flash-image" }] });
        }
        const model = p.match(/models\/([^:]+):generateContent/)?.[1];
        if (opts.geminiFirstModel404 && model === "gemini-3.1-flash-image-preview") return json(404, { error: { code: 404, message: `models/${model} is not found`, status: "NOT_FOUND" } });
        if (!req.headers["x-goog-api-key"]) return json(400, { error: { code: 400, message: "API key not valid." } });
        if (/vietat/i.test(body.contents?.[0]?.parts?.[0]?.text ?? "")) return json(200, { candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }] });
        return json(200, { candidates: [{ content: { parts: [{ text: "Ecco l'immagine" }, { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] }, finishReason: "STOP" }] });
      }
      json(404, { error: { message: `percorso finto sconosciuto: ${host}${p}` } });
    } catch (err) {
      json(500, { error: { message: err.message } });
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    fetched,
    opts,
    close: () => new Promise((r) => server.close(r)),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const f = await startFakeSocial({ port: Number(process.argv[2]) || 0 });
  console.log(`finto server dei social su ${f.url}`);
}
