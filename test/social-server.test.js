// Social sul vero server: caricamento di foto e video (anche troppo grandi), indirizzi pubblici dei file,
// collegamento solo dal server per Instagram, ritorno dal social. Sul Mac (senza password).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import sharp from "sharp";
import { startServer } from "./helpers/server.js";

const srv = await startServer();
after(() => srv.stop());
const origin = { origin: `http://localhost:${srv.port}`, host: `localhost:${srv.port}` };

test("caricamento di una foto: JPEG nell'archivio, file pubblico con codice, anteprima", async () => {
  const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#228844" } }).png().toBuffer();
  const r = await srv.req("POST", "/api/media", { body: png, headers: { ...origin, "content-type": "image/png", "x-file-name": encodeURIComponent("prato verde.png") } });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.json.title, "prato verde");
  assert.equal(r.json.mime, "image/jpeg");
  const file = await srv.req("GET", r.json.src, { raw: true, headers: { host: origin.host } });
  assert.equal(file.status, 200);
  assert.equal(file.headers["content-type"], "image/jpeg");
  assert.equal(file.headers["x-robots-tag"], "noindex");
  assert.equal((await sharp(file.body).metadata()).width, 640);
  assert.equal((await srv.req("GET", r.json.thumb, { headers: { host: origin.host } })).status, 200);
  assert.equal((await srv.req("GET", "/m/codice-che-non-esiste-123456.jpg", { headers: { host: origin.host } })).status, 404);
  assert.equal((await srv.req("GET", "/m/../social.json", { headers: { host: origin.host } })).status, 404);
  const list = await srv.req("GET", "/api/media", { headers: { host: origin.host } });
  assert.equal(list.json.length, 1);
  const upd = await srv.req("PUT", `/api/media/${r.json.id}`, { body: { description: "Prato" }, headers: origin });
  assert.equal(upd.json.description, "Prato");
  assert.equal((await srv.req("DELETE", `/api/media/${r.json.id}`, { headers: origin })).status, 200);
  assert.equal((await srv.req("GET", r.json.src, { headers: { host: origin.host } })).status, 404, "file eliminato: non più raggiungibile");
});

test("caricamenti rifiutati: troppo grandi, vuoti, formato sbagliato, da un altro sito", async () => {
  // Dichiara 41 MB: il server risponde subito, senza aspettare il file.
  const big = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: srv.port, method: "POST", path: "/api/media", headers: { ...origin, "content-type": "image/jpeg", "content-length": 41 * 1024 * 1024 } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject);
    req.write(Buffer.alloc(1024));
  });
  assert.equal(big.status, 413);
  assert.match(big.body, /massimo 40 MB/);
  const empty = await srv.req("POST", "/api/media", { body: Buffer.alloc(0), headers: { ...origin, "content-type": "image/jpeg" } });
  assert.equal(empty.status, 400);
  const pdf = await srv.req("POST", "/api/media", { body: Buffer.from("%PDF-1.4"), headers: { ...origin, "content-type": "application/pdf" } });
  assert.equal(pdf.status, 400);
  assert.match(pdf.json.error, /formato non supportato/);
  const evil = await srv.req("POST", "/api/media", { body: Buffer.from("x"), headers: { origin: "https://sito-cattivo.example", host: origin.host, "content-type": "image/jpeg" } });
  assert.equal(evil.status, 403);
});

test("sul Mac Instagram e Threads non si collegano (serve il server online); X sì", async () => {
  const st = await srv.req("GET", "/api/social", { headers: { host: origin.host } });
  assert.equal(st.json.publicServer, false);
  assert.equal(st.json.redirectUri, `http://localhost:${srv.port}/social/callback`);
  await srv.req("PUT", "/api/social/instagram/app", { body: { clientId: "123456", clientSecret: "abc" }, headers: origin });
  const ig = await srv.req("POST", "/api/social/instagram/auth", { headers: origin });
  assert.equal(ig.status, 400);
  assert.match(ig.json.error, /solo dal server online/);
  await srv.req("PUT", "/api/social/x/app", { body: { clientId: "x-client-id", clientSecret: "abc" }, headers: origin });
  const x = await srv.req("POST", "/api/social/x/auth", { headers: origin });
  assert.match(x.json.url, /^https:\/\/x\.com\/i\/oauth2\/authorize\?/);
  assert.match(x.json.url, /code_challenge_method=S256/);
  const bad = await srv.req("PUT", "/api/social/facebook/app", { body: { clientId: "1234" }, headers: origin });
  assert.equal(bad.status, 400);
  const back = await srv.req("GET", "/social/callback?state=sbagliato&code=abc", { headers: { host: origin.host } });
  assert.equal(back.status, 400);
  assert.match(back.body, /Collegamento scaduto o già usato/);
  const denied = await srv.req("GET", "/social/callback?error=access_denied&error_description=Annullato", { headers: { host: origin.host } });
  assert.match(denied.body, /Collegamento annullato/);
});
