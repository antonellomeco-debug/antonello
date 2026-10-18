// Notifiche sul telefono: iscrizione, notifiche cifrate come vuole lo standard Web Push (si decifrano con la chiave
// del "telefono"), raggruppamento, preferenze, dispositivi spariti. Un finto servizio di notifiche riceve le richieste.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ece = require("http_ece");

const received = [];
let answer = 201;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(answer).end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}`;

Object.assign(process.env, {
  AGENTI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "push-test-")),
  MARKET_MODE: "demo",
  PUSH_TEST_ENDPOINT_PREFIX: `${base}/push/`,
  PUSH_BATCH_MS: "600000",
});
const push = await import("../lib/push.js");
const { addApproval, postNote, bus } = await import("../lib/store.js");

/** Un "telefono": chiavi come quelle che crea il browser. */
function phone(name) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    sub: { endpoint: `${base}/push/${name}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } },
  };
}
const decrypt = (p, body) => JSON.parse(ece.decrypt(body, { version: "aes128gcm", privateKey: p.ecdh, authSecret: p.auth.toString("base64url") }).toString());

test("iscrizione: solo servizi di notifica veri, chiavi controllate, niente doppioni", () => {
  assert.throws(() => push.subscribe({ endpoint: "https://evil.example.com/x", keys: phone("a").sub.keys }), /non valida/);
  assert.throws(() => push.subscribe({ endpoint: "http://127.0.0.1:1/x", keys: phone("a").sub.keys }), /non valida/);
  assert.throws(() => push.subscribe({ endpoint: `${base}/push/x`, keys: { p256dh: "corta", auth: "x" } }), /chiavi/);
  const p = phone("iphone");
  push.subscribe(p.sub, "iPhone");
  const st = push.subscribe(p.sub, "iPhone <script>");
  assert.equal(st.devices.length, 1);
  assert.equal(st.devices[0].label, "iPhone script");
  assert.match(st.publicKey, /^[A-Za-z0-9_-]{80,}$/);
  push.unsubscribe(p.sub.endpoint);
  assert.equal(push.pushStatus().devices.length, 0);
});

test("da approvare: una notifica cifrata (si legge solo con la chiave del telefono), più eventi insieme diventano una", async () => {
  const p = phone("iphone2");
  push.subscribe(p.sub, "iPhone");
  received.length = 0;
  addApproval({ id: "editore", name: "Editore", room: "sala", target: { mode: "social", network: "instagram", label: "Instagram" } }, null, { kind: "post", postId: "p1", post: { network: "instagram", text: "Come trovare il primo investitore" } });
  assert.equal(await push.flush(), 1);
  assert.equal(received.length, 1);
  const r = received[0];
  assert.equal(r.headers["content-encoding"], "aes128gcm");
  assert.match(r.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  assert.equal(r.headers.urgency, "high");
  assert.ok(!r.body.includes("investitore"), "il contenuto viaggia cifrato");
  const n = decrypt(p, r.body);
  assert.equal(n.title, "✅ Post da approvare · Instagram");
  assert.match(n.body, /^Editore: Come trovare/);
  assert.equal(n.url, "/#approvals");
  assert.equal(n.badge, 1, "numerino sull'icona");

  received.length = 0;
  addApproval({ id: "trader", name: "Capo Trader", room: "sala" }, { symbol: "XAUUSD", side: "buy", lots: 0.01 });
  postNote("sala", { id: "brand", name: "Brand Manager" }, "Mi mandi il logo in alta qualità?", ["RICHIESTA"]);
  await push.flush();
  assert.equal(received.length, 1, "due eventi insieme: una notifica sola");
  const both = decrypt(p, received[0].body);
  assert.equal(both.title, "✅ 2 cose da approvare");
  assert.match(both.body, /Acquisto XAUUSD 0.01 lotti · domanda di Brand Manager/);
  assert.equal(both.badge, 3);
});

test("post pubblicati e non riusciti; preferenze; i post pubblicati a mano non si notificano", async () => {
  const p = phone("iphone3");
  push.subscribe(p.sub, "iPhone");
  received.length = 0;
  const ev = (o) => bus.emit("event", { type: "post-status", label: "Threads", reply: false, manual: false, text: "Ciao a tutti", url: "https://www.threads.net/@x/post/1", ...o });
  ev({ status: "published" });
  ev({ status: "published", manual: true });
  ev({ status: "published", reply: true, label: "X" });
  await push.flush();
  assert.equal(received.length, 2, "una notifica per ogni telefono iscritto (2 telefoni)");
  const mine = received.filter((r) => r.path === "/push/iphone3").map((r) => decrypt(p, r.body));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, "📣 Pubblicato su Threads", "risposte e post a mano esclusi");
  assert.equal(mine[0].url, "https://www.threads.net/@x/post/1");

  received.length = 0;
  push.setPrefs({ replies: true, approvals: false });
  ev({ status: "published", reply: true, label: "X" });
  ev({ status: "failed", error: "limite di 5 post al giorno" });
  addApproval({ id: "a", name: "A", room: "sala" }, { symbol: "EURUSD", side: "sell", lots: 0.01 });
  await push.flush();
  const titles = received.filter((r) => r.path === "/push/iphone3").map((r) => decrypt(p, r.body).title);
  assert.deepEqual(titles.sort(), ["⚠️ Non pubblicato su Threads", "📣 Risposta pubblicata su X"]);
});

test("report delle spese: notifica che apre 💰 Spesa; si può spegnere; le note normali no", async () => {
  const p = phone("iphone4");
  push.subscribe(p.sub, "iPhone");
  received.length = 0;
  postNote("sala", { id: "contabile", name: "Contabile Social" }, "REPORT SPESE — settimana 12–18 ottobre: 1,20 $ (+15%).", []);
  postNote("sala", { id: "contabile", name: "Contabile Social" }, "appunti di lavoro", ["SPESE"]);
  await push.flush();
  const mine = received.filter((r) => r.path === "/push/iphone4").map((r) => decrypt(p, r.body));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, "📑 Report delle spese · Contabile Social");
  assert.match(mine[0].body, /^settimana 12–18 ottobre/);
  assert.equal(mine[0].url, "/#costs");

  received.length = 0;
  push.setPrefs({ reports: false });
  postNote("sala", { id: "contabile", name: "Contabile Social" }, "Mese di ottobre", ["REPORT SPESE"]);
  await push.flush();
  assert.equal(received.filter((r) => r.path === "/push/iphone4").length, 0);
  push.setPrefs({ reports: true });
  push.unsubscribe(p.sub.endpoint);
});

test("dispositivo sparito (410): tolto dall'elenco; prova manuale", async () => {
  push.setPrefs({ approvals: true });
  answer = 410;
  const r = await push.sendTest();
  assert.equal(r.sent, 0);
  assert.equal(push.pushStatus().devices.length, 0, "i dispositivi che il servizio non conosce più si tolgono");
  answer = 201;
  const p = phone("nuovo");
  push.subscribe(p.sub, "Mac");
  received.length = 0;
  assert.equal((await push.sendTest()).sent, 1);
  assert.equal(decrypt(p, received[0].body).title, "🔔 Notifiche attive");
});
