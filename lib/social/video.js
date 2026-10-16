// Video montati dagli agenti (reel, storie, video per il feed): una serie di schermate disegnate in SVG, foto o
// spezzoni di video dell'archivio, con un leggero zoom, transizioni, scritte sopra e, se c'è, una musica caricata
// dall'utente. Il montaggio lo fa ffmpeg sul nostro server o sul Mac (gratis: nessun servizio a pagamento).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { MEDIA_DIR, newId, getMedia, mediaPath, renderSvg, addVideoFile, getSharp, assertSpace } from "./media.js";

/** Misure dei video (pari: lo chiede il formato H.264). */
export const VIDEO_FORMATS = {
  story: { w: 1080, h: 1920, label: "reel/storia 9:16 1080×1920 (Instagram Reels, storie, Threads, X e LinkedIn da telefono)" },
  portrait: { w: 1080, h: 1350, label: "verticale 4:5 1080×1350 (feed)" },
  square: { w: 1080, h: 1080, label: "quadrato 1080×1080" },
  landscape: { w: 1280, h: 720, label: "orizzontale 16:9 1280×720 (X, LinkedIn)" },
};
export const TRANSITIONS = ["fade", "fadeblack", "slideleft", "slideup", "smoothleft", "circleopen", "dissolve", "none"];
export const MOTIONS = ["zoom_in", "zoom_out", "none"];
const FPS = 30;
const MAX_SLIDES = 20;
const MAX_TOTAL = 90; // secondi: più che sufficienti per un reel (e sotto i 140 di X)
const TIMEOUT_MS = 6 * 60_000;

let chain = Promise.resolve(); // un montaggio per volta: ffmpeg usa tutto il processore

/** ffmpeg: FFMPEG_PATH, poi quello del pacchetto ffmpeg-static (installato con il programma), poi quello del sistema. */
async function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const m = await import("ffmpeg-static");
    if (m.default && fs.existsSync(m.default)) return m.default;
  } catch {
    // pacchetto non installato: si prova quello del sistema
  }
  return "ffmpeg";
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === "ENOENT" ? "Manca ffmpeg (il programma che monta i video): sul Mac premi 🔄 Aggiorna o riapri il programma." : e.message));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(err);
      else reject(new Error(signal ? "montaggio interrotto: ci metteva troppo (prova con meno schermate o più corte)" : `montaggio non riuscito: ${err.trim().split("\n").slice(-3).join(" ")}`));
    });
  });
}

const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
};

/** Controlla le schermate prima di fare qualsiasi lavoro (errori chiari per l'agente). */
function checkSlides(slides, transition) {
  if (!Array.isArray(slides) || !slides.length) throw new Error("slides: serve almeno una schermata");
  if (slides.length > MAX_SLIDES) throw new Error(`slides: al massimo ${MAX_SLIDES} schermate`);
  const out = slides.map((s, i) => {
    const where = `schermata ${i + 1}`;
    if (!s || typeof s !== "object") throw new Error(`${where}: dev'essere un oggetto`);
    if (Boolean(s.svg) === Boolean(s.media)) throw new Error(`${where}: indica svg (schermata disegnata) oppure media (foto o video dell'archivio), non entrambi`);
    let m = null;
    if (s.media) {
      m = getMedia(String(s.media));
      if (m.kind === "audio") throw new Error(`${where}: ${m.id} è una musica (va in music)`);
    }
    const seconds = num(s.seconds, 1, 15, 3.5);
    const motion = MOTIONS.includes(s.motion) ? s.motion : m?.kind === "video" ? "none" : "zoom_in";
    return { svg: s.svg ? String(s.svg) : null, media: m, overlay: s.overlay_svg ? String(s.overlay_svg) : null, seconds, motion, start: num(s.start, 0, 3600, 0) };
  });
  const t = TRANSITIONS.includes(transition) ? transition : "fade";
  const tdur = t === "none" ? 1 / FPS : 0.5;
  const total = out.reduce((n, s) => n + s.seconds, 0) - tdur * (out.length - 1);
  if (total > MAX_TOTAL) throw new Error(`video troppo lungo (${Math.round(total)} s): al massimo ${MAX_TOTAL} secondi`);
  if (out.some((s) => s.seconds <= tdur + 0.2)) throw new Error("ogni schermata deve durare almeno 1 secondo");
  return { slides: out, transition: t === "none" ? "fade" : t, tdur, total };
}

/**
 * Monta un video e lo mette nell'archivio. slides: [{ svg | media, overlay_svg?, seconds?, motion?, start? }].
 * music: id di una musica dell'archivio (facoltativa). Restituisce il file dell'archivio (id da usare nei post).
 */
export function createVideo(input = {}) {
  const job = chain.then(() => montage(input));
  chain = job.catch(() => {});
  return job;
}

async function montage({ format = "story", slides, transition, music, title = "", description = "", by = null } = {}) {
  const f = VIDEO_FORMATS[format];
  if (!f) throw new Error(`format: ${Object.keys(VIDEO_FORMATS).join(", ")}`);
  const plan = checkSlides(slides, transition);
  const song = music ? getMedia(String(music)) : null;
  if (song && song.kind !== "audio") throw new Error(`music: ${song.id} non è una musica (carica un MP3 o M4A nell'archivio)`);
  assertSpace(50 * 1024 * 1024);

  const id = newId();
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(MEDIA_DIR, `.video-${id}-`));
  const out = path.join(MEDIA_DIR, `${id}.mp4`);
  try {
    const sharp = await getSharp();
    const args = ["-y", "-v", "error"];
    const chains = [];
    let input = 0;
    for (const [i, s] of plan.slides.entries()) {
      const frames = Math.round(s.seconds * FPS);
      let v;
      if (s.media?.kind === "video") {
        args.push("-ss", String(s.start), "-t", String(s.seconds), "-i", mediaPath(s.media));
        // Riempie il formato (taglio al centro); se lo spezzone è più corto resta fermo l'ultimo fotogramma.
        v = `[${input++}:v]scale=${f.w}:${f.h}:force_original_aspect_ratio=increase,crop=${f.w}:${f.h},fps=${FPS},tpad=stop_mode=clone:stop_duration=${s.seconds},trim=duration=${s.seconds},setpts=PTS-STARTPTS`;
      } else {
        const png = path.join(work, `s${i}.png`);
        if (s.svg) fs.writeFileSync(png, await renderSvg(s.svg, f.w, f.h));
        else await sharp(mediaPath(s.media)).rotate().resize(f.w, f.h, { fit: "cover", position: "attention" }).flatten({ background: "#000000" }).png().toFile(png);
        args.push("-i", png);
        if (s.motion === "none") {
          v = `[${input++}:v]loop=loop=${frames - 1}:size=1:start=0,setpts=N/${FPS}/TB`;
        } else {
          // Zoom lento (8%) partendo da un'immagine grande il doppio: il movimento resta fluido.
          const z = s.motion === "zoom_in" ? `1+0.08*on/${frames}` : `1.08-0.08*on/${frames}`;
          v = `[${input++}:v]scale=${f.w * 2}:${f.h * 2},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${f.w}x${f.h}:fps=${FPS}`;
        }
      }
      if (s.overlay) {
        // Scritte e grafiche sopra la foto o il video (sfondo trasparente): restano ferme mentre lo sfondo si muove.
        const png = path.join(work, `o${i}.png`);
        fs.writeFileSync(png, await renderSvg(s.overlay, f.w, f.h));
        args.push("-i", png);
        chains.push(`${v}[b${i}]`);
        v = `[b${i}][${input++}:v]overlay=0:0`;
      }
      chains.push(`${v},fps=${FPS},settb=1/${FPS},setsar=1,format=yuv420p[v${i}]`);
    }
    // Transizioni tra una schermata e l'altra.
    let last = "v0";
    let length = plan.slides[0].seconds;
    for (let i = 1; i < plan.slides.length; i++) {
      const offset = (length - plan.tdur).toFixed(3);
      chains.push(`[${last}][v${i}]xfade=transition=${plan.transition}:duration=${plan.tdur.toFixed(3)}:offset=${offset}[x${i}]`);
      last = `x${i}`;
      length += plan.slides[i].seconds - plan.tdur;
    }
    const total = length.toFixed(3);
    // Audio: la musica scelta (ripetuta se è corta, con dissolvenza alla fine) oppure silenzio (alcune app lo vogliono).
    if (song) {
      args.push("-stream_loop", "-1", "-i", mediaPath(song));
      chains.push(`[${input++}:a]atrim=0:${total},asetpts=PTS-STARTPTS,afade=t=in:d=0.3,afade=t=out:st=${Math.max(0, length - 1.5).toFixed(3)}:d=1.5[aout]`);
    } else {
      args.push("-f", "lavfi", "-t", total, "-i", "anullsrc=r=44100:cl=stereo");
      chains.push(`[${input++}:a]anull[aout]`);
    }
    args.push(
      "-filter_complex", chains.join(";"),
      "-map", `[${last}]`, "-map", "[aout]", "-t", total,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-movflags", "+faststart", out,
    );
    const bin = await ffmpegPath();
    await run(bin, args);
    // Copertina: un fotogramma dall'inizio (dopo l'eventuale dissolvenza).
    const poster = path.join(work, "poster.jpg");
    await run(bin, ["-y", "-v", "error", "-ss", String(Math.min(0.6, length / 2)), "-i", out, "-frames:v", "1", "-q:v", "3", poster]);
    return await addVideoFile(id, { poster, title: title || "Video", description, origin: "video", by, width: f.w, height: f.h, duration: Math.round(length * 10) / 10 });
  } catch (err) {
    fs.rmSync(out, { force: true });
    throw err;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
