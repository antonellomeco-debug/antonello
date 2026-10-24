// Video lunghi per YouTube (lib/social/longvideo.js): capitoli fatti con il motore dei video animati, uniti in un solo
// video orizzontale con la musica sotto, in sottofondo; nota «VIDEO LUNGO PRONTO» con i capitoli per la descrizione.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "longvideo-test-"));
Object.assign(process.env, {
  AGENTI_DATA_DIR: DATA,
  MARKET_MODE: "demo",
  MOTION_RENDERER: fileURLToPath(new URL("./helpers/fake-motion.mjs", import.meta.url)),
});
const media = await import("../lib/social/media.js");
const long = await import("../lib/social/longvideo.js");
const { runTool, enabledTools } = await import("../lib/tools.js");
const { getState } = await import("../lib/store.js");
const { ffmpegPath } = await import("../lib/social/video.js");
const FFMPEG = await ffmpegPath();

function probe(file) {
  let out = "";
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    out = String(err.stderr);
  }
  const [, h, m, s] = out.match(/Duration: (\d+):(\d+):([\d.]+)/) ?? [];
  const size = out.match(/Video: .*?, (\d{2,5})x(\d{2,5})/);
  return { seconds: Number(h) * 3600 + Number(m) * 60 + Number(s), size: size ? [Number(size[1]), Number(size[2])] : null, audio: /Audio: aac/.test(out) };
}

// Un capitolo di scene senza voce: 4 frasi da 18 secondi.
const chapter = (title, n) => ({ title, scenes: Array.from({ length: 4 }, (_, k) => ({ type: "statement", text: `${title}: punto ${k + 1} di ${n}`, seconds: 18 })) });
const agent = { id: "yt-long", name: "Regista Video Lunghi", room: "stanza-youtube", tools: ["create_long_video"] };

test("i capitoli si controllano prima di partire", async () => {
  assert.ok(enabledTools(agent).has("long_video_status"), "chi fa video lunghi ne vede anche lo stato");
  await assert.rejects(runTool(agent, "create_long_video", { title: "Uno", chapters: [chapter("Solo", 1)] }), /almeno 2 capitoli/);
  await assert.rejects(runTool(agent, "create_long_video", { title: "", chapters: [chapter("A", 1), chapter("B", 1)] }), /title/);
  await assert.rejects(
    runTool(agent, "create_long_video", { title: "Errore", chapters: [chapter("A", 1), { title: "B", scenes: [{ type: "boh" }] }] }),
    /capitolo 2, scena 1: type/,
  );
  await assert.rejects(
    runTool(agent, "create_long_video", { title: "Corto", chapters: [{ title: "A", scenes: [{ type: "statement", text: "Ciao", seconds: 3 }] }, { title: "B", scenes: [{ type: "statement", text: "Ciao di nuovo", seconds: 3 }] }] }),
    /troppo corto/,
  );
  assert.equal(long.chapterList(["Introduzione", "I numeri", "Cosa fare"], [45.2, 130, 60]), "00:00 Introduzione\n00:45 I numeri\n02:55 Cosa fare");
  assert.equal(long.chapterList(["A", "B"], [3700, 5]), "00:00 A\n1:01:40 B");
});

test("video lungo: capitoli uniti, 1920×1080 con la musica, nota con l'id e i capitoli", async () => {
  const mp3 = path.join(DATA, "musica.mp3");
  execFileSync(FFMPEG, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=20", "-c:a", "libmp3lame", mp3]);
  const song = await media.ingestUpload(mp3, { name: "musica.mp3", mime: "audio/mpeg" });

  const r = await runTool(agent, "create_long_video", {
    title: "Come si compra un bar: guida completa", description: "I passi per rilevare un locale.", music: song.id,
    chapters: [chapter("Introduzione", 3), chapter("I numeri da controllare", 3)],
  });
  assert.equal(r.status, "in_lavorazione", JSON.stringify(r));
  assert.match(r.pronto_tra, /minuti/);
  await assert.rejects(runTool(agent, "create_long_video", { title: "Un altro", chapters: [chapter("A", 1), chapter("B", 1)] }), /già un video lungo in lavorazione/);
  await long._idle();

  const st = (await runTool(agent, "long_video_status", {})).video[0];
  assert.equal(st.stato, "pronto", JSON.stringify(st));
  assert.equal(st.capitoli, "2 su 2");
  const file = media.mediaPath(media.getMedia(st.media_id));
  const p = probe(file);
  assert.deepEqual(p.size, [1920, 1080]);
  assert.ok(p.audio, "c'è l'audio (musica)");
  assert.ok(Math.abs(p.seconds - st.durata_secondi) < 2, `${p.seconds} s contro ${st.durata_secondi}`);
  assert.ok(st.durata_secondi > 140 && st.durata_secondi < 160, "due capitoli da 72 s più il cartello del capitolo 2");
  assert.match(st.capitoli_per_youtube, /^00:00 Introduzione\n01:1\d I numeri da controllare$/);

  const note = getState().notes["stanza-youtube"].at(-1);
  assert.match(note.text, /^VIDEO LUNGO PRONTO/);
  assert.ok(note.text.includes(st.media_id) && note.text.includes("00:00 Introduzione"));
  assert.ok(note.tags.includes("VIDEO LUNGO PRONTO"));
  assert.match(media.getMedia(st.media_id).description, /Capitoli:\n00:00 Introduzione/);
  assert.ok(!fs.readdirSync(media.MEDIA_DIR).some((f) => f.startsWith(".long-")), "la cartella di lavoro si cancella");
});

test("un video lungo rimasto a metà riparte dopo un riavvio", async () => {
  const file = path.join(DATA, "longvideos.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const spec = { ...saved.jobs[0].spec, title: "Ripreso dopo il riavvio" };
  saved.jobs.push({ id: "lvriavvio", at: new Date().toISOString(), status: "rendering", title: spec.title, spec, done: [], seconds: [], by: { id: agent.id, name: agent.name, room: agent.room } });
  fs.writeFileSync(file, JSON.stringify(saved));
  long._reload();
  long.resumeLongVideos();
  await long._idle();
  const st = long.longVideoStatus().video.find((v) => v.job_id === "lvriavvio");
  assert.equal(st.stato, "pronto", JSON.stringify(st));
  assert.match(long.longVideoStatus().limiti, /al massimo 4 video lunghi/);
});
