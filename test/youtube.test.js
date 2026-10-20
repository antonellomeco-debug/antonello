// YouTube: collegamento con Google, caricamento dei video (titolo, descrizione, visibilità, etichetta IA, miniatura),
// copia automatica dei video usciti sugli altri social senza doppioni, statistiche, commenti e rinnovo dell'accesso.
// Tutto contro il finto server di test/helpers/fake-social.js.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeSocial } from "./helpers/fake-social.js";

const fake = await startFakeSocial();
after(() => fake.close());

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-test-"));
Object.assign(process.env, { AGENTI_DATA_DIR: DATA, MARKET_MODE: "demo", SOCIAL_API_BASE: fake.url, SOCIAL_POLL_MS: "5" });
const media = await import("../lib/social/media.js");
const social = await import("../lib/social/index.js");
const { getState } = await import("../lib/store.js");
const { TOOL_DEFS } = await import("../lib/tools.js");

const agent = { id: "editore-yt", name: "Editore YouTube", room: "redazione" };

async function connectYouTube() {
  social.setApp("youtube", { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-segreto" });
  const { url } = social.startAuth("youtube");
  const auth = new URL(url.replace(`${fake.url}/accounts.google.com`, "https://accounts.google.com"));
  assert.equal(auth.searchParams.get("access_type"), "offline", "serve il codice di rinnovo");
  assert.equal(auth.searchParams.get("prompt"), "consent");
  const r = await fetch(url, { redirect: "manual" });
  const back = new URL(r.headers.get("location"));
  return social.finishAuth(back.searchParams.get("state"), back.searchParams.get("code"));
}

async function newVideo(name) {
  const f = path.join(DATA, `${name}.mp4`);
  fs.writeFileSync(f, Buffer.alloc(4096, 1));
  return media.ingestUpload(f, { name: `${name}.mp4`, mime: "video/mp4" });
}

const uploads = () => fake.calls.filter((c) => c.host === "www.googleapis.com" && c.path === "/upload/youtube/v3/videos" && c.method === "POST");
const ytPosts = () => social.socialStatus().posts.filter((p) => p.network === "youtube" && !p.replyTo);

test("collegamento: account Google senza canale rifiutato, poi canale collegato con il codice di rinnovo", async () => {
  fake.opts.ytNoChannel = true;
  await assert.rejects(connectYouTube(), /non ha un canale YouTube/);
  fake.opts.ytNoChannel = false;
  const r = await connectYouTube();
  assert.deepEqual(r, { network: "youtube", username: "@venturo" });
  const yt = social.socialStatus().networks.find((n) => n.id === "youtube");
  assert.equal(yt.account.username, "@venturo");
  assert.equal(yt.auto, false, "di partenza serve l'approvazione");
  assert.equal(yt.mirror, true, "copia automatica dei video attiva");
  assert.equal(yt.mirrorStories, false);
  assert.equal(yt.privacy, "public");
  assert.equal(yt.apiVerified, false, "finché Google non verifica l'app i video si caricano a mano");
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, "social.json"), "utf8"));
  assert.equal(saved.accounts.youtube.refreshToken, "yt-refresh-1");
  assert.equal(saved.accounts.youtube.userId, "UCventuro");
  assert.ok(!JSON.stringify(social.socialStatus()).includes("GOCSPX-segreto"));
});

test("app non ancora verificata da Google: collegato, ma i video vanno caricati a mano", async () => {
  social.setNetworkSettings("youtube", { auto: true });
  const v = await newVideo("a-mano");
  const before = uploads().length;
  const r = await social.proposePost(agent, { network: "youtube", title: "Il bando della settimana", text: "Descrizione", media: [v.id], reason: "Short" });
  assert.equal(r.status, "pending_manual");
  assert.match(r.message, /Google non ha ancora verificato l'app/);
  assert.equal(uploads().length, before, "niente caricamento: resterebbe bloccato come privato");
  assert.match(social.statusForAgents().social.find((s) => s.network === "youtube").pubblicazione, /i video a mano/);
  social.cancelPost(r.post_id);
});

test("video su YouTube: titolo, descrizione con il testo fisso, tag dagli hashtag, visibilità ed etichetta IA", async () => {
  social.setNetworkSettings("youtube", { auto: true, apiVerified: true, footer: "📩 Newsletter gratuita: https://venturo.example/news" });
  const v = await newVideo("bando");
  const r = await social.proposePost(agent, {
    network: "youtube",
    title: "Il bando che il 70% delle PMI non chiede <davvero>",
    text: "Chi può chiederlo, quanto dà e la scadenza.\n#bandi #pmi #bandi",
    media: [v.id],
    reason: "Short del giorno",
  });
  assert.equal(r.status, "published", JSON.stringify(r));
  assert.match(r.url, /^https:\/\/www\.youtube\.com\/watch\?v=yt\d+$/);
  const meta = uploads().at(-1).body;
  assert.equal(meta.snippet.title, "Il bando che il 70% delle PMI non chiede davvero", "niente < e >");
  assert.match(meta.snippet.description, /scadenza\.\n#bandi #pmi #bandi\n\n📩 Newsletter gratuita/);
  assert.deepEqual(meta.snippet.tags, ["bandi", "pmi"]);
  assert.equal(meta.snippet.defaultLanguage, "it");
  assert.equal(meta.status.privacyStatus, "public");
  assert.equal(meta.status.containsSyntheticMedia, true);
  assert.equal(meta.status.selfDeclaredMadeForKids, false);
  const put = fake.calls.filter((c) => c.method === "PUT" && c.path === "/upload/youtube/v3/videos").at(-1);
  assert.equal(put.size, 4096, "il file intero");
  // Lo stesso video non va due volte.
  await assert.rejects(social.proposePost(agent, { network: "youtube", title: "Di nuovo", text: "", media: [v.id], reason: "x" }), /già su YouTube/);
});

test("YouTube vuole UN video: niente foto, niente solo testo; titolo lungo accorciato; miniatura facoltativa", async () => {
  const pic = await media.createGraphic({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#0A1F44"/></svg>', format: "youtube_thumb", title: "Miniatura" });
  assert.equal(pic.width, 1280);
  assert.equal(pic.height, 720);
  await assert.rejects(social.proposePost(agent, { network: "youtube", title: "Foto", text: "x", media: [pic.id], reason: "x" }), /UN video/);
  await assert.rejects(social.proposePost(agent, { network: "youtube", title: "Testo", text: "solo testo", reason: "x" }), /UN video/);
  const v = await newVideo("lungo");
  const long = "Come si legge un bilancio in 10 minuti: ricavi, margini, debiti e cassa spiegati semplice a chi ha una piccola impresa italiana";
  fake.opts.ytThumbFail = true;
  const r = await social.proposePost(agent, { network: "youtube", title: long, text: "Guida", media: [v.id], thumbnail: pic.id, reason: "video lungo" });
  fake.opts.ytThumbFail = false;
  assert.equal(r.status, "published");
  const title = uploads().at(-1).body.snippet.title;
  assert.ok([...title].length <= 100 && long.startsWith(title), title);
  const post = ytPosts().find((p) => p.id === r.post_id);
  assert.match(post.note, /miniatura non caricata/, "il video esce lo stesso, con l'avviso");
  assert.ok(fake.calls.some((c) => c.path === "/upload/youtube/v3/thumbnails/set"));
});

test("YouTube blocca il video come privato: l'utente lo sa e i video successivi tornano a mano", async () => {
  fake.opts.ytForcePrivate = true;
  const v = await newVideo("privato");
  const r = await social.proposePost(agent, { network: "youtube", title: "Prova", text: "", media: [v.id], reason: "x" });
  fake.opts.ytForcePrivate = false;
  assert.equal(r.status, "published");
  assert.match(ytPosts().find((p) => p.id === r.post_id).note, /bloccato il video come PRIVATO.*caricalo a mano/);
  assert.equal(social.socialStatus().networks.find((n) => n.id === "youtube").apiVerified, false);
  const v2 = await newVideo("dopo");
  const r2 = await social.proposePost(agent, { network: "youtube", title: "Dopo", text: "", media: [v2.id], reason: "x" });
  assert.equal(r2.status, "pending_manual");
  social.cancelPost(r2.post_id);
  social.setNetworkSettings("youtube", { apiVerified: true });
});

test("copia automatica: un video uscito su un altro social arriva anche su YouTube, una volta sola", async () => {
  social.setNetworkSettings("youtube", { auto: true, maxPerDay: 20 });
  const v = await newVideo("reel");
  const before = uploads().length;
  // Instagram non collegato: il Reel va in Approvazioni, l'utente lo pubblica a mano e tocca «Fatto».
  const ig = await social.proposePost(agent, { network: "instagram", text: "Lo Stato regala 50.000 € e nessuno li chiede 💶\nTutti i dettagli: link in bio\n#bandi #impresa", media: [v.id], reason: "Reel" });
  assert.equal(ig.status, "pending_manual");
  assert.equal(uploads().length, before, "prima che esca non si copia niente");
  const a = getState().approvals.find((x) => x.postId === ig.post_id);
  await social.decidePost(a.id, true);
  await social.whenIdle();
  assert.equal(uploads().length, before + 1);
  const meta = uploads().at(-1).body;
  assert.equal(meta.snippet.title, "Lo Stato regala 50.000 € e nessuno li chiede 💶");
  assert.match(meta.snippet.description, /link qui sotto nella descrizione/);
  const copy = ytPosts().find((p) => p.media[0]?.id === v.id);
  assert.equal(copy.status, "published");
  assert.ok(copy.mirrorOf);
  // Lo stesso video su Threads (a mano): niente seconda copia.
  const th = await social.proposePost(agent, { network: "threads", text: "Lo Stato regala 50.000 €", media: [v.id], reason: "riuso" });
  await social.decidePost(getState().approvals.find((x) => x.postId === th.post_id).id, true);
  await social.whenIdle();
  assert.equal(uploads().length, before + 1, "un video, una volta sola su YouTube");
});

test("copia automatica: le storie no (salvo scelta dell'utente); spenta non copia", async () => {
  const story = await newVideo("storia");
  const before = uploads().length;
  const s = await social.proposePost(agent, { network: "instagram", text: "", format: "story", media: [story.id], reason: "storia" });
  await social.decidePost(getState().approvals.find((x) => x.postId === s.post_id).id, true);
  await social.whenIdle();
  assert.equal(uploads().length, before, "le storie restano fuori");
  social.setNetworkSettings("youtube", { mirrorStories: true });
  const story2 = await newVideo("storia2");
  const s2 = await social.proposePost(agent, { network: "instagram", text: "", format: "story", media: [story2.id], reason: "storia" });
  await social.decidePost(getState().approvals.find((x) => x.postId === s2.post_id).id, true);
  await social.whenIdle();
  assert.equal(uploads().length, before + 1, "con «anche le storie» sì");
  social.setNetworkSettings("youtube", { mirrorStories: false, mirror: false });
  const v = await newVideo("spenta");
  const p = await social.proposePost(agent, { network: "threads", text: "Video", media: [v.id], reason: "x" });
  await social.decidePost(getState().approvals.find((x) => x.postId === p.post_id).id, true);
  await social.whenIdle();
  assert.equal(uploads().length, before + 1, "copia spenta");
  social.setNetworkSettings("youtube", { mirror: true });
});

test("la versione scritta per YouTube da un agente prende il posto della copia in attesa", async () => {
  social.setNetworkSettings("youtube", { auto: false });
  const v = await newVideo("sostituito");
  const th = await social.proposePost(agent, { network: "threads", text: "Caso studio: venduta in 6 mesi", media: [v.id], reason: "riuso" });
  await social.decidePost(getState().approvals.find((x) => x.postId === th.post_id).id, true);
  await social.whenIdle();
  const copy = ytPosts().find((p) => p.media[0]?.id === v.id && p.mirrorOf);
  assert.equal(copy.status, "pending", "con l'approvazione la copia aspetta in ✅ Approvazioni");
  const own = await social.proposePost(agent, { network: "youtube", title: "Come ha venduto la sua azienda in 6 mesi", text: "Il caso studio completo.", media: [v.id], reason: "titolo SEO" });
  assert.equal(own.status, "pending_approval");
  assert.equal(ytPosts().find((p) => p.id === copy.id).status, "cancelled");
  assert.equal(getState().approvals.find((x) => x.postId === copy.id).status, "rejected");
  await assert.rejects(social.proposePost(agent, { network: "youtube", title: "Terza volta", text: "", media: [v.id], reason: "x" }), /già su YouTube/);
  social.setNetworkSettings("youtube", { auto: true });
});

test("statistiche, commenti nuovi (non i propri) e risposta", async () => {
  const st = await social.stats("youtube", { limit: 5 });
  assert.equal(st.subscribers, 42);
  assert.equal(st.recent_posts[0].views, 300);
  const box = await social.inbox("youtube", {});
  assert.deepEqual(box.commenti.map((c) => c.comment_id), ["Ugw-commento1"], "il commento del canale stesso si salta");
  const r = await social.proposePost(agent, { network: "youtube", text: "Si chiede su Invitalia: link nella descrizione 👇", reply_to: "Ugw-commento1", reason: "risposta" });
  assert.equal(r.status, "published");
  const call = fake.calls.find((c) => c.path === "/youtube/v3/comments" && c.method === "POST");
  assert.deepEqual(call.body.snippet, { parentId: "Ugw-commento1", textOriginal: "Si chiede su Invitalia: link nella descrizione 👇" });
  await assert.rejects(social.proposePost(agent, { network: "youtube", text: "Ancora", reply_to: "Ugw-commento1", reason: "x" }), /già una risposta/);
});

test("accesso: si rinnova da solo; se Google lo revoca, il messaggio spiega «In produzione»", async () => {
  const file = path.join(DATA, "social.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  d.accounts.youtube.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(d));
  social._reload();
  assert.equal(social.socialStatus().networks.find((n) => n.id === "youtube").account.expired, false, "con il codice di rinnovo non è scaduto");
  await social.stats("youtube", {});
  const after1 = JSON.parse(fs.readFileSync(file, "utf8")).accounts.youtube;
  assert.notEqual(after1.token, "yt-access-1");
  assert.ok(Date.parse(after1.expiresAt) > Date.now());
  after1.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ ...d, accounts: { ...d.accounts, youtube: after1 } }));
  social._reload();
  fake.opts.ytRevoked = true;
  await assert.rejects(social.stats("youtube", {}), /ricollegarlo/);
  fake.opts.ytRevoked = false;
  assert.match(social.socialStatus().networks.find((n) => n.id === "youtube").account.problem, /In produzione/);
});

test("strumenti: YouTube negli strumenti degli agenti e nei formati delle grafiche; impostazioni controllate", () => {
  assert.ok(TOOL_DEFS.social_publish.input_schema.properties.network.enum.includes("youtube"));
  assert.ok(TOOL_DEFS.social_publish.input_schema.properties.title);
  assert.ok(TOOL_DEFS.social_inbox.input_schema.properties.network.enum.includes("youtube"));
  assert.ok(TOOL_DEFS.create_graphic.input_schema.properties.format.enum.includes("banner_youtube"));
  assert.equal(media.FORMATS.banner_youtube.w, 2560);
  assert.throws(() => social.setNetworkSettings("youtube", { privacy: "segreto" }), /public, unlisted o private/);
  assert.throws(() => social.setNetworkSettings("youtube", { footer: "<script>" }), /niente < e >/);
  const st = social.statusForAgents().social.find((s) => s.network === "youtube");
  assert.match(st.youtube, /Copia automatica ATTIVA/);
});
