// Video montati dagli agenti (create_video): clip, foto e schermate di testo, voce narrante con sottotitoli,
// titoli animati, transizioni, barra, effetti e musica; repertorio Pexels (stock_search, stock_add).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { startFakeSocial } from "./helpers/fake-social.js";

const FFMPEG = (await import("ffmpeg-static")).default;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "video-test-"));

// Finto archivio della voce (come la release di sherpa-onnx su GitHub), servito da un piccolo server.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tts-model-"));
const folder = path.join(work, "vits-piper-it_IT-paola-medium");
fs.mkdirSync(path.join(folder, "espeak-ng-data"), { recursive: true });
for (const f of ["it_IT-paola-medium.onnx", "tokens.txt", "espeak-ng-data/it_dict"]) fs.writeFileSync(path.join(folder, f), "finto");
execFileSync("tar", ["-cjf", path.join(work, "voce.tar.bz2"), "-C", work, "vits-piper-it_IT-paola-medium"]);
let modelDownloads = 0;
const github = http.createServer((req, res) => {
  modelDownloads++;
  res.writeHead(200, { "content-type": "application/octet-stream" });
  res.end(fs.readFileSync(path.join(work, "voce.tar.bz2")));
});
await new Promise((r) => github.listen(0, "127.0.0.1", r));
const fake = await startFakeSocial();
after(async () => {
  (await import("../lib/social/tts.js")).shutdownTts();
  await Promise.all([fake.close(), new Promise((r) => github.close(r))]);
});

Object.assign(process.env, {
  ELEVEN_RETRY_MS: "10", // pause brevi tra i nuovi tentativi verso ElevenLabs
  AGENTI_DATA_DIR: DATA,
  MARKET_MODE: "demo",
  SOCIAL_API_BASE: fake.url,
  TTS_ENGINE: fileURLToPath(new URL("./helpers/fake-sherpa.cjs", import.meta.url)),
  TTS_MODEL_URL: `http://127.0.0.1:${github.address().port}/voce.tar.bz2`,
  TTS_IDLE_MS: "500",
});
const media = await import("../lib/social/media.js");
const { createVideo } = await import("../lib/social/video.js");
const tts = await import("../lib/social/tts.js");
const stock = await import("../lib/social/stock.js");
const { runTool } = await import("../lib/tools.js");
const { proposePost } = await import("../lib/social/index.js");

/** Durata e flussi di un video, letti da ffmpeg. */
function probe(file) {
  let out = "";
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    out = String(err.stderr); // senza file di uscita ffmpeg termina con un errore, ma scrive le informazioni
  }
  const [, h, m, s] = out.match(/Duration: (\d+):(\d+):([\d.]+)/) ?? [];
  return { seconds: Number(h) * 3600 + Number(m) * 60 + Number(s), video: /Video: h264/.test(out), audio: /Audio: aac/.test(out), size: out.match(/, (\d{3,4})x(\d{3,4})/)?.slice(1).map(Number) };
}
/** Volume medio dell'audio tra a e b secondi (dB). */
function loudness(file, a, b) {
  const out = String(spawnSync(FFMPEG, ["-hide_banner", "-ss", String(a), "-t", String(b - a), "-i", file, "-af", "volumedetect", "-f", "null", "-"]).stderr);
  return Number(out.match(/mean_volume: (-?[\d.]+) dB/)?.[1] ?? -91);
}
/** Un fotogramma come immagine (per controllare che i testi siano disegnati). */
const frame = (file, t) => execFileSync(FFMPEG, ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]);

async function upload(name, mime, make) {
  const file = path.join(DATA, name);
  await make(file);
  return media.ingestUpload(file, { name, mime });
}

const svg = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`;
let photo, clip, song;

test("archivio: una musica si carica (e non si pubblica da sola)", async () => {
  song = await upload("tema.m4a", "audio/x-m4a", (f) => execFileSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "aac", f]));
  assert.deepEqual([song.kind, song.mime], ["audio", "audio/mp4"]);
  assert.match(song.src, /\.m4a$/);
  assert.deepEqual(media.listMedia({ kind: "audio" }).map((m) => m.id), [song.id]);
  await assert.rejects(proposePost({ id: "a", name: "A" }, { network: "x", text: "ciao", media: [song.id], reason: "prova" }), /musica/);
  clip = await upload("clip.mp4", "video/mp4", (f) => execFileSync(FFMPEG, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", f]));
  photo = await upload("foto.png", "image/png", (f) => sharp({ create: { width: 900, height: 1200, channels: 3, background: "#3a7" } }).png().toFile(f));
});

test("video semplice: schermata disegnata, foto e spezzone con scritte, transizioni, musica, copertina", async () => {
  const v = await createVideo({
    format: "landscape",
    transition: "slideleft",
    music: song.id,
    title: "Tre consigli",
    description: "Reel di prova",
    by: "Video Maker",
    slides: [
      { svg: svg(1280, 720, `<rect width="1280" height="720" fill="#111"/><text x="640" y="380" font-family="Bebas Neue" font-size="120" fill="#fff" text-anchor="middle">TRE CONSIGLI</text>`), seconds: 2 },
      { media: photo.id, seconds: 2, motion: "zoom_out", overlay_svg: svg(1280, 720, `<text x="640" y="650" font-family="Montserrat" font-size="60" fill="#fff" text-anchor="middle">Uno</text>`) },
      { media: clip.id, seconds: 1.5, start: 0.5 },
    ],
  });
  assert.deepEqual([v.kind, v.mime, v.origin, v.by, v.width, v.height], ["video", "video/mp4", "video", "Video Maker", 1280, 720]);
  assert.equal(v.duration, 4.8, "2 + 2 + 1,5 meno due transizioni da 0,35 s");
  assert.ok(v.thumb, "copertina del video");
  const file = media.mediaPath(media.getMedia(v.id));
  const p = probe(file);
  assert.ok(p.video && p.audio, "H.264 con audio AAC");
  assert.deepEqual(p.size, [1280, 720]);
  assert.ok(Math.abs(p.seconds - 4.8) < 0.15, `durata ${p.seconds}`);
  assert.ok(media.fileForPublicName(v.src.slice(3)), "indirizzo pubblico per Instagram e Threads");
  assert.deepEqual(fs.readdirSync(media.MEDIA_DIR).filter((f) => f.startsWith(".video-")), [], "niente file di lavoro rimasti");
  const quiet = await createVideo({ format: "story", transition: "none", sfx: false, progress_bar: false, title: "Muto", slides: [{ svg: svg(1080, 1920, `<rect width="1080" height="1920" fill="#036"/>`), seconds: 1.5, motion: "none" }] });
  assert.ok(probe(media.mediaPath(media.getMedia(quiet.id))).audio, "senza musica c'è comunque una traccia audio (muta)");
});

test("voce narrante: si scarica una volta, frasi con i tempi delle parole, simboli detti a parole", async () => {
  assert.equal(tts.speakable("Il 70% vale 5€ e 3 $ 🚀 #brand"), "Il 70 per cento vale 5 euro e 3 dollari brand");
  assert.deepEqual(tts.sentences("Prima frase. Seconda?  Terza!"), ["Prima frase.", "Seconda?", "Terza!"]);
  const words = tts.wordTimes("Ciao, mondo", 1, 2);
  assert.equal(words.length, 2);
  assert.ok(words[0].start === 1 && Math.abs(words[1].end - 2) < 1e-9 && words[0].end === words[1].start);
  const dir = fs.mkdtempSync(path.join(DATA, "voci-"));
  const [a, empty, b] = await Promise.all([
    tts.synthesize(["Uno. Due tre.", "", "Quattro"], dir).then((r) => r[0]),
    Promise.resolve(null),
    tts.synthesize(["Cinque sei"], dir).then((r) => r[0]),
  ]);
  assert.equal(empty, null);
  assert.equal(modelDownloads, 1, "la voce si scarica una volta sola, anche con due richieste insieme");
  assert.ok(fs.existsSync(a.file) && a.seconds > 0.5);
  assert.deepEqual(a.words.map((w) => w.word), ["Uno.", "Due", "tre."]);
  assert.ok(a.words[1].start > a.words[0].end, "pausa tra le frasi");
  assert.ok(b.seconds > 0);
  await assert.rejects(tts.synthesize(["ERRORE qui"], dir), /voce rotta/);
});

test("video coinvolgente: voce, sottotitoli, titoli animati, schermate di solo testo su colore, musica", async () => {
  const v = await createVideo({
    format: "story",
    transition: "mix",
    music: song.id,
    accent: "#ff3366",
    title: "Investitori",
    slides: [
      { headline: "Il *70%* delle startup", voice: "Il 70% delle startup non trova investitori.", background: "#1e3a8a" },
      { media: clip.id, voice: "E non è colpa dell'idea.", headline: "Perché?", headline_anim: "typewriter" },
      { media: photo.id, voice: "Seguici per la parte due.", motion: "punch", headline: "Parte 2", headline_anim: "slide", headline_position: "center" },
    ],
  });
  const file = media.mediaPath(media.getMedia(v.id));
  const p = probe(file);
  assert.ok(p.video && p.audio);
  assert.deepEqual(p.size, [1080, 1920]);
  assert.ok(v.duration > 5, `la durata segue le frasi della voce (${v.duration} s)`);
  assert.match(v.description, /^Il 70% delle startup/, "descrizione = testo detto");
  // Si sente la voce durante la prima frase.
  assert.ok(loudness(file, 0.3, 1.5) > -40, "voce udibile");
  // I testi sono disegnati: nella prima schermata (sfondo blu uniforme) compaiono pixel chiari dei titoli e dei sottotitoli.
  const { data, info } = await sharp(frame(file, 1.2)).raw().toBuffer({ resolveWithObject: true });
  let bright = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) bright++;
  assert.ok(bright > 2000, `testo bianco disegnato (${bright} pixel)`);
});

test("errori chiari per l'agente e nessun file a metà", async () => {
  const before = media.listMedia().length;
  const bad = [
    [{ format: "cinema", slides: [{ svg: "<svg/>" }] }, /format/],
    [{ format: "story", slides: [] }, /almeno una schermata/],
    [{ format: "story", slides: [{ svg: "<svg/>", media: photo.id }] }, /non entrambi/],
    [{ format: "story", slides: [{ seconds: 2 }] }, /sfondo/],
    [{ format: "story", slides: [{ media: song.id }] }, /musica/],
    [{ format: "story", slides: [{ media: "m-inesistente" }] }, /non trovato/],
    [{ format: "story", slides: Array.from({ length: 31 }, () => ({ svg: "<svg/>" })) }, /al massimo 30/],
    [{ format: "story", slides: Array.from({ length: 8 }, () => ({ svg: "<svg/>", seconds: 15 })) }, /troppo lungo/],
    [{ format: "story", slides: [{ headline: "x".repeat(141) }] }, /headline troppo lungo/],
    [{ format: "story", music: photo.id, slides: [{ svg: "<svg/>" }] }, /non è una musica/],
    [{ format: "story", slides: [{ svg: `<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>` }] }, /svg/],
    [{ format: "story", slides: [{ headline: "Ciao", voice: "ERRORE nella voce" }] }, /voce rotta/],
  ];
  for (const [input, err] of bad) await assert.rejects(createVideo(input), err, JSON.stringify(input).slice(0, 80));
  assert.equal(media.listMedia().length, before);
  assert.deepEqual(fs.readdirSync(media.MEDIA_DIR).filter((f) => f.startsWith(".video-") || f.startsWith(".stock-")), []);
});

test("repertorio Pexels: chiave provata, ricerca con anteprime, scarico nell'archivio (una volta sola)", async () => {
  await assert.rejects(stock.searchStock({ query: "office" }), /chiave gratuita di Pixabay/);
  await assert.rejects(stock.setPexelsKey("corta"), /non sembra giusta/);
  await assert.rejects(stock.setPexelsKey("ChiaveSbagliata0123456789abcdef"), /non è valida/);
  const st = await stock.setPexelsKey(" ChiaveGiusta0123456789abcdefXYZ ");
  assert.deepEqual([st.configured, st.pexels.hint], [true, "…fXYZ"]);
  const a = { id: "video_maker", name: "Video Maker", room: "sala", mode: "llm", instructions: "x", tools: ["stock_search", "stock_add", "create_video"], model: "claude-haiku-5-5", effort: "low", watchlist: [] };
  const found = await runTool(a, "stock_search", { query: "business meeting", orientation: "portrait" });
  const images = found.toolContent.filter((c) => c.type === "image");
  assert.equal(images.length, 2, "un'anteprima per risultato");
  const list = JSON.parse(found.toolContent.at(-1).text).items;
  assert.deepEqual(list.map((x) => x.id), ["pv901", "pv902"]);
  assert.equal(list[0].title, "business meeting");
  const search = fake.calls.find((c) => c.host === "api.pexels.com" && c.path === "/videos/search");
  assert.equal(search.headers.authorization, "ChiaveGiusta0123456789abcdefXYZ");
  assert.equal(search.query.orientation, "portrait");
  assert.deepEqual(await runTool(a, "stock_search", { query: "niente" }), { items: [], message: "Nessun risultato: prova con altre parole (in inglese, concrete)." });

  // Scarico: il file HD (non il 4K), nell'archivio con l'autore; la seconda volta non si riscarica.
  fake.opts.stockVideo = fs.readFileSync(media.mediaPath(media.getMedia(clip.id)));
  const added = await runTool(a, "stock_add", { id: "pv901" });
  assert.deepEqual([added.kind, added.origin, added.by], ["video", "stock", "Video Maker"]);
  assert.match(added.description, /Autore 1 su Pexels/);
  assert.ok(fake.fetched.some((f) => f.url === "/video-files/901/hd.mp4"));
  assert.equal((await runTool(a, "stock_add", { id: "pv901" })).id, added.id);
  assert.equal(fake.fetched.filter((f) => f.url?.startsWith("/video-files/901/")).length, 1);
  await assert.rejects(runTool(a, "stock_add", { id: "pv123" }), /cercalo prima/);
  // Foto di repertorio.
  await runTool(a, "stock_search", { query: "milan", kind: "photo" });
  const pic = await runTool(a, "stock_add", { id: "pp501" });
  assert.deepEqual([pic.kind, pic.title], ["image", "Milano di sera"]);
  // La clip scaricata si usa nel video.
  const v = await runTool(a, "create_video", { format: "square", title: "Con repertorio", slides: [{ media: added.id, seconds: 1.5, headline: "Riunione" }] });
  assert.equal(v.kind, "video");
  assert.equal((await stock.setPexelsKey("")).configured, false);
});

test("repertorio Pixabay: chiave nell'indirizzo, video verticali prima per i reel, file non 4K, ricerche ricordate", async () => {
  await assert.rejects(stock.setStockKey("pixabay", "12345678-ChiaveSbagliata00000000000"), /non è valida/);
  const st = await stock.setStockKey("pixabay", "12345678-0123456789abcdef0123456789ab");
  assert.deepEqual([st.configured, st.pixabay.configured, st.pexels.configured], [true, true, false]);
  const a = { id: "video_maker", name: "Video Maker", room: "sala", mode: "llm", instructions: "x", tools: ["stock_search", "stock_add"], model: "claude-haiku-5-5", effort: "low", watchlist: [] };
  const before = fake.calls.filter((c) => c.host === "pixabay.com").length;
  const found = await runTool(a, "stock_search", { query: "office", orientation: "portrait", limit: 2 });
  const list = JSON.parse(found.toolContent.at(-1).text).items;
  assert.deepEqual(list.map((x) => x.id), ["xv302", "xv301"], "il video verticale per primo");
  assert.equal(list[0].source, "Pixabay");
  assert.equal(found.toolContent.filter((c) => c.type === "image").length, 2);
  const call = fake.calls.filter((c) => c.host === "pixabay.com").at(-1);
  assert.equal(call.query.key, "12345678-0123456789abcdef0123456789ab");
  await runTool(a, "stock_search", { query: "Office", orientation: "portrait", limit: 2 });
  assert.equal(fake.calls.filter((c) => c.host === "pixabay.com").length, before + 1, "la stessa ricerca si ricorda per 24 ore");
  const added = await runTool(a, "stock_add", { id: "xv302" });
  assert.deepEqual([added.kind, added.origin], ["video", "stock"]);
  assert.match(added.description, /Utente Pixabay su Pixabay/);
  assert.ok(fake.fetched.some((f) => f.url === "/video/302/medium.mp4"), "il file più grande sotto il 4K (il large è 4K)");
  await runTool(a, "stock_search", { query: "team", kind: "photo" });
  const pic = await runTool(a, "stock_add", { id: "xp401" });
  assert.equal(pic.kind, "image");
  assert.ok(fake.fetched.some((f) => f.url === "/photo/401_1280.jpg"));
  assert.equal((await stock.setStockKey("pixabay", "")).configured, false);
});

test("voce di Google: chiave provata, voci italiane, scelta, ascolto, video con la voce di Google, ritorno alla voce del server", async () => {
  const g = await import("../lib/social/googletts.js");
  const { updateSettings } = await import("../lib/settings.js");
  await assert.rejects(g.setGoogleTtsKey("AIzaChiaveSbagliata000000000000000000"), /non è valida/);
  await assert.rejects(g.setGoogleTtsKey("AIzaChiaveSpenta00000000000000000000000"), /Cloud Text-to-Speech/);
  const st = await g.setGoogleTtsKey("AIzaChiaveGiusta000000000000000000000");
  assert.deepEqual(st.voices.map((v) => v.name), ["it-IT-Chirp3-HD-Aoede", "it-IT-Chirp3-HD-Puck"], "solo le voci Chirp 3 HD italiane");
  assert.equal(st.selected, "it-IT-Chirp3-HD-Puck", "di partenza una voce maschile");
  assert.throws(() => g.setVideoVoice("it-IT-Inventata"), /sconosciuta/);
  assert.equal(g.setVideoVoice("it-IT-Chirp3-HD-Aoede").selected, "it-IT-Chirp3-HD-Aoede");
  const wav = await g.previewVoice("it-IT-Chirp3-HD-Aoede");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");

  // Il video usa la voce di Google (con la velocità; se la voce non la accetta, si riprova senza).
  fake.opts.ttsRejectRate = true;
  const before = fake.calls.filter((c) => c.path === "/v1/text:synthesize").length;
  const v = await createVideo({ format: "square", title: "Voce Google", slides: [{ headline: "Ciao", voice: "Prima frase. Seconda frase." }] });
  const calls = fake.calls.filter((c) => c.path === "/v1/text:synthesize").slice(before);
  assert.ok(calls.length >= 3 && calls.every((c) => c.voice === "it-IT-Chirp3-HD-Aoede"), "due frasi, più il primo tentativo con la velocità");
  assert.equal(calls.at(-1).body.audioConfig.speakingRate, undefined, "dopo il rifiuto senza velocità");
  assert.ok(probe(media.mediaPath(media.getMedia(v.id))).audio);
  assert.ok(g.voiceStatus().usage.chars > 50, "caratteri contati");

  // Caratteri gratuiti del mese quasi finiti: si usa la voce del server, senza chiamare Google.
  updateSettings({ ttsUsage: { month: new Date().toISOString().slice(0, 7), chars: 949_990 } });
  const n = fake.calls.filter((c) => c.path === "/v1/text:synthesize").length;
  const dir = fs.mkdtempSync(path.join(DATA, "voci-g-"));
  const [r] = await tts.synthesize(["Una frase abbastanza lunga da superare la soglia."], dir);
  assert.ok(r.seconds > 0);
  assert.equal(fake.calls.filter((c) => c.path === "/v1/text:synthesize").length, n);
  assert.equal(g.setVideoVoice("local").selected, "local");
  assert.equal((await g.setGoogleTtsKey("")).google.configured, false);
});

test("voce clonata con ElevenLabs: chiave e ID provati, video con la propria voce, ritorno alla voce del server", async () => {
  const el = await import("../lib/social/eleventts.js");
  const g = await import("../lib/social/googletts.js");
  await assert.rejects(el.setElevenVoice({ voiceId: "VoceAntonello123" }), /Metti la chiave/);
  await assert.rejects(el.setElevenVoice({ key: "sk_ChiaveSbagliata000000000000", voiceId: "VoceAntonello123" }), /non è valida/);
  await assert.rejects(el.setElevenVoice({ key: "sk_ChiaveGiusta00000000000000000", voiceId: "VoceInventata999" }), /non trova la voce/);
  assert.throws(() => g.setVideoVoice("eleven"), /prima metti la chiave/);
  // Una chiave con il solo permesso di sintesi va bene lo stesso (senza il nome della voce).
  const ok = await el.setElevenVoice({ key: "sk_ChiaveSoloTts000000000000000", voiceId: "VoceAntonello123" });
  assert.deepEqual([ok.configured, ok.voiceName], [true, null]);
  const st = await el.setElevenVoice({ key: "sk_ChiaveGiusta00000000000000000", voiceId: "VoceAntonello123", model: "eleven_v3" });
  assert.deepEqual([st.voiceName, st.model, st.hint], ["Antonello – Venturo", "eleven_v3", "…0000"]);
  assert.equal(g.voiceStatus().selected, "eleven", "la propria voce diventa la voce dei video");
  assert.equal((await el.previewEleven()).toString("ascii", 0, 4), "RIFF");

  const before = fake.calls.filter((c) => c.path.startsWith("/v1/text-to-speech/")).length;
  const v = await createVideo({ format: "square", title: "La mia voce", slides: [{ headline: "Ciao", voice: "Prima frase. Seconda frase." }] });
  const calls = fake.calls.filter((c) => c.path.startsWith("/v1/text-to-speech/")).slice(before);
  assert.equal(calls.length, 2, "una richiesta per frase");
  assert.equal(calls[0].body.model_id, "eleven_v3");
  assert.ok(probe(media.mediaPath(media.getMedia(v.id))).audio);
  assert.ok(el.elevenStatus().charsThisMonth > 20);

  // ElevenLabs non risponde: il video si fa con la voce del server (riserva di partenza).
  fake.opts.elevenDown = true;
  assert.equal(g.voiceStatus().fallback, "local");
  const dir = fs.mkdtempSync(path.join(DATA, "voci-e-"));
  const [r] = await tts.synthesize(["Una frase di prova."], dir);
  assert.ok(r.seconds > 0);

  // Riserva = una voce di Google: si usa quella (i caratteri del mese di prima non contano).
  const { updateSettings } = await import("../lib/settings.js");
  updateSettings({ ttsUsage: null });
  assert.throws(() => g.setVoiceFallback("it-IT-Chirp3-HD-Puck"), /voce di riserva/, "senza chiave di Google");
  await g.setGoogleTtsKey("AIzaChiaveGiusta000000000000000000000");
  g.setVideoVoice("eleven");
  assert.equal(g.setVoiceFallback("it-IT-Chirp3-HD-Puck").fallback, "it-IT-Chirp3-HD-Puck");
  const n = fake.calls.filter((c) => c.path === "/v1/text:synthesize").length;
  const [rg] = await tts.synthesize(["Una frase con la voce di riserva."], dir);
  assert.ok(rg.seconds > 0);
  const gcalls = fake.calls.filter((c) => c.path === "/v1/text:synthesize").slice(n);
  assert.ok(gcalls.length >= 1 && gcalls.every((c) => c.voice === "it-IT-Chirp3-HD-Puck"));
  assert.equal(g.voiceStatus().selected, "eleven", "la voce predefinita resta la tua");

  // Riserva = nessuna: il video non si fa e l'agente riceve l'errore.
  g.setVoiceFallback("stop");
  await assert.rejects(tts.synthesize(["Niente voce."], dir), /non è stato fatto/);
  assert.equal((await g.setGoogleTtsKey("")).fallback, "stop", "«nessuna» resta anche senza Google");
  g.setVoiceFallback("local");
  fake.opts.elevenDown = false;
  assert.equal((await el.setElevenVoice({ key: "" })).configured, false);
  assert.equal(g.voiceStatus().selected, "local");
});

test("voce clonata in un video con tante scene: mai più richieste di quelle che ElevenLabs accetta, niente voce di riserva", async () => {
  const el = await import("../lib/social/eleventts.js");
  await el.setElevenVoice({ key: "sk_ChiaveGiusta00000000000000000", voiceId: "VoceAntonello123" });
  fake.eleven.peak = 0;
  fake.eleven.rejected = 0;
  const before = fake.calls.filter((c) => c.path.startsWith("/v1/text-to-speech/")).length;
  const dir = fs.mkdtempSync(path.join(DATA, "voci-tante-"));
  const scenes = Array.from({ length: 6 }, (_, i) => `Scena ${i + 1}, prima frase. Scena ${i + 1}, seconda frase.`);
  const out = await tts.synthesize(scenes, dir);
  assert.equal(out.voce, "ElevenLabs", "la tua voce, non quella di riserva");
  assert.equal(fake.eleven.rejected, 0, "nessuna richiesta rifiutata");
  assert.ok(fake.eleven.peak <= 2, `al massimo 2 richieste insieme (erano ${fake.eleven.peak})`);
  assert.equal(fake.calls.filter((c) => c.path.startsWith("/v1/text-to-speech/")).length - before, 12, "una per frase");

  // Se ElevenLabs rifiuta lo stesso (piano più piccolo o un altro programma che la usa), si riprova invece di cambiare voce.
  fake.opts.elevenMaxConcurrent = 1;
  const again = await tts.synthesize(scenes.slice(0, 3), dir);
  assert.equal(again.voce, "ElevenLabs");
  assert.ok(fake.eleven.rejected > 0, "qualche richiesta rifiutata e poi riprovata");
  delete fake.opts.elevenMaxConcurrent;

  // I numeri arrivano alla voce in lettere, i sottotitoli restano con le cifre.
  const [num] = await tts.synthesize(["Erano 314.824, l'8,9%."], dir);
  const sent = fake.calls.filter((c) => c.path.startsWith("/v1/text-to-speech/")).at(-1);
  assert.equal(sent.body.text, "Erano trecentoquattordicimila ottocentoventiquattro, l'otto virgola nove per cento.");
  assert.deepEqual(num.words.map((w) => w.word), ["Erano", "314.824,", "l'8,9", "per", "cento."]);

  // ElevenLabs giù: la voce di riserva e il motivo arrivano a chi ha chiesto il video.
  fake.opts.elevenDown = true;
  const fb = await tts.synthesize(["Una frase."], dir);
  assert.match(fb.voce, /riserva/);
  assert.match(fb.voce, /ElevenLabs/);
  fake.opts.elevenDown = false;
  await el.setElevenVoice({ key: "" });
});

test("agente: gli strumenti dei video sono validi e media_view mostra la copertina del video", async () => {
  const { validate, ALL_TOOLS } = await import("../lib/config.js");
  for (const t of ["create_video", "stock_search", "stock_add"]) assert.ok(ALL_TOOLS.includes(t), t);
  const a = { id: "video_maker", name: "Video Maker", room: "sala", mode: "llm", instructions: "x", tools: ["create_video", "media_view"], model: "claude-haiku-5-5", effort: "low", watchlist: [] };
  assert.deepEqual(validate(a, [{ id: "sala" }]), []);
  const v = await runTool(a, "create_video", { format: "square", title: "Quadrato", slides: [{ media: photo.id, seconds: 1.5 }] });
  assert.equal(v.by, "Video Maker");
  assert.equal(v.src, undefined, "agli agenti niente indirizzi dei file");
  const seen = await runTool(a, "media_view", { id: v.id });
  assert.equal(seen.toolContent[0].type, "image");
  await assert.rejects(runTool(a, "media_view", { id: clip.id }), /video/);
});

test("video animati (create_motion_video): scene controllate, pagina animata di marca, voce e sottotitoli, archivio", async () => {
  const motion = await import("../lib/social/motion.js");
  process.env.MOTION_RENDERER = fileURLToPath(new URL("./helpers/fake-motion.mjs", import.meta.url));
  process.env.MOTION_PAGE_COPY = path.join(DATA, "pagina-copia.html");
  // Errori chiari per l'agente.
  await assert.rejects(motion.createMotionVideo({ format: "story", scenes: [] }), /almeno una scena/);
  await assert.rejects(motion.createMotionVideo({ format: "story", scenes: [{ type: "boh" }] }), /type dev'essere/);
  await assert.rejects(motion.createMotionVideo({ format: "story", scenes: [{ type: "bars", title: "x", items: [] }] }), /elenco non vuoto/);
  await assert.rejects(motion.createMotionVideo({ format: "story", scenes: [{ type: "number", value: "tanti", label: "x" }] }), /dev'essere un numero/);
  await assert.rejects(motion.createMotionVideo({ format: "story", scenes: [{ type: "donut", value: 140, label: "x" }] }), /da 0 a 100/);
  await assert.rejects(motion.createMotionVideo({ format: "story", scenes: [{ type: "media", media: song.id }] }), /foto o un video/);

  // La pagina: testi protetti, unità con lo spazio, tutte le scene con le loro animazioni.
  const { html, total } = motion.previewHtml({ scenes: [
    { type: "hook", text: "Il <b>70%</b> delle PMI", highlight: ["70%"] },
    { type: "number", value: 2128, suffix: "mld €", label: "prestiti", source: "Banca d'Italia" },
    { type: "bars", title: "PIL", items: [{ label: "Lombardia", value: 412 }, { label: "Lazio", value: "209" }], highlight: "Lazio" },
    { type: "cta", text: "Mandalo a un amico" },
  ] });
  assert.ok(!html.includes("<b>70%</b>") && html.includes("&lt;b&gt;70%&lt;/b&gt;"), "il testo dell'agente non diventa codice");
  assert.ok(html.includes('" mld €"'), "spazio tra numero e unità");
  assert.match(html, /Fonte: Banca d&#39;Italia/);
  assert.equal((html.match(/class="clip scene/g) ?? []).length, 4);
  assert.ok(total > 8 && total < 20);

  // Video completo con voce, foto e clip dell'archivio.
  const v = await motion.createMotionVideo({
    format: "story", title: "Animato", music: song.id,
    scenes: [
      { type: "hook", text: "Il 70% delle PMI non chiede i bandi", highlight: ["70%"], voice: "Sette imprese su dieci non chiedono i bandi." },
      { type: "media", media: photo.id, text: "Il caso", voice: "Come questa." },
      { type: "media", media: clip.id, start: 1 },
      { type: "cta", text: "Mandalo a chi ha una partita IVA" },
    ],
  });
  assert.equal(v.kind, "video");
  const file = media.mediaPath(media.getMedia(v.id));
  const p = probe(file);
  assert.ok(p.video && p.audio, "video con audio (voce, musica, effetti)");
  assert.deepEqual(p.size, [1080, 1920]);
  assert.ok(Math.abs(p.seconds - v.duration) < 0.6);
  const page = fs.readFileSync(process.env.MOTION_PAGE_COPY, "utf8");
  assert.match(page, /class="cap" id="c0"/, "sottotitoli dalla voce");
  assert.ok(!/>undefined</.test(page), "parole dei sottotitoli scritte davvero");
  assert.match(page, /<video class="mbg clip"/);
  delete process.env.MOTION_RENDERER;
});
