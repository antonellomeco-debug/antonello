// Accesso con password e protezioni del server in cloud: il vero server.js gira in un processo a parte con
// APP_PASSWORD e PUBLIC_URL, come su Railway. Più la verifica che sul Mac (nessuna variabile) tutto resti come prima.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, tempDir, freePort } from "./helpers/server.js";
import { startFake } from "./helpers/fake-ctrader.js";

const PASSWORD = "cavallo-batteria-graffetta";
const PUBLIC = "https://agenti.example.test";
const fake = await startFake();
const CTRADER_ENV = {
  CTRADER_TLS: "0",
  CTRADER_DEMO_HOST: "127.0.0.1",
  CTRADER_LIVE_HOST: "127.0.0.1",
  CTRADER_PORT: String(fake.port),
  CTRADER_AUTH_URL: "http://127.0.0.1/auth",
  CTRADER_TOKEN_URL: `http://127.0.0.1:${fake.tokenPort}/apps/token`,
};
const CLOUD_ENV = { APP_PASSWORD: PASSWORD, PUBLIC_URL: PUBLIC, HOST: "127.0.0.1", SSE_PING_MS: "200", ...CTRADER_ENV };

const running = [];
async function start(env, opts) {
  const s = await startServer(env, opts);
  running.push(s);
  return s;
}
after(async () => {
  await Promise.all(running.map((s) => s.stop()));
  await fake.close();
});

const json = (body, headers = {}) => ({ body, headers: { "content-type": "application/json", ...headers } });
const cookieOf = (res) => String(res.headers["set-cookie"]?.[0] ?? "").split(";")[0];

const cloud = await start(CLOUD_ENV);
let cookie = "";

test("senza accesso: le API e la diretta rispondono 401, le pagine portano a /login", async () => {
  for (const [method, p] of [["GET", "/api/office"], ["GET", "/api/broker"], ["GET", "/api/backup"], ["POST", "/api/agents"], ["PUT", "/api/settings"], ["POST", "/api/approvals/1"]]) {
    const r = await cloud.req(method, p, json({}));
    assert.equal(r.status, 401, `${method} ${p}`);
    assert.deepEqual(r.json, { error: "Accesso richiesto", login: true });
  }
  const sse = await cloud.req("GET", "/api/events");
  assert.equal(sse.status, 401);
  assert.notEqual(sse.headers["content-type"], "text/event-stream");

  const home = await cloud.req("GET", "/", { headers: { accept: "text/html" } });
  assert.equal(home.status, 302);
  assert.equal(home.headers.location, "/login?next=%2F");
  const deep = await cloud.req("GET", "/app.js?v=1");
  assert.equal(deep.headers.location, `/login?next=${encodeURIComponent("/app.js?v=1")}`);
  const evil = await cloud.req("GET", "//evil.example/x");
  assert.equal(evil.status, 302);
  assert.equal(evil.headers.location, "/login?next=%2F", "next solo verso questo sito");
});

test("senza accesso: le pagine pubbliche restano raggiungibili", async () => {
  assert.deepEqual((await cloud.req("GET", "/healthz")).json, { ok: true });
  const s = await cloud.req("GET", "/api/session");
  assert.deepEqual(s.json, { auth: true, loggedIn: false, cloud: true, updater: false, publicUrl: PUBLIC, volumeOk: true });
  for (const p of ["/login", "/login.js", "/manifest.webmanifest", "/sw.js", "/offline.html", "/icons/icon-192.png", "/favicon.ico"]) {
    const r = await cloud.req("GET", p);
    assert.ok(r.status !== 401 && r.status !== 302, `${p}: ${r.status}`); // 200, o 404 se il file non c'è ancora
  }
  assert.equal((await cloud.req("GET", "/icons/..%2Fapp.js")).status, 302, "niente scorciatoie dalla cartella icons");
});

test("intestazioni di sicurezza", async () => {
  const r = await cloud.req("GET", "/api/session");
  const csp = r.headers["content-security-policy"];
  assert.match(csp, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/, "impronta dell'importmap di index.html");
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
  assert.match(csp, /connect-src 'self'/);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["referrer-policy"], "same-origin");
  assert.match(r.headers["strict-transport-security"], /max-age=\d+/);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["x-powered-by"], undefined);
});

test("password sbagliata: 401; giusta: cookie __Host- HttpOnly, SameSite=Lax, Secure, 60 giorni", async () => {
  const bad = await cloud.req("POST", "/api/login", json({ password: "sbagliata-123" }));
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.json, { error: "Password sbagliata" });
  assert.equal(bad.headers["set-cookie"], undefined);

  const ok = await cloud.req("POST", "/api/login", json({ password: PASSWORD }, { origin: PUBLIC }));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });
  const set = ok.headers["set-cookie"][0];
  assert.match(set, /^__Host-agenti=[A-Za-z0-9_-]{43};/);
  for (const flag of ["HttpOnly", "SameSite=Lax", "Secure", "Path=/", "Max-Age=5184000"]) assert.ok(set.split("; ").includes(flag), `${flag} in ${set}`);
  assert.doesNotMatch(set, /Domain=/i);
  cookie = cookieOf(ok);

  const auth = fs.readFileSync(path.join(cloud.dataDir, "auth.json"), "utf8");
  assert.equal(auth.includes(PASSWORD), false, "la password non è salvata");
  assert.equal(auth.includes(cookie.split("=")[1]), false, "il codice della sessione non è salvato in chiaro");
  assert.equal(fs.statSync(path.join(cloud.dataDir, "auth.json")).mode & 0o777, 0o600);
  assert.match(cloud.output(), /password sbagliata/, "i tentativi finiscono nel registro");
  assert.equal(cloud.output().includes("sbagliata-123"), false, "mai la password nel registro");
});

test("con il cookie l'app funziona", async () => {
  const office = await cloud.req("GET", "/api/office", { headers: { cookie } });
  assert.equal(office.status, 200);
  assert.ok(Array.isArray(office.json.agents));
  assert.equal((await cloud.req("GET", "/api/session", { headers: { cookie } })).json.loggedIn, true);
  const home = await cloud.req("GET", "/", { headers: { cookie } });
  assert.equal(home.status, 200);
  assert.match(home.body, /<script type="importmap">/);
  const broker = await cloud.req("GET", "/api/broker", { headers: { cookie } });
  assert.equal(broker.json.redirectUri, `${PUBLIC}/ctrader/callback`, "indirizzo di ritorno di cTrader da PUBLIC_URL");
});

test("indirizzo (Host) e richieste da altri siti (Origin)", async () => {
  const wrongHost = await cloud.req("GET", "/api/office", { headers: { cookie, host: "evil.example" } });
  assert.equal(wrongHost.status, 403);
  assert.equal((await cloud.req("GET", "/api/office", { headers: { cookie, host: "agenti.example.test" } })).status, 200);
  assert.equal((await cloud.req("GET", "/healthz", { headers: { host: "healthcheck.railway.app" } })).status, 200, "/healthz risponde con qualsiasi Host");

  const csrf = await cloud.req("POST", "/api/chat/reset", json({}, { cookie, origin: "https://evil.example" }));
  assert.equal(csrf.status, 403);
  const httpOrigin = await cloud.req("POST", "/api/chat/reset", json({}, { cookie, origin: "http://agenti.example.test" }));
  assert.equal(httpOrigin.status, 403, "lo schema conta: http:// non è https://");
  assert.equal((await cloud.req("POST", "/api/chat/reset", json({}, { cookie, origin: PUBLIC }))).status, 200);
  assert.equal((await cloud.req("POST", "/api/chat/reset", json({}, { cookie }))).status, 200, "senza Origin passa (serve comunque il cookie)");
});

test("diretta (SSE): intestazioni giuste, ping ogni 25 s (qui accelerato), al massimo 10 flussi", async () => {
  const http = await import("node:http");
  const open = () =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: cloud.port, path: "/api/events", headers: { cookie } }, (res) => resolve({ req, res }));
      req.on("error", reject);
      req.end();
    });
  const first = await open();
  assert.equal(first.res.statusCode, 200);
  assert.match(first.res.headers["content-type"], /^text\/event-stream/);
  assert.equal(first.res.headers["cache-control"], "no-cache, no-transform");
  assert.equal(first.res.headers["x-accel-buffering"], "no");
  const ping = await new Promise((resolve) => {
    let buf = "";
    first.res.on("data", (d) => {
      buf += d;
      const m = buf.match(/data: (\{"type":"ping".*?\})\n\n/);
      if (m) resolve(JSON.parse(m[1]));
    });
  });
  assert.equal(ping.type, "ping");
  assert.ok(!Number.isNaN(Date.parse(ping.at)));
  const more = [];
  for (let i = 0; i < 9; i++) more.push(await open());
  assert.ok(more.every((s) => s.res.statusCode === 200));
  const extra = await cloud.req("GET", "/api/events", { headers: { cookie } });
  assert.equal(extra.status, 503, "l'undicesimo flusso è rifiutato");
  for (const s of [first, ...more]) s.req.destroy();
  await new Promise((r) => setTimeout(r, 200));
  const again = await open();
  assert.equal(again.res.statusCode, 200, "chiusi i flussi, se ne possono aprire di nuovi");
  again.req.destroy();
});

test("conferma con password: sbloccare il conto reale e cancellare i dati", async () => {
  const unlock = { enabled: true, confirm: "SOLDI VERI" };
  const missing = await cloud.req("POST", "/api/safety/live", json(unlock, { cookie }));
  assert.equal(missing.status, 401);
  assert.deepEqual(missing.json, { error: "Password sbagliata", stepUp: true }, "nessun login:true: l'interfaccia non deve tornare alla pagina di accesso");
  const wrong = await cloud.req("POST", "/api/safety/live", json({ ...unlock, password: "non-e-lei-123" }, { cookie }));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.stepUp, true);
  const right = await cloud.req("POST", "/api/safety/live", json({ ...unlock, password: PASSWORD }, { cookie }));
  assert.equal(right.status, 200);
  assert.equal(right.json.safety.liveEnabled, true);
  const lock = await cloud.req("POST", "/api/safety/live", json({ enabled: false }, { cookie }));
  assert.equal(lock.status, 200, "bloccare il conto reale non chiede la password");
  assert.equal(lock.json.safety.liveEnabled, false);

  assert.equal((await cloud.req("POST", "/api/reset", json({}, { cookie }))).json.stepUp, true);
  assert.equal((await cloud.req("POST", "/api/reset", json({ password: PASSWORD }, { cookie }))).status, 200);
});

test("aggiornamento dall'app spento sul server", async () => {
  const msg = "Sul server gli aggiornamenti arrivano da soli da GitHub: non serve fare niente.";
  const get = await cloud.req("GET", "/api/update", { headers: { cookie } });
  assert.equal(get.json.canUpdate, false);
  assert.equal(get.json.reason, msg);
  const post = await cloud.req("POST", "/api/update", json({}, { cookie }));
  assert.equal(post.status, 400);
  assert.equal(post.json.error, msg);
});

test("ritorno da cTrader: senza accesso solo con lo state giusto, e una volta sola", async () => {
  await cloud.req("PUT", "/api/broker/credentials", json({ clientId: "client-ok", clientSecret: "secret-ok" }, { cookie }));
  const { json: auth } = await cloud.req("POST", "/api/broker/auth", json({}, { cookie }));
  const url = new URL(auth.url);
  const state = url.searchParams.get("state");
  assert.ok(state);
  assert.equal(url.searchParams.get("redirect_uri"), `${PUBLIC}/ctrader/callback`);

  const wrong = await cloud.req("GET", "/ctrader/callback?code=code-ok&state=sbagliato");
  assert.equal(wrong.status, 302, "state sbagliato e nessun accesso: alla pagina di accesso");
  assert.match(wrong.headers.location, /^\/login\?next=/);
  const none = await cloud.req("GET", "/ctrader/callback?code=code-ok");
  assert.equal(none.status, 302);

  const ok = await cloud.req("GET", `/ctrader/callback?code=code-ok&state=${encodeURIComponent(state)}`);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /cTrader collegato: torna all'app/);
  assert.equal(ok.headers["cache-control"], "no-store");
  assert.equal((await cloud.req("GET", "/api/broker", { headers: { cookie } })).json.linked, true);

  const reuse = await cloud.req("GET", `/ctrader/callback?code=code-ok&state=${encodeURIComponent(state)}`);
  assert.equal(reuse.status, 302, "lo state vale una volta sola");

  // Con l'accesso fatto (stesso browser dell'app) si torna all'app come prima.
  const again = await cloud.req("POST", "/api/broker/auth", json({}, { cookie }));
  const s2 = new URL(again.json.url).searchParams.get("state");
  const back = await cloud.req("GET", `/ctrader/callback?code=code-ok&state=${encodeURIComponent(s2)}`, { headers: { cookie } });
  assert.equal(back.status, 302);
  assert.equal(back.headers.location, "/#broker");
});

test("uscita: il cookie viene cancellato e non vale più", async () => {
  const out = await cloud.req("POST", "/api/logout", json({}, { cookie, origin: PUBLIC }));
  assert.deepEqual(out.json, { ok: true });
  assert.match(out.headers["set-cookie"][0], /^__Host-agenti=; Max-Age=0;/);
  assert.equal((await cloud.req("GET", "/api/office", { headers: { cookie } })).status, 401);
});

test("le sessioni sopravvivono al riavvio; cambiando APP_PASSWORD non valgono più", async () => {
  const dataDir = tempDir("auth-restart-");
  let s = await start(CLOUD_ENV, { dataDir });
  const c = cookieOf(await s.req("POST", "/api/login", json({ password: PASSWORD })));
  await s.stop();
  s = await start(CLOUD_ENV, { dataDir });
  assert.equal((await s.req("GET", "/api/office", { headers: { cookie: c } })).status, 200, "stesso cookie dopo il riavvio");
  await s.stop();
  s = await start({ ...CLOUD_ENV, APP_PASSWORD: "una-password-nuova" }, { dataDir });
  assert.equal((await s.req("GET", "/api/office", { headers: { cookie: c } })).status, 401, "password cambiata: tutti rifanno l'accesso");
  assert.equal((await s.req("POST", "/api/login", json({ password: PASSWORD }))).status, 401);
  assert.equal((await s.req("POST", "/api/login", json({ password: "una-password-nuova" }))).status, 200);
  await s.stop();
});

test("troppi tentativi: dietro il proxy 5 errori per indirizzo in 15 minuti, poi attese crescenti ma mai un blocco", async () => {
  const s = await start({ ...CLOUD_ENV, TRUST_PROXY: "1" });
  const from = (ip, password) => s.req("POST", "/api/login", json({ password }, { "x-forwarded-for": ip }));
  for (let i = 0; i < 5; i++) assert.equal((await from("203.0.113.5", `sbagliata-${i}`)).status, 401);
  const limited = await from("203.0.113.5", PASSWORD);
  assert.equal(limited.status, 429, "anche con la password giusta, finché dura il limite");
  assert.match(limited.json.error, /^Troppi tentativi: riprova tra \d+ minut[oi]$/);
  assert.ok(limited.json.retryAfter > 0 && limited.json.retryAfter <= 900);
  assert.equal(limited.headers["retry-after"], String(limited.json.retryAfter));
  // Un altro indirizzo non è bloccato; dopo 10 errori in tutto ogni tentativo aspetta (qui 1 secondo).
  for (let i = 0; i < 5; i++) assert.equal((await from(`198.51.100.${i}`, "ancora-sbagliata")).status, 401);
  const t0 = Date.now();
  const owner = await from("192.0.2.77", PASSWORD);
  assert.equal(owner.status, 200, "il proprietario entra comunque");
  assert.ok(Date.now() - t0 >= 900, `attesa dopo 10 errori (${Date.now() - t0} ms)`);
  await s.stop();
});

test("raffica di tentativi insieme dallo stesso indirizzo: contano tutti, e il proprietario entra subito", async () => {
  const s = await start({ ...CLOUD_ENV, TRUST_PROXY: "1" });
  const from = (ip, password) => s.req("POST", "/api/login", json({ password }, { "x-forwarded-for": ip }));
  const flood = await Promise.all(Array.from({ length: 30 }, (_, i) => from("203.0.113.66", `raffica-${i}`)));
  const wrong = flood.filter((r) => r.status === 401).length;
  assert.ok(wrong <= 5, `al massimo 5 password controllate per indirizzo (${wrong})`);
  assert.equal(wrong + flood.filter((r) => r.status === 429).length, 30);
  const t0 = Date.now();
  assert.equal((await from("192.0.2.10", PASSWORD)).status, 200);
  assert.ok(Date.now() - t0 < 3000, `il proprietario non resta in fila (${Date.now() - t0} ms)`);
  await s.stop();
});

test("password solo come testo: un elenco di tentativi non vale", async () => {
  const r = await cloud.req("POST", "/api/login", json({ password: ["sbagliata-1", "sbagliata-2", PASSWORD] }));
  assert.equal(r.status, 401);
  const c = cookieOf(await cloud.req("POST", "/api/login", json({ password: PASSWORD })));
  const live = await cloud.req("POST", "/api/safety/live", json({ enabled: true, confirm: "SOLDI VERI", password: ["x", PASSWORD] }, { cookie: c, origin: PUBLIC }));
  assert.equal(live.status, 401);
  assert.equal(live.json.stepUp, true);
});

test("dopo l'accesso si torna solo a pagine di questo sito (niente /.//altro-sito)", async () => {
  const c = cookieOf(await cloud.req("POST", "/api/login", json({ password: PASSWORD })));
  for (const next of ["/.//evil.example/x", "/%2e//evil.example/x", "/a/..//evil.example/y", "//evil.example", "https://evil.example"]) {
    const r = await cloud.req("GET", `/login?next=${encodeURIComponent(next)}`, { headers: { cookie: c } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/", `next=${next}`);
  }
  const ok = await cloud.req("GET", `/login?next=${encodeURIComponent("/?x=1")}`, { headers: { cookie: c } });
  assert.equal(ok.headers.location, "/?x=1");
});

test("senza proxy noto nessun limite per indirizzo (sarebbero tutti lo stesso indirizzo)", async () => {
  const s = await start(CLOUD_ENV);
  for (let i = 0; i < 7; i++) assert.equal((await s.req("POST", "/api/login", json({ password: `no-${i}` }, { "x-forwarded-for": "203.0.113.9" }))).status, 401);
  assert.equal((await s.req("POST", "/api/login", json({ password: PASSWORD }))).status, 200);
  await s.stop();
});

test("configurazione insicura: pagina che spiega cosa fare, mai l'app senza protezione", async () => {
  const cases = [
    { PUBLIC_URL: PUBLIC }, // in cloud senza password
    { PUBLIC_URL: PUBLIC, APP_PASSWORD: "corta" }, // password troppo corta
    { HOST: "0.0.0.0" }, // raggiungibile da altri computer senza password
    { RAILWAY_PUBLIC_DOMAIN: "agenti.up.railway.app", HOST: "0.0.0.0" },
  ];
  for (const env of cases) {
    const s = await start(env);
    const page = await s.req("GET", "/");
    assert.equal(page.status, 503, JSON.stringify(env));
    assert.match(page.body, /imposta la variabile <code>APP_PASSWORD<\/code> con una password di almeno 10 caratteri e riavvia/i);
    const api = await s.req("GET", "/api/office");
    assert.equal(api.status, 503);
    assert.match(api.json.error, /APP_PASSWORD/);
    assert.equal((await s.req("POST", "/api/login", json({ password: "x" }))).status, 503);
    assert.equal((await s.req("GET", "/healthz", { headers: { host: "healthcheck.railway.app" } })).status, 200);
    await s.stop();
  }
});

test("Railway: indirizzo pubblico da RAILWAY_PUBLIC_DOMAIN, dati nel volume RAILWAY_VOLUME_MOUNT_PATH", async () => {
  const volume = tempDir("railway-volume-");
  const s = await start(
    { APP_PASSWORD: PASSWORD, HOST: "127.0.0.1", RAILWAY_PUBLIC_DOMAIN: "agenti.up.railway.app", RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: volume, AGENTI_DATA_DIR: "" },
  );
  const session = (await s.req("GET", "/api/session")).json;
  assert.equal(session.publicUrl, "https://agenti.up.railway.app");
  assert.equal(session.volumeOk, true);
  const c = cookieOf(await s.req("POST", "/api/login", json({ password: PASSWORD })));
  assert.equal((await s.req("GET", "/api/broker", { headers: { cookie: c } })).json.redirectUri, "https://agenti.up.railway.app/ctrader/callback");
  assert.ok(fs.existsSync(path.join(volume, "building.json")), "i dati sono nel volume");
  assert.ok(fs.existsSync(path.join(volume, "auth.json")));
  await s.stop();
});

test("sul Mac (nessuna variabile) tutto come prima: niente password, solo localhost", async () => {
  const mac = await start({});
  const session = (await mac.req("GET", "/api/session")).json;
  assert.deepEqual(session, { auth: false, loggedIn: true, cloud: false, updater: true, publicUrl: null, volumeOk: true });
  assert.equal((await mac.req("GET", "/")).status, 200);
  assert.equal((await mac.req("GET", "/api/office")).status, 200);
  assert.equal((await mac.req("PUT", "/api/schedule", json({}, { origin: `http://localhost:${mac.port}`, host: `localhost:${mac.port}` }))).status, 200);
  assert.equal((await mac.req("PUT", "/api/schedule", json({}, { origin: "http://evil.example" }))).status, 403);
  assert.equal((await mac.req("GET", "/api/office", { headers: { host: "evil.example" } })).status, 403, "DNS rebinding bloccato");
  assert.equal((await mac.req("GET", "/api/broker")).json.redirectUri, `http://localhost:${mac.port}/ctrader/callback`);
  assert.equal((await mac.req("POST", "/api/reset", json({}))).status, 200, "nessuna conferma con password sul Mac");
  const r = await mac.req("GET", "/api/office");
  assert.equal(r.headers["strict-transport-security"], undefined);
  assert.equal(fs.existsSync(path.join(mac.dataDir, "auth.json")), false, "sul Mac nessun file di accesso");
  const sig = await mac.stop();
  assert.equal(sig.code, 0, "chiusura ordinata con SIGTERM");
});

test("password con lettere accentate o € nell'intestazione X-Agenti-Password (anche codificata)", async () => {
  const pw = "città-del-€uro-2026";
  const s = await start({ ...CLOUD_ENV, APP_PASSWORD: pw });
  const c = cookieOf(await s.req("POST", "/api/login", json({ password: pw })));
  const upload = (header) => s.req("POST", "/api/backup", { body: Buffer.alloc(0), headers: { cookie: c, "content-type": "application/zip", "x-agenti-password": header } });
  const encoded = await upload(encodeURIComponent(pw));
  assert.equal(encoded.status, 400, "password giusta: si arriva al controllo del file");
  assert.match(encoded.json.error, /Scegli il file \.zip/);
  assert.equal((await upload(Buffer.from(pw, "utf8").toString("latin1"))).status, 400, "anche mandata così com'è (UTF-8)");
  assert.equal((await upload(encodeURIComponent("città-del-euro-2026"))).status, 401);
  await s.stop();
});

test("porta occupata: sul Mac 'già aperto' (uscita 0), sul server errore (uscita 1)", async () => {
  const port = await freePort();
  const first = await start({}, { port });
  const mac = await start({}, { port, wait: false });
  assert.equal((await mac.exited).code, 0);
  const srv = await start(CLOUD_ENV, { port, wait: false });
  assert.equal((await srv.exited).code, 1);
  await first.stop();
});
