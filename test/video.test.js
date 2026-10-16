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
  await assert.rejects(stock.searchStock({ query: "office" }), /chiave gratuita di Pexels/);
  await assert.rejects(stock.setPexelsKey("corta"), /non sembra giusta/);
  await assert.rejects(stock.setPexelsKey("ChiaveSbagliata0123456789abcdef"), /non è valida/);
  const st = await stock.setPexelsKey(" ChiaveGiusta0123456789abcdefXYZ ");
  assert.deepEqual([st.configured, st.hint], [true, "…fXYZ"]);
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
