// Video montati dagli agenti (create_video): schermate SVG, foto e spezzoni con scritte sopra, transizioni e musica.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "video-test-"));
Object.assign(process.env, { AGENTI_DATA_DIR: DATA, MARKET_MODE: "demo" });
const media = await import("../lib/social/media.js");
const { createVideo } = await import("../lib/social/video.js");
const { runTool } = await import("../lib/tools.js");
const { proposePost } = await import("../lib/social/index.js");
const FFMPEG = (await import("ffmpeg-static")).default;

/** Durata e flussi di un video, letti da ffmpeg. */
function probe(file) {
  let out = "";
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    out = String(err.stderr); // senza file di uscita ffmpeg termina con un errore, ma scrive le informazioni
  }
  const [, h, m, s] = out.match(/Duration: (\d+):(\d+):([\d.]+)/) ?? [];
  return { seconds: Number(h) * 3600 + Number(m) * 60 + Number(s), video: /Video: h264/.test(out), audio: /Audio: aac/.test(out), size: out.match(/(\d{3,4})x(\d{3,4})/)?.slice(1).map(Number) };
}

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

test("video montato: schermata disegnata, foto e spezzone con scritte, transizioni, musica, copertina", async () => {
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
  assert.equal(v.duration, 4.5, "2 + 2 + 1,5 meno due transizioni da mezzo secondo");
  assert.ok(v.thumb, "copertina del video");
  const file = media.mediaPath(media.getMedia(v.id));
  const p = probe(file);
  assert.ok(p.video && p.audio, "H.264 con audio AAC");
  assert.deepEqual(p.size, [1280, 720]);
  assert.ok(Math.abs(p.seconds - 4.5) < 0.15, `durata ${p.seconds}`);
  assert.ok(media.fileForPublicName(v.src.slice(3)), "indirizzo pubblico per Instagram e Threads");
  assert.deepEqual(fs.readdirSync(media.MEDIA_DIR).filter((f) => f.startsWith(".video-")), [], "niente file di lavoro rimasti");
  // Senza musica il video ha comunque una traccia audio (muta).
  const quiet = await createVideo({ format: "story", transition: "none", title: "Muto", slides: [{ svg: svg(1080, 1920, `<rect width="1080" height="1920" fill="#036"/>`), seconds: 1.5, motion: "none" }] });
  assert.ok(probe(media.mediaPath(media.getMedia(quiet.id))).audio);
});

test("errori chiari per l'agente e nessun file a metà", async () => {
  const before = media.listMedia().length;
  const bad = [
    [{ format: "cinema", slides: [{ svg: "<svg/>" }] }, /format/],
    [{ format: "story", slides: [] }, /almeno una schermata/],
    [{ format: "story", slides: [{ svg: "<svg/>", media: photo.id }] }, /non entrambi/],
    [{ format: "story", slides: [{ media: song.id }] }, /musica/],
    [{ format: "story", slides: [{ media: "m-inesistente" }] }, /non trovato/],
    [{ format: "story", slides: Array.from({ length: 21 }, () => ({ svg: "<svg/>" })) }, /al massimo 20/],
    [{ format: "story", slides: Array.from({ length: 8 }, () => ({ svg: "<svg/>", seconds: 15 })) }, /troppo lungo/],
    [{ format: "story", music: photo.id, slides: [{ svg: "<svg/>" }] }, /non è una musica/],
    [{ format: "story", slides: [{ svg: `<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>` }] }, /svg/],
  ];
  for (const [input, err] of bad) await assert.rejects(createVideo(input), err, JSON.stringify(input).slice(0, 80));
  assert.equal(media.listMedia().length, before);
  assert.deepEqual(fs.readdirSync(media.MEDIA_DIR).filter((f) => f.startsWith(".video-")), []);
});

test("agente: create_video è uno strumento valido e media_view mostra la copertina del video", async () => {
  const { validate, ALL_TOOLS } = await import("../lib/config.js");
  assert.ok(ALL_TOOLS.includes("create_video"));
  const a = { id: "video_maker", name: "Video Maker", room: "sala", mode: "llm", instructions: "x", tools: ["create_video", "media_view"], model: "claude-haiku-5-5", effort: "low", watchlist: [] };
  assert.deepEqual(validate(a, [{ id: "sala" }]), []);
  const v = await runTool(a, "create_video", { format: "square", title: "Quadrato", slides: [{ media: photo.id, seconds: 1.5 }] });
  assert.equal(v.by, "Video Maker");
  assert.equal(v.src, undefined, "agli agenti niente indirizzi dei file");
  const seen = await runTool(a, "media_view", { id: v.id });
  assert.equal(seen.toolContent[0].type, "image");
  await assert.rejects(runTool(a, "media_view", { id: clip.id }), /video/);
});
