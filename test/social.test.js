// Social: accesso agli account (OAuth), archivio di foto e video, grafiche, immagini IA, post proposti, approvati,
// automatici e programmati, statistiche e commenti. Tutto contro il finto server di test/helpers/fake-social.js.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import sharp from "sharp";
import { startFakeSocial } from "./helpers/fake-social.js";

const fake = await startFakeSocial();
// Piccolo server che fa da "indirizzo pubblico" dell'app: serve i file dell'archivio come /m/<codice>.
let media;
const pub = http.createServer((req, res) => {
  const f = media?.fileForPublicName(decodeURIComponent(req.url.slice(3)));
  if (!req.url.startsWith("/m/") || !f) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": f.mime });
  fs.createReadStream(f.file).pipe(res);
});
await new Promise((r) => pub.listen(0, "127.0.0.1", r));
after(() => Promise.all([fake.close(), new Promise((r) => pub.close(r))]));

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "social-test-"));
Object.assign(process.env, {
  AGENTI_DATA_DIR: DATA,
  MARKET_MODE: "demo",
  SOCIAL_API_BASE: fake.url,
  SOCIAL_POLL_MS: "5",
  PUBLIC_URL: `http://127.0.0.1:${pub.address().port}`,
});
media = await import("../lib/social/media.js");
const social = await import("../lib/social/index.js");
const { getState } = await import("../lib/store.js");
const { setGeminiKey, generateImage } = await import("../lib/social/imagegen.js");
const { linkedinText } = await import("../lib/social/networks.js");

const agent = { id: "editore", name: "Editore", room: "sala" };
const cost = () => getState().usage.costUsd;

/** Collega un social come farebbe l'utente: «Collega» → pagina del social → ritorno con codice e state. */
async function connect(net) {
  social.setApp(net, { clientId: `${net}-app-id`, clientSecret: "segreto-di-prova" });
  const { url } = social.startAuth(net);
  const r = await fetch(url, { redirect: "manual" });
  const back = new URL(r.headers.get("location"));
  assert.equal(back.pathname, "/social/callback");
  return social.finishAuth(back.searchParams.get("state"), back.searchParams.get("code"));
}

async function tmpImage(w, h, format = "png") {
  const f = path.join(DATA, `tmp-${w}x${h}.${format}`);
  await sharp({ create: { width: w, height: h, channels: 3, background: "#cc8833" } }).toFormat(format).toFile(f);
  return f;
}

test("collegamento dei quattro social (OAuth, con PKCE per X)", async () => {
  for (const net of ["instagram", "threads", "linkedin", "x"]) {
    const r = await connect(net);
    assert.equal(r.network, net);
  }
  const st = social.socialStatus();
  const by = Object.fromEntries(st.networks.map((n) => [n.id, n]));
  assert.equal(by.instagram.account.username, "antonello.prova");
  assert.equal(by.linkedin.account.username, "Antonello Prova");
  assert.equal(by.x.account.username, "antonello_prova");
  assert.equal(by.x.auto, false, "di partenza serve l'approvazione");
  assert.equal(st.redirectUri, `${process.env.PUBLIC_URL}/social/callback`);
  assert.ok(!JSON.stringify(st).includes("segreto-di-prova"), "il Secret non torna mai all'interfaccia");
  assert.ok(!JSON.stringify(st).includes("ig-long"), "nemmeno i codici di accesso");
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, "social.json"), "utf8"));
  assert.equal(saved.accounts.instagram.token, "ig-long");
  assert.equal(saved.accounts.x.refreshToken, "x-refresh-1");
  assert.equal(fs.statSync(path.join(DATA, "social.json")).mode & 0o777, 0o600);
  // Lo state si usa una volta sola.
  await assert.rejects(social.finishAuth("state-inventato", "x"), /scaduto o già usato/);
});

let photo; // foto dell'iPhone (3:4)
test("archivio: foto caricata → JPEG con anteprima; formati sbagliati rifiutati", async () => {
  photo = await media.ingestUpload(await tmpImage(900, 1200), { name: "spiaggia.png", mime: "image/png" });
  assert.equal(photo.mime, "image/jpeg");
  assert.equal(photo.title, "spiaggia");
  assert.deepEqual([photo.width, photo.height], [900, 1200]);
  assert.match(photo.src, /^\/m\/[\w-]{20,}\.jpg$/);
  assert.ok(media.fileForPublicName(photo.src.slice(3)));
  assert.equal(media.fileForPublicName("codice-inventato-1234567890.jpg"), null);
  await assert.rejects(media.ingestUpload(await tmpImage(10, 10), { name: "x.txt", mime: "text/plain" }), /formato non supportato/);
  const bad = path.join(DATA, "rotta.jpg");
  fs.writeFileSync(bad, "non sono una foto");
  await assert.rejects(media.ingestUpload(bad, { mime: "image/jpeg" }), /immagine non valida/);
  const v = path.join(DATA, "clip.mp4");
  fs.writeFileSync(v, Buffer.alloc(2048));
  const video = await media.ingestUpload(v, { name: "clip.mp4", mime: "video/mp4" });
  assert.equal(video.kind, "video");
  assert.match(video.src, /\.mp4$/);
  assert.equal(media.updateMedia(photo.id, { description: "Tramonto in spiaggia a Rimini" }).description, "Tramonto in spiaggia a Rimini");
});

let graphic;
test("grafiche disegnate dagli agenti: SVG → JPEG nel formato giusto, con foto dell'archivio", async () => {
  graphic = await media.createGraphic({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350"><rect width="1080" height="1350" fill="#123"/>` +
      `<image href="media:${photo.id}" x="0" y="0" width="1080" height="700"/><text x="80" y="900" font-family="Montserrat" font-size="90" fill="#fff">Ciao 🚀</text></svg>`,
    format: "portrait",
    title: "Copertina",
    by: "Grafico",
  });
  assert.deepEqual([graphic.width, graphic.height, graphic.origin], [1080, 1350, "graphic"]);
  for (const svg of [
    `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>`,
    `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>`,
    `<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://e.com/a.css);</style></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><text>href="#</text><image href="file:///etc/passwd"/></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:u\\72l(x)}</style></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg"><image href=file:///etc/passwd /></svg>`,
  ]) {
    await assert.rejects(media.createGraphic({ svg, format: "square" }), /svg/, svg);
  }
  await assert.rejects(media.createGraphic({ svg: "<svg/>", format: "gigante" }), /format/);
});

test("Instagram: post proposto → approvazione → pubblicato (foto 3:4 ritagliata in 4:5, file scaricato dall'indirizzo pubblico)", async () => {
  const r = await social.proposePost(agent, { network: "instagram", text: "Tramonto #rimini", media: [photo.id], reason: "foto più bella della settimana" });
  assert.equal(r.status, "pending_approval");
  const a = getState().approvals.find((x) => x.postId === r.post_id);
  assert.equal(a.kind, "post");
  assert.equal(a.status, "pending");
  assert.equal(a.post.media[0].id, photo.id);
  fake.fetched.length = 0;
  const started = await social.decidePost(a.id, true);
  assert.equal(started.status, "executing", "l'approvazione risponde subito, la pubblicazione continua in sottofondo");
  await assert.rejects(social.decidePost(a.id, false), /già decisa/, "non si può più scartare un post che sta partendo");
  assert.throws(() => social.cancelPost(r.post_id), /solo i post in attesa/);
  await social.whenIdle();
  const done = getState().approvals.find((x) => x.id === a.id);
  assert.equal(done.status, "executed", JSON.stringify(done));
  assert.match(done.post.url, /^https:\/\/www\.instagram\.com\/p\//);
  assert.equal(fake.fetched.length, 1);
  assert.equal(fake.fetched[0].status, 200);
  assert.equal(fake.fetched[0].type, "image/jpeg");
  const caption = fake.calls.find((c) => c.host === "graph.instagram.com" && c.path === "/1784140001/media" && c.body.caption);
  assert.equal(caption.body.caption, "Tramonto #rimini");
  // Non si decide due volte.
  await assert.rejects(social.decidePost(a.id, true), /già decisa/);
});

test("Instagram: carosello con foto e video (Reel in lavorazione), storia, risposta a un commento", async () => {
  const video = media.listMedia({ kind: "video" })[0];
  social.setNetworkSettings("instagram", { auto: true, maxPerDay: 10 });
  const r = await social.proposePost(agent, { network: "instagram", text: "Carosello", media: [graphic.id, video.id], reason: "test" });
  assert.equal(r.status, "published", JSON.stringify(r));
  const parent = fake.calls.find((c) => c.host === "graph.instagram.com" && c.body.media_type === "CAROUSEL");
  assert.equal(parent.body.children.split(",").length, 2);
  const story = await social.proposePost(agent, { network: "instagram", text: "", format: "story", media: [graphic.id], reason: "storia" });
  assert.equal(story.status, "published");
  const reply = await social.proposePost(agent, { network: "instagram", text: "Grazie!", reply_to: "c-1", reason: "risposta" });
  assert.equal(reply.status, "published");
  assert.ok(fake.calls.some((c) => c.path === "/c-1/replies" && c.body.message === "Grazie!"));
  await assert.rejects(social.proposePost(agent, { network: "instagram", text: "solo testo", reason: "x" }), /almeno una foto o un video/);
  social.setNetworkSettings("instagram", { auto: false });
});

test("Threads e LinkedIn: testo, foto, hashtag e simboli protetti per LinkedIn", async () => {
  social.setNetworkSettings("threads", { auto: true });
  const t = await social.proposePost(agent, { network: "threads", text: "Buongiorno Threads", reason: "saluto" });
  assert.equal(t.status, "published");
  assert.match(t.url, /threads\.net/);
  await assert.rejects(social.proposePost(agent, { network: "threads", text: "a".repeat(501), reason: "x" }), /troppo lungo/);

  assert.equal(linkedinText("Crescita (+20%) #marketing e @nome"), "Crescita \\(+20%\\) {hashtag|\\#|marketing} e \\@nome");
  social.setNetworkSettings("linkedin", { auto: true });
  const l = await social.proposePost(agent, { network: "linkedin", text: "Novità (importante) #lavoro", media: [graphic.id, photo.id], reason: "post" });
  assert.equal(l.status, "published", JSON.stringify(l));
  assert.match(l.url, /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:share:/);
  const post = fake.calls.find((c) => c.path === "/rest/posts");
  assert.equal(post.body.author, "urn:li:person:abc123");
  assert.equal(post.body.content.multiImage.images.length, 2);
  assert.match(post.headers["linkedin-version"], /^\d{6}$/);
  assert.equal(post.body.commentary, "Novità \\(importante\\) {hashtag|\\#|lavoro}");
  assert.equal(fake.calls.filter((c) => c.host === "upload.linkedin.com").length, 2, "due foto caricate");
  await assert.rejects(social.stats("linkedin"), /LinkedIn non dà le statistiche/);
});

test("X: foto caricata a pezzi, costo del post (di più con un link), rinnovo del codice scaduto", async () => {
  social.setNetworkSettings("x", { auto: true });
  // Codice di accesso scaduto: si rinnova da solo con il codice di rinnovo (che cambia).
  const file = path.join(DATA, "social.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.accounts.x.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(saved));
  social._reload();
  const before = cost();
  const r = await social.proposePost(agent, { network: "x", text: "Ciao X", media: [graphic.id], reason: "test" });
  assert.equal(r.status, "published", JSON.stringify(r));
  assert.match(r.url, /^https:\/\/x\.com\/antonello_prova\/status\/18/);
  assert.ok(Math.abs(cost() - before - 0.015) < 1e-9);
  const tweet = fake.calls.filter((c) => c.path === "/2/tweets").at(-1);
  assert.equal(tweet.body.media.media_ids.length, 1);
  assert.equal(tweet.headers.authorization, "Bearer x-access-2", "codice rinnovato");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).accounts.x.refreshToken, "x-refresh-2");
  const b2 = cost();
  await social.proposePost(agent, { network: "x", text: "Leggi su example.com/articolo", reason: "link" });
  assert.ok(Math.abs(cost() - b2 - 0.2) < 1e-9, "un post con link costa 0,20 $");
  await assert.rejects(social.proposePost(agent, { network: "x", text: "x".repeat(281), reason: "x" }), /troppo lungo/);
});

test("thread: le risposte a un proprio post partono dopo di lui (anche se approvate prima) e non contano nel massimo", async () => {
  social.setNetworkSettings("x", { auto: false, maxPerDay: 1 });
  const first = await social.proposePost(agent, { network: "x", text: "Come leggere un grafico in 3 punti 🧵", reason: "thread" });
  const second = await social.proposePost(agent, { network: "x", text: "1. Guarda la tendenza", reply_to: first.post_id, reason: "thread" });
  const ap = (r) => getState().approvals.find((x) => x.postId === r.post_id);
  // Approvata prima la risposta: aspetta il primo post.
  assert.equal((await social.decidePost(ap(second).id, true)).status, "scheduled");
  // Il limite di 1 post al giorno su X è già stato usato nella prova di X: si alza per il primo post.
  social.setNetworkSettings("x", { maxPerDay: 10 });
  await social.decidePost(ap(first).id, true);
  await social.whenIdle();
  assert.equal(ap(first).status, "executed");
  const file = path.join(DATA, "social.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.posts.find((p) => p.id === second.post_id).publishAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(saved));
  social._reload();
  await social.publishDue();
  const tweets = fake.calls.filter((c) => c.path === "/2/tweets");
  const parentId = social.statusForAgents().post_recenti.find((p) => p.post_id === first.post_id).id_social;
  assert.equal(tweets.at(-1).body.reply.in_reply_to_tweet_id, parentId);
  assert.equal(social.statusForAgents().post_recenti.find((p) => p.post_id === second.post_id).stato, "published");
  // Le risposte non consumano il massimo dei post del giorno.
  social.setNetworkSettings("x", { auto: true, maxPerDay: 1 });
  const r = await social.proposePost(agent, { network: "x", text: "2. Poi i volumi", reply_to: second.post_id, reason: "thread" });
  assert.equal(r.status, "published");
  await assert.rejects(social.proposePost(agent, { network: "instagram", text: "x", reply_to: first.post_id, media: [graphic.id], reason: "x" }), /solo per i thread/);
  social.setNetworkSettings("x", { maxPerDay: 5 });
});

test("due approvazioni insieme non superano il massimo del giorno; id e date non validi rifiutati", async () => {
  social.setNetworkSettings("linkedin", { auto: false, maxPerDay: 10 });
  if (!social.socialStatus().networks.find((n) => n.id === "linkedin").account) await connect("linkedin");
  const today = social.socialStatus().networks.find((n) => n.id === "linkedin").today;
  social.setNetworkSettings("linkedin", { maxPerDay: today + 1 });
  const a1 = await social.proposePost(agent, { network: "linkedin", text: "Uno", reason: "x" });
  const a2 = await social.proposePost(agent, { network: "linkedin", text: "Due", reason: "x" });
  const ids = [a1, a2].map((r) => getState().approvals.find((x) => x.postId === r.post_id).id);
  await Promise.all(ids.map((id) => social.decidePost(id, true)));
  await social.whenIdle();
  const st = ids.map((id) => getState().approvals.find((x) => x.id === id).status).sort();
  assert.deepEqual(st, ["executed", "failed"]);
  social.setNetworkSettings("linkedin", { auto: false, maxPerDay: 2 });
  await assert.rejects(social.proposePost(agent, { network: "threads", text: "x", reply_to: "123?method=delete#", reason: "x" }), /id non valido/);
  await assert.rejects(social.comments("instagram", "1/../me"), /id non valido/);
  assert.throws(() => social.parseRomeTime("2026-02-30 10:00"), /non è una data e ora valida/);
  assert.throws(() => social.parseRomeTime("2026-10-16 25:00"), /non è una data e ora valida/);
  const { xLength } = await import("../lib/social/networks.js");
  assert.equal(xLength("ciao"), 4);
  assert.equal(xLength("🚀👍🏽👨‍👩‍👧"), 6);
  assert.equal(xLength("vedi https://example.com/un/link/lunghissimo/davvero"), 28);
  await assert.rejects(social.proposePost(agent, { network: "x", text: "🚀".repeat(141), reason: "x" }), /come li conta X/);
});

test("massimo di post al giorno e post a 0 = pubblicazione ferma", async () => {
  social.setNetworkSettings("threads", { auto: true, maxPerDay: 1 });
  await assert.rejects(social.proposePost(agent, { network: "threads", text: "secondo post", reason: "x" }), /limite di 1 post al giorno/);
  social.setNetworkSettings("threads", { maxPerDay: 0 });
  await assert.rejects(social.proposePost(agent, { network: "threads", text: "terzo", reason: "x" }), /0 post al giorno/);
  assert.throws(() => social.setNetworkSettings("threads", { maxPerDay: 99 }), /da 0 a 50/);
  social.setNetworkSettings("threads", { maxPerDay: 5 });
});

test("post programmato: parte all'ora italiana scelta; si può annullare", async () => {
  const at = social.parseRomeTime("2026-07-01 18:30");
  assert.equal(at.toISOString(), "2026-07-01T16:30:00.000Z", "ora legale: UTC+2");
  assert.equal(social.parseRomeTime("2026-12-01 18:30").toISOString(), "2026-12-01T17:30:00.000Z", "ora solare: UTC+1");
  assert.throws(() => social.parseRomeTime("domani alle 6"), /publish_at/);
  social.setNetworkSettings("threads", { auto: false });
  const soon = new Date(Date.now() + 10 * 60_000);
  const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(soon);
  const r = await social.proposePost(agent, { network: "threads", text: "Più tardi", publish_at: fmt, reason: "orario migliore" });
  const a = getState().approvals.find((x) => x.postId === r.post_id);
  const decided = await social.decidePost(a.id, true);
  assert.equal(decided.status, "scheduled");
  assert.equal(await social.publishDue(), 0, "non ancora l'ora");
  // Arriva l'ora (si sposta indietro l'orario salvato).
  const file = path.join(DATA, "social.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.posts.find((p) => p.id === r.post_id).publishAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(saved));
  social._reload();
  assert.equal(await social.publishDue(), 1);
  assert.equal(getState().approvals.find((x) => x.id === a.id).status, "executed");
  // Un altro programmato annullato dall'utente.
  const r2 = await social.proposePost(agent, { network: "threads", text: "Annullami", publish_at: fmt, reason: "x" });
  assert.equal(social.cancelPost(r2.post_id).status, "cancelled");
  assert.throws(() => social.cancelPost(r2.post_id), /solo i post in attesa/);
});

test("statistiche e commenti (X costa anche leggere)", async () => {
  const ig = await social.stats("instagram");
  assert.equal(ig.followers, 1200);
  assert.equal(ig.recent_posts[0].views, 512);
  const th = await social.stats("threads");
  assert.equal(th.last_days.followers_count, 150);
  assert.equal(th.recent_posts[0].likes, 7);
  const before = cost();
  const xs = await social.stats("x", { limit: 5 });
  assert.equal(xs.followers_count, 80);
  assert.match(xs.nota_costo, /\$/);
  assert.ok(cost() > before);
  assert.equal((await social.comments("instagram", "ig-post-1")).comments[0].from, "mario");
  assert.equal((await social.comments("x", "1801")).comments[0].from, "pino");
});

test("proposta su un social non collegato, scollegamento, stato per gli agenti", async () => {
  social.disconnect("linkedin");
  // Non collegato: il post va in Approvazioni e l'utente lo pubblica a mano («📲 Condividi», poi «Fatto»).
  const man = await social.proposePost(agent, { network: "linkedin", text: "Post da pubblicare a mano", reason: "x" });
  assert.equal(man.status, "pending_manual");
  const ap = getState().approvals.find((x) => x.postId === man.post_id);
  assert.equal(ap.post.manual, true);
  const done = await social.decidePost(ap.id, true);
  assert.equal(done.status, "executed");
  assert.equal(done.post.manual, true);
  assert.equal(done.post.status, "published");
  await assert.rejects(social.proposePost(agent, { network: "linkedin", text: "x", reply_to: "123", reason: "x" }), /non è collegato: le risposte/);
  const s = social.statusForAgents();
  assert.match(s.social.find((n) => n.network === "linkedin").collegato, /^no/);
  assert.match(s.social.find((n) => n.network === "linkedin").pubblicazione, /a mano/);
  assert.match(s.social.find((n) => n.network === "x").pubblicazione, /automatica/);
  // Un post rimasto "in pubblicazione" per una chiusura improvvisa diventa "esito incerto".
  const file = path.join(DATA, "social.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.posts.at(-1).status = "publishing";
  fs.writeFileSync(file, JSON.stringify(saved));
  social._reload();
  social.recoverInterruptedPosts();
  assert.equal(social.socialStatus().posts[0].status, "uncertain");
});

test("immagini con l'IA (Gemini): chiave, modello di riserva, costo, rifiuto", async () => {
  await assert.rejects(generateImage({ prompt: "una tazza di caffè", format: "square" }), /chiave di Gemini/);
  await assert.rejects(setGeminiKey("corta"), /non sembra giusta/);
  await assert.rejects(setGeminiKey("AIzaSyA-chiave-sbagliata-1234567890"), /non è valida/);
  await assert.rejects(setGeminiKey("AQ.rifiutata-Ab8RN6chiave-nuova_1234567890"), /non accetta ancora questo tipo di chiave/);
  // Le chiavi nuove di AI Studio iniziano con «AQ.» e hanno un punto; spazi e a capo copiati per sbaglio si tolgono.
  assert.equal((await setGeminiKey(" AQ.Ab8RN6LnuovaChiave-di_prova.1234567890\n")).configured, true);
  assert.equal((await setGeminiKey("AIzaSyA-chiave-di-prova-1234567890")).configured, true);
  const img = await generateImage({ prompt: "una tazza di caffè su un tavolo di legno, luce del mattino", format: "portrait", reference: [photo.id], by: "Grafico" });
  assert.equal(img.model, "gemini-2.5-flash-image", "il primo modello non c'è: si usa il successivo");
  assert.equal(img.origin, "ai");
  assert.equal(img.mime, "image/jpeg");
  const req = fake.calls.filter((c) => c.host === "generativelanguage.googleapis.com").at(-1);
  assert.equal(req.body.generationConfig.imageConfig.aspectRatio, "4:5");
  assert.equal(req.body.contents[0].parts.length, 2, "testo + foto di riferimento");
  await assert.rejects(generateImage({ prompt: "una cosa vietata", format: "square" }), /IMAGE_SAFETY/);
});

test("eliminare un file dall'archivio toglie anche le sue copie", () => {
  const before = fs.readdirSync(media.MEDIA_DIR).length;
  media.deleteMedia(photo.id);
  assert.ok(fs.readdirSync(media.MEDIA_DIR).length <= before - 3, "foto, anteprima e copia ritagliata per Instagram");
  assert.throws(() => media.getMedia(photo.id), /non trovato/);
});

test("agente: gli strumenti dei social sono validi e media_view gli fa vedere la foto", async () => {
  const { validate, ALL_TOOLS } = await import("../lib/config.js");
  for (const t of ["social_status", "social_publish", "social_stats", "social_comments", "media_list", "media_view", "create_graphic", "generate_image"]) assert.ok(ALL_TOOLS.includes(t), t);
  const a = { id: "grafico", name: "Grafico", room: "sala", mode: "llm", instructions: "x", tools: ["media_view", "create_graphic"], model: "claude-haiku-5-5", effort: "low", watchlist: [] };
  assert.deepEqual(validate(a, [{ id: "sala" }]), []);
  const { runTool } = await import("../lib/tools.js");
  const pic = await media.ingestUpload(await tmpImage(300, 300), { name: "logo.png", mime: "image/png" });
  const out = await runTool(a, "media_view", { id: pic.id });
  assert.equal(out.toolContent[0].type, "image");
  assert.equal(out.toolContent[0].source.media_type, "image/jpeg");
  const g = await runTool(a, "create_graphic", { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675"><rect width="1200" height="675" fill="#000"/></svg>', format: "landscape", title: "Banner" });
  assert.equal(g.width, 1200);
  assert.equal(g.by, "Grafico");
  assert.equal(g.src, undefined, "agli agenti niente indirizzi dei file");
  await assert.rejects(runTool(a, "social_publish", { network: "x", text: "x", reason: "x" }), /non abilitato/);
});

test("copia dei dati: social.json entra (con i segreti protetti), l'archivio dei file no", async () => {
  const { exportZip } = await import("../lib/backup.js");
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(await exportZip());
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes("social.json"));
  assert.ok(!names.some((n) => n.startsWith("media/")));
});
