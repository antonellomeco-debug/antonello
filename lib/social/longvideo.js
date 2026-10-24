// Video lunghi per YouTube (5–15 minuti, orizzontali 1920×1080): lo stesso motore dei video animati, un capitolo per
// volta (ogni capitolo è un video animato fino a 150 s, con la sua voce e i suoi sottotitoli), poi i capitoli si uniscono
// e sotto va la musica, una sola dall'inizio alla fine. Ci vuole tanto (circa 6 secondi di lavoro per ogni secondo di
// video): il lavoro gira in sottofondo, sopravvive ai riavvii (i capitoli già pronti restano) e quando il video è pronto
// l'agente trova una nota «VIDEO LUNGO PRONTO» nella sua stanza con l'id da pubblicare e i capitoli per la descrizione.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../paths.js";
import { writeFileAtomic, readJsonSafe } from "../files.js";
import { postNote, log, bus } from "../store.js";
import { MEDIA_DIR, newId, getMedia, mediaPath, addVideoFile, assertSpace } from "./media.js";
import { checkScene, renderMotionClip, MOTION_FORMATS, THEMES, motionAvailable } from "./motion.js";
import { ffmpegPath, run } from "./video.js";

const FILE = path.join(DATA_DIR, "longvideos.json");
export const LIMITS = { chapters: 15, scenesPerChapter: 25, scenes: 200, chapterSeconds: 150, minSeconds: 120, maxSeconds: 900, voiceChars: 14_000, perMonth: 4 };
const SECONDS_OF_WORK = 6; // secondi di lavoro del server per ogni secondo di video (stima, con 2 worker)
const NOTE_AGENT = { id: "video-lunghi", name: "🎬 Video lunghi" };

let jobs = load();
function load() {
  const d = readJsonSafe(FILE).data;
  return Array.isArray(d?.jobs) ? d.jobs.filter((j) => j && j.id && j.spec) : [];
}
function save() {
  writeFileAtomic(FILE, JSON.stringify({ jobs: jobs.slice(-50) }, null, 2));
  bus.emit("event", { type: "social" });
}
const workDir = (job) => path.join(MEDIA_DIR, `.long-${job.id}`);

/** Capitoli e scene controllati prima di partire: un errore si dice subito all'agente, non dopo un'ora. */
function validate(input) {
  const title = String(input.title ?? "").trim();
  if (!title) throw new Error("title: il titolo del video (fino a 100 caratteri)");
  if (title.length > 100) throw new Error("title: al massimo 100 caratteri");
  const chapters = input.chapters;
  if (!Array.isArray(chapters) || chapters.length < 2) throw new Error("chapters: servono almeno 2 capitoli (per un video sotto i 90 secondi usa create_motion_video)");
  if (chapters.length > LIMITS.chapters) throw new Error(`chapters: al massimo ${LIMITS.chapters} capitoli`);
  let scenes = 0;
  let voiceChars = 0;
  let estimate = 0;
  const out = chapters.map((c, i) => {
    const where = `capitolo ${i + 1}`;
    const ct = String(c?.title ?? "").trim();
    if (!ct) throw new Error(`${where}: title (il nome del capitolo, compare nel video e nei capitoli di YouTube)`);
    if (ct.length > 60) throw new Error(`${where}: title al massimo 60 caratteri`);
    if (!Array.isArray(c.scenes) || !c.scenes.length) throw new Error(`${where}: scenes non può essere vuoto`);
    if (c.scenes.length > LIMITS.scenesPerChapter) throw new Error(`${where}: al massimo ${LIMITS.scenesPerChapter} scene per capitolo`);
    c.scenes.forEach((s, k) => {
      try {
        checkScene(s, k);
      } catch (err) {
        throw new Error(`${where}, ${err.message}`);
      }
      const v = String(s.voice ?? "").length;
      voiceChars += v;
      estimate += v ? v / 15 + 0.8 : Math.min(20, Math.max(1.5, Number(s.seconds) || 3.2));
    });
    scenes += c.scenes.length;
    return { title: ct, scenes: c.scenes };
  });
  if (scenes > LIMITS.scenes) throw new Error(`al massimo ${LIMITS.scenes} scene in tutto`);
  if (voiceChars > LIMITS.voiceChars) throw new Error(`voce troppo lunga: ${voiceChars} caratteri, al massimo ${LIMITS.voiceChars} (circa 15 minuti di parlato)`);
  const theme = THEMES[input.theme] ? input.theme : "notte";
  if (input.music) {
    const m = getMedia(String(input.music));
    if (m.kind !== "audio") throw new Error(`music: ${m.id} non è una musica dell'archivio`);
  }
  // Stima: ~15 caratteri di voce al secondo più un attimo per scena; le scene senza voce durano i loro secondi; più i cartelli.
  estimate = Math.round(estimate + (chapters.length - 1) * 2.6);
  if (estimate < LIMITS.minSeconds) throw new Error(`video troppo corto (circa ${estimate} s): un video lungo dura almeno 2 minuti; per i video brevi usa create_motion_video`);
  if (estimate > LIMITS.maxSeconds * 1.1) throw new Error(`video troppo lungo (circa ${Math.round(estimate / 60)} minuti): al massimo 15`);
  return {
    title, description: String(input.description ?? "").slice(0, 1000), theme, accent: input.accent, transition: input.transition ?? "mix",
    music: input.music ? String(input.music) : null, music_volume: input.music_volume, voice_speed: input.voice_speed, chapters: out, estimate, voiceChars,
  };
}

/** I capitoli dal secondo in poi si aprono con un cartello «CAPITOLO N» e il titolo. */
function chapterScenes(spec, i) {
  const c = spec.chapters[i];
  return i === 0 ? c.scenes : [{ type: "statement", chapter: true, kicker: `CAPITOLO ${i + 1}`, text: c.title, seconds: 2.6 }, ...c.scenes];
}

const stamp = (sec) => {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
/** Capitoli per la descrizione di YouTube: il primo a 00:00, uno per riga. */
export function chapterList(titles, seconds) {
  let at = 0;
  return titles.map((t, i) => {
    const line = `${stamp(at)} ${t}`;
    at += seconds[i] ?? 0;
    return line;
  }).join("\n");
}

/** Nuovo video lungo: controlla tutto, lo mette in coda e risponde subito. */
export function createLongVideo(input = {}, { agent = null } = {}) {
  if (!motionAvailable()) throw new Error("Il motore dei video animati non è installato su questo computer: i video lunghi si fanno sul server.");
  const spec = validate(input);
  const busy = jobs.find((j) => ["queued", "rendering"].includes(j.status));
  if (busy) throw new Error(`c'è già un video lungo in lavorazione («${busy.title}», ${busy.done?.length ?? 0} capitoli su ${busy.spec.chapters.length}): uno per volta. Controlla con long_video_status.`);
  const month = jobs.filter((j) => j.status !== "failed" && Date.now() - Date.parse(j.at) < 30 * 86400_000).length;
  if (month >= LIMITS.perMonth) throw new Error(`già ${month} video lunghi negli ultimi 30 giorni: al massimo ${LIMITS.perMonth} (costano tempo del server e crediti della voce)`);
  assertSpace(Math.round(spec.estimate * 2.5 * 1024 * 1024)); // capitoli + video finale
  const job = {
    id: `lv${Date.now().toString(36)}`, at: new Date().toISOString(), status: "queued", title: spec.title, spec, done: [], seconds: [],
    by: agent ? { id: agent.id, name: agent.name, room: agent.room ?? null } : null,
  };
  jobs.push(job);
  save();
  start(job);
  const minutes = Math.max(5, Math.round((spec.estimate * SECONDS_OF_WORK) / 60));
  return {
    job_id: job.id,
    status: "in_lavorazione",
    durata_stimata: `${Math.round(spec.estimate / 60)} minuti di video`,
    pronto_tra: `circa ${minutes} minuti`,
    message:
      `Video lungo in lavorazione: ${spec.chapters.length} capitoli, uno per volta. Quando è pronto trovi una nota «VIDEO LUNGO PRONTO» ` +
      `${job.by?.room ? "nella tua stanza" : "nel registro attività"} con l'id per social_publish (network youtube) e i capitoli da mettere nella descrizione. ` +
      "Intanto puoi preparare la miniatura con create_graphic (format youtube_thumb). Stato in ogni momento: long_video_status.",
  };
}

const running = new Set();
function start(job) {
  if (running.has(job.id)) return;
  running.add(job.id);
  work(job)
    .catch((err) => finish(job, { status: "failed", error: err.message }))
    .finally(() => running.delete(job.id));
}

async function work(job) {
  const dir = workDir(job);
  fs.mkdirSync(dir, { recursive: true });
  const { spec } = job;
  const f = MOTION_FORMATS.landscape;
  job.status = "rendering";
  save();
  let voce = job.voce ?? null;
  for (let i = 0; i < spec.chapters.length; i++) {
    const clip = path.join(dir, `cap${String(i + 1).padStart(2, "0")}.mp4`);
    if (job.done.includes(i) && fs.existsSync(clip)) continue; // pronto prima di un riavvio
    const r = await renderMotionClip(
      { format: "landscape", theme: spec.theme, accent: spec.accent, transition: spec.transition, voice_speed: spec.voice_speed, scenes: chapterScenes(spec, i) },
      clip,
      { maxTotal: LIMITS.chapterSeconds, maxScenes: LIMITS.scenesPerChapter + 1 },
    ).catch((err) => {
      throw new Error(`capitolo ${i + 1} («${spec.chapters[i].title}»): ${err.message}`);
    });
    job.done = [...job.done.filter((x) => x !== i), i];
    job.seconds[i] = r.seconds;
    if (r.voce && (!voce || /riserva/.test(r.voce))) voce = r.voce;
    job.voce = voce;
    save();
  }
  const total = job.seconds.reduce((a, b) => a + b, 0);
  if (total > LIMITS.maxSeconds + 60) throw new Error(`video troppo lungo (${Math.round(total / 60)} minuti): al massimo 15`);

  // Unione dei capitoli (stesso formato: nessuna nuova codifica del video) e musica sotto la voce, una sola dall'inizio alla fine.
  const bin = await ffmpegPath();
  const list = path.join(dir, "capitoli.txt");
  fs.writeFileSync(list, spec.chapters.map((_, i) => `file 'cap${String(i + 1).padStart(2, "0")}.mp4'`).join("\n"));
  const joined = path.join(dir, "unito.mp4");
  await run(bin, ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", joined], dir);
  const id = newId();
  const out = path.join(MEDIA_DIR, `${id}.mp4`);
  if (spec.music) {
    const vol = Math.min(1, Math.max(0, Number(spec.music_volume ?? 0.15)));
    const fmt = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
    await run(bin, [
      "-y", "-v", "error", "-i", joined, "-stream_loop", "-1", "-i", mediaPath(getMedia(spec.music)),
      "-filter_complex",
      `[0:a]${fmt},asplit=2[a][sc];[1:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,${fmt},volume=${vol},afade=t=in:d=1,afade=t=out:st=${Math.max(0, total - 3).toFixed(3)}:d=3[m0];` +
        "[m0][sc]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350[m];[a][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[aout]",
      "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out,
    ], dir);
  } else {
    fs.renameSync(joined, out);
  }
  const poster = path.join(dir, "poster.jpg");
  await run(bin, ["-y", "-v", "error", "-ss", "1.6", "-i", out, "-frames:v", "1", "-q:v", "3", poster], dir);
  const chapters = chapterList(spec.chapters.map((c) => c.title), job.seconds);
  const saved = await addVideoFile(id, {
    poster, cover: poster, title: spec.title, description: `${spec.description}\n\nCapitoli:\n${chapters}`.trim(), origin: "video", by: job.by?.name ?? null,
    width: f.w, height: f.h, duration: Math.round(total * 10) / 10,
  });
  finish(job, { status: "done", mediaId: saved.id, chapters, duration: Math.round(total) });
}

function finish(job, patch) {
  Object.assign(job, patch, { endedAt: new Date().toISOString() });
  save();
  const minutes = `${Math.floor((job.duration ?? 0) / 60)}:${String((job.duration ?? 0) % 60).padStart(2, "0")}`;
  const text = job.status === "done"
    ? `VIDEO LUNGO PRONTO: «${job.title}» (${minutes} minuti), id ${job.mediaId}. Pubblicalo con social_publish (network youtube, media [${job.mediaId}], ` +
      `title, thumbnail fatta con create_graphic youtube_thumb). Metti nella descrizione questi capitoli (YouTube li mostra nella barra):\n${job.chapters}` +
      (job.voce ? `\nVoce: ${job.voce}.` : "")
    : `VIDEO LUNGO NON RIUSCITO: «${job.title}». ${job.error}. Correggi e richiedilo con create_long_video (i capitoli si rifanno da capo).`;
  log(job.by?.id ?? "social", job.status === "done" ? "info" : "warn", text.split("\n")[0]);
  if (job.by?.room) postNote(job.by.room, NOTE_AGENT, text, [job.status === "done" ? "VIDEO LUNGO PRONTO" : "VIDEO LUNGO NON RIUSCITO"]);
  if (job.status === "done" || job.status === "failed") fs.rmSync(workDir(job), { recursive: true, force: true });
}

/** Ultimi video lunghi, per gli agenti e per Orion. */
export function longVideoStatus() {
  return {
    video: jobs.slice(-8).reverse().map((j) => ({
      job_id: j.id, titolo: j.title, stato: { queued: "in coda", rendering: "in lavorazione", done: "pronto", failed: "non riuscito" }[j.status],
      capitoli: `${j.done?.length ?? 0} su ${j.spec.chapters.length}`, richiesto: j.at,
      ...(j.mediaId ? { media_id: j.mediaId, durata_secondi: j.duration, capitoli_per_youtube: j.chapters } : {}),
      ...(j.error ? { errore: j.error } : {}),
    })),
    limiti: `al massimo ${LIMITS.perMonth} video lunghi in 30 giorni, uno per volta, ${LIMITS.chapters} capitoli, 15 minuti`,
  };
}

/** All'avvio: riprende i video lunghi rimasti a metà (i capitoli già pronti non si rifanno). */
export function resumeLongVideos() {
  for (const j of jobs.filter((x) => ["queued", "rendering"].includes(x.status))) start(j);
}

/** Solo per le prove. */
export function _reload() {
  jobs = load();
}
export async function _idle() {
  while (running.size) await new Promise((r) => setTimeout(r, 20));
}
