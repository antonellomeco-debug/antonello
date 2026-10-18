// Video montati dagli agenti (reel, storie, video per il feed), nello stile dei video che "tengono incollati":
// schermate che cambiano spesso (clip di repertorio, foto e video dell'archivio, schermate disegnate in SVG o solo
// testo su colore), voce narrante italiana (tts.js) con sottotitoli grandi parola per parola, titoli animati,
// movimenti di camera, transizioni, barra di avanzamento, effetti sonori e musica che si abbassa quando parla la
// voce. Il montaggio lo fa ffmpeg (con libass per i testi) sul nostro server o sul Mac: gratis.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "../paths.js";
import { MEDIA_DIR, newId, getMedia, mediaPath, renderSvg, addVideoFile, getSharp, assertSpace } from "./media.js";
import { synthesize } from "./tts.js";

/** Misure dei video (pari: lo chiede il formato H.264) e misure dei testi per ogni formato. */
export const VIDEO_FORMATS = {
  story: { w: 1080, h: 1920, cap: 86, capMargin: 540, head: 104, headTop: 300, label: "reel/storia 9:16 1080×1920 (Instagram Reels, storie, Threads, X e LinkedIn da telefono)" },
  portrait: { w: 1080, h: 1350, cap: 74, capMargin: 230, head: 90, headTop: 130, label: "verticale 4:5 1080×1350 (feed, LinkedIn)" },
  square: { w: 1080, h: 1080, cap: 66, capMargin: 170, head: 82, headTop: 110, label: "quadrato 1080×1080" },
  landscape: { w: 1280, h: 720, cap: 50, capMargin: 80, head: 64, headTop: 70, label: "orizzontale 16:9 1280×720 (X, LinkedIn)" },
};
const XFADES = ["fade", "fadeblack", "fadewhite", "slideleft", "slideup", "smoothleft", "circleopen", "dissolve", "zoomin", "hblur", "radial"];
export const TRANSITIONS = [...XFADES, "mix", "none"];
const MIX = ["slideleft", "zoomin", "smoothleft", "fadewhite", "slideup", "circleopen", "hblur"];
export const MOTIONS = ["zoom_in", "zoom_out", "punch", "pan_left", "pan_right", "none"];
export const HEAD_ANIMS = ["pop", "slide", "typewriter", "fade"];
const FPS = 30;
const MAX_SLIDES = 30;
const MAX_TOTAL = 90; // secondi: più che sufficienti per un reel (e sotto i 140 di X)
const TIMEOUT_MS = 8 * 60_000;
const TDUR = 0.35; // durata delle transizioni: brevi, il ritmo deve essere veloce

let chain = Promise.resolve(); // un montaggio per volta: ffmpeg usa tutto il processore

/** ffmpeg: FFMPEG_PATH, poi quello del pacchetto ffmpeg-static (installato con il programma), poi quello del sistema. */
export async function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const m = await import("ffmpeg-static");
    if (m.default && fs.existsSync(m.default)) return m.default;
  } catch {
    // pacchetto non installato: si prova quello del sistema
  }
  return "ffmpeg";
}

export function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
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
const hex = (v, dflt) => (/^#[0-9a-f]{6}$/i.test(String(v ?? "")) ? String(v) : dflt);

/** Controlla le schermate prima di fare qualsiasi lavoro (errori chiari per l'agente). */
function checkSlides(slides) {
  if (!Array.isArray(slides) || !slides.length) throw new Error("slides: serve almeno una schermata");
  if (slides.length > MAX_SLIDES) throw new Error(`slides: al massimo ${MAX_SLIDES} schermate`);
  return slides.map((s, i) => {
    const where = `schermata ${i + 1}`;
    if (!s || typeof s !== "object") throw new Error(`${where}: dev'essere un oggetto`);
    if (s.svg && s.media) throw new Error(`${where}: indica svg (schermata disegnata) oppure media (foto o video dell'archivio), non entrambi`);
    const headline = String(s.headline ?? "").trim();
    const voice = String(s.voice ?? "").trim();
    if (!s.svg && !s.media && !headline && !s.overlay_svg) throw new Error(`${where}: serve uno sfondo (svg o media) oppure almeno un headline su colore`);
    if (headline.length > 140) throw new Error(`${where}: headline troppo lungo (massimo 140 caratteri: poche parole che si leggono in un attimo)`);
    if (voice.length > 500) throw new Error(`${where}: voice troppo lunga (massimo 500 caratteri: una o due frasi per schermata)`);
    let m = null;
    if (s.media) {
      m = getMedia(String(s.media));
      if (m.kind === "audio") throw new Error(`${where}: ${m.id} è una musica (va in music)`);
    }
    return {
      svg: s.svg ? String(s.svg) : null,
      media: m,
      overlay: s.overlay_svg ? String(s.overlay_svg) : null,
      bg: hex(s.background, "#0b1020"),
      headline,
      anim: HEAD_ANIMS.includes(s.headline_anim) ? s.headline_anim : "pop",
      pos: s.headline_position === "center" || (!s.svg && !s.media && s.headline_position !== "top") ? "center" : "top",
      voice,
      seconds: s.seconds == null ? null : num(s.seconds, 0.8, 15, 2.5),
      motion: MOTIONS.includes(s.motion) ? s.motion : m?.kind === "video" ? "none" : "zoom_in",
      start: num(s.start, 0, 3600, 0),
    };
  });
}

/**
 * Monta un video e lo mette nell'archivio. slides: [{ svg | media | (solo testo su background), overlay_svg?, headline?,
 * headline_anim?, headline_position?, voice?, seconds?, motion?, start? }]. Opzioni: music, music_volume, transition,
 * captions, accent, progress_bar, sfx, voice_speed. Restituisce il file dell'archivio (id da usare nei post).
 */
export function createVideo(input = {}) {
  return enqueue(() => montage(input));
}

/** Un lavoro video per volta (anche quelli di motion.js): usano tutto il processore. */
export function enqueue(fn) {
  const job = chain.then(fn);
  chain = job.catch(() => {});
  return job;
}

// ---------- testi (sottotitoli e titoli, in formato ASS per libass) ----------

const assTime = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
/** Colore ASS (&HAABBGGRR) da #RRGGBB. */
const assColor = (h, alpha = "00") => `&H${alpha}${h.slice(5, 7)}${h.slice(3, 5)}${h.slice(1, 3)}`.toUpperCase();
const assText = (t) => String(t).replace(/[{}]/g, "").replace(/\\/g, "/").replace(/[\r\n]+/g, " ").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").trim();

/** Le parole lette "70 per cento" tornano "70%" nei sottotitoli. */
function displayWords(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d[\d.,]*$/.test(w.word) && words[i + 1]?.word === "per" && /^cento/.test(words[i + 2]?.word ?? "")) {
      out.push({ word: `${w.word}%${words[i + 2].word.slice(5)}`, start: w.start, end: words[i + 2].end });
      i += 2;
    } else out.push(w);
  }
  return out;
}

/** Gruppi di 1-3 parole (il sottotitolo "a scatti" dei reel); si va a capo dopo la punteggiatura. */
function captionChunks(words) {
  const chunks = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    const len = cur.map((x) => x.word).join(" ").length;
    if (cur.length >= 3 || len >= 15 || /[.!?…,;:]$/.test(w.word)) {
      chunks.push(cur);
      cur = [];
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Titolo con le parole tra *asterischi* nel colore d'accento. */
function headlineText(text, accent, hideFrom = Infinity) {
  let k = 0;
  return assText(text)
    .split(/(\*[^*]+\*)/)
    .flatMap((part) => {
      const marked = /^\*[^*]+\*$/.test(part);
      return part.replace(/\*/g, "").split(/(\s+)/).filter(Boolean).map((w) => ({ w, marked }));
    })
    .map(({ w, marked }) => {
      if (/^\s+$/.test(w)) return w;
      const hidden = k++ >= hideFrom;
      const color = marked ? `{\\c${assColor(accent)}}` : "";
      const reset = marked ? "{\\c&H00FFFFFF&}" : "";
      return hidden ? `{\\alpha&HFF&}${w}{\\alpha&H00&}` : `${color}${w}${reset}`;
    })
    .join("");
}

function buildAss(f, plan, accent) {
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${f.w}`, `PlayResY: ${f.h}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,Montserrat,${f.cap},&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,${Math.round(f.cap / 8)},4,2,70,70,${f.capMargin},1`,
    `Style: Head,Montserrat,${f.head},&H00FFFFFF,&H00FFFFFF,&H001A0F0B,&H00000000,-1,0,0,0,100,100,0,0,3,${Math.round(f.head / 7)},0,8,80,80,${f.headTop},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const ev = (layer, a, b, style, text) => lines.push(`Dialogue: ${layer},${assTime(a)},${assTime(b)},${style},,0,0,0,,${text}`);
  const acc = assColor(accent);
  for (const [i, s] of plan.slides.entries()) {
    // Titolo animato della schermata.
    if (s.headline) {
      const a = s.at + (i > 0 ? TDUR * 0.6 : 0.05);
      const b = s.at + s.dur - (i < plan.slides.length - 1 ? TDUR * 0.5 : 0);
      const x = Math.round(f.w / 2);
      const y = s.pos === "center" ? Math.round(f.h / 2) : f.headTop;
      const an = s.pos === "center" ? 5 : 8;
      if (s.anim === "typewriter") {
        const n = s.headline.replace(/\*/g, "").split(/\s+/).filter(Boolean).length;
        const step = Math.min(0.14, 0.9 / Math.max(1, n));
        for (let k = 1; k <= n; k++) {
          ev(1, a + (k - 1) * step, k === n ? b : a + k * step, "Head", `{\\an${an}\\pos(${x},${y})${k === n ? "\\fad(0,150)" : ""}}${headlineText(s.headline, accent, k)}`);
        }
      } else {
        const fx = s.anim === "slide"
          ? `\\move(${x},${y + 90},${x},${y},0,260)\\fad(120,150)`
          : s.anim === "fade"
            ? `\\pos(${x},${y})\\fad(300,150)`
            : `\\pos(${x},${y})\\fscx35\\fscy35\\t(0,170,\\fscx108\\fscy108)\\t(170,260,\\fscx100\\fscy100)\\fad(0,150)`;
        ev(1, a, b, "Head", `{\\an${an}${fx}}${headlineText(s.headline, accent)}`);
      }
    }
    // Sottotitoli della voce: gruppi di parole, la parola detta in quel momento colorata e un po' più grande.
    if (plan.captions && s.words?.length) {
      for (const group of captionChunks(displayWords(s.words))) {
        const words = group.map((w) => assText(w.word).replace(/[.,;:]+$/, "").toUpperCase());
        group.forEach((w, k) => {
          const a = s.voiceAt + w.start;
          const b = s.voiceAt + (k < group.length - 1 ? group[k + 1].start : w.end + 0.08);
          const text = words.map((t, j) => (j === k ? `{\\c${acc}\\fscx112\\fscy112}${t}{\\c&H00FFFFFF&\\fscx100\\fscy100}` : t)).join(" ");
          ev(2, a, b, "Cap", `${k === 0 ? "{\\fscx80\\fscy80\\t(0,90,\\fscx100\\fscy100)}" : ""}${text}`);
        });
      }
    }
  }
  return lines.join("\n") + "\n";
}

// ---------- montaggio ----------

async function montage({
  format = "story", slides, transition, music, music_volume, title = "", description = "", by = null,
  captions, accent, progress_bar, sfx, voice_speed,
} = {}) {
  const f = VIDEO_FORMATS[format];
  if (!f) throw new Error(`format: ${Object.keys(VIDEO_FORMATS).join(", ")}`);
  const list = checkSlides(slides);
  const song = music ? getMedia(String(music)) : null;
  if (song && song.kind !== "audio") throw new Error(`music: ${song.id} non è una musica (carica un MP3 o M4A nell'archivio)`);
  const trans = TRANSITIONS.includes(transition) ? transition : "fade";
  const color = hex(accent, "#FFD166");
  assertSpace(80 * 1024 * 1024);

  const id = newId();
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(MEDIA_DIR, `.video-${id}-`));
  const out = path.join(MEDIA_DIR, `${id}.mp4`);
  try {
    // 1. Voce: un audio per schermata, con i tempi delle parole.
    const voices = list.some((s) => s.voice) ? await synthesize(list.map((s) => s.voice), work, { speed: num(voice_speed, 0.85, 1.3, 1.08) }) : list.map(() => null);
    const n = list.length;
    const tdur = trans === "none" ? 1 / FPS : TDUR;
    // 2. Tempi: ogni schermata dura quanto la sua frase (o "seconds"), la voce finisce prima della transizione dopo.
    let at = 0;
    const plan = { slides: [], captions: captions ?? voices.some(Boolean) };
    for (const [i, s] of list.entries()) {
      const v = voices[i];
      const lead = (i > 0 ? tdur : 0) + 0.12;
      const need = v ? lead + v.seconds + 0.25 + (i < n - 1 ? tdur : 0) : 0;
      const dur = Math.max(s.seconds ?? (v ? 0 : 2.5), need, tdur + 0.5);
      plan.slides.push({ ...s, at, dur, voiceAt: at + lead, voiceFile: v?.file, words: v?.words });
      at += dur - tdur;
    }
    const total = at + tdur;
    if (total > MAX_TOTAL) throw new Error(`video troppo lungo (${Math.round(total)} s): al massimo ${MAX_TOTAL} secondi (accorcia le frasi o togli schermate)`);

    // 3. Video: una catena di filtri per schermata, poi le transizioni.
    const sharp = await getSharp();
    const args = ["-y", "-v", "error"];
    const chains = [];
    let input = 0;
    for (const [i, s] of plan.slides.entries()) {
      const frames = Math.round(s.dur * FPS);
      let v;
      if (s.media?.kind === "video") {
        args.push("-ss", String(s.start), "-t", s.dur.toFixed(3), "-i", mediaPath(s.media));
        // Riempie il formato (taglio al centro); se lo spezzone è più corto resta fermo l'ultimo fotogramma.
        v = `[${input++}:v]scale=${f.w}:${f.h}:force_original_aspect_ratio=increase,crop=${f.w}:${f.h},fps=${FPS},tpad=stop_mode=clone:stop_duration=${s.dur.toFixed(3)},trim=duration=${s.dur.toFixed(3)},setpts=PTS-STARTPTS`;
      } else {
        const png = path.join(work, `s${i}.png`);
        if (s.svg) fs.writeFileSync(png, await renderSvg(s.svg, f.w, f.h));
        else if (s.media) await sharp(mediaPath(s.media)).rotate().resize(f.w, f.h, { fit: "cover", position: "attention" }).flatten({ background: "#000000" }).png().toFile(png);
        else await sharp(Buffer.from(backgroundSvg(f, s.bg))).png().toFile(png); // solo testo: sfondo sfumato nel colore scelto
        args.push("-i", png);
        v = `[${input++}:v]${moveFilter(s.motion, f, frames)}`;
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
    let last = "v0";
    for (let i = 1; i < n; i++) {
      const kind = trans === "none" ? "fade" : trans === "mix" ? MIX[(i - 1) % MIX.length] : trans;
      chains.push(`[${last}][v${i}]xfade=transition=${kind}:duration=${tdur.toFixed(3)}:offset=${plan.slides[i].at.toFixed(3)}[x${i}]`);
      last = `x${i}`;
    }
    // Barra di avanzamento in alto: cresce per tutta la durata (chi la vede sa che manca poco e resta).
    if (progress_bar ?? true) {
      args.push("-f", "lavfi", "-i", `color=c=${color.replace("#", "0x")}:s=${f.w}x${Math.max(8, Math.round(f.h / 160))}:r=${FPS}:d=${total.toFixed(3)}`);
      chains.push(`[${last}][${input++}:v]overlay=x='-w+w*t/${total.toFixed(3)}':y=0:shortest=1[pb]`);
      last = "pb";
    }
    // Titoli e sottotitoli (libass, con i caratteri del programma copiati nella cartella di lavoro).
    if (plan.slides.some((s) => s.headline || (plan.captions && s.words?.length))) {
      fs.writeFileSync(path.join(work, "testi.ass"), buildAss(f, plan, color));
      fs.mkdirSync(path.join(work, "fonts"));
      for (const font of ["Montserrat.ttf", "Inter.ttf", "BebasNeue-Regular.ttf"]) fs.copyFileSync(path.join(ROOT, "assets", "fonts", font), path.join(work, "fonts", font));
      chains.push(`[${last}]ass=testi.ass:fontsdir=fonts[txt]`);
      last = "txt";
    }

    // 4. Audio: voce + musica (più bassa quando parla la voce) + effetti sonori, su una base di silenzio.
    const mix = [];
    args.push("-f", "lavfi", "-t", total.toFixed(3), "-i", "anullsrc=r=44100:cl=stereo");
    chains.push(`[${input++}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[base]`);
    mix.push("[base]");
    const fmt = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
    const voiced = plan.slides.filter((s) => s.voiceFile);
    if (voiced.length) {
      const labels = voiced.map((s, k) => {
        args.push("-i", s.voiceFile);
        const ms = Math.round(s.voiceAt * 1000);
        chains.push(`[${input++}:a]${fmt},adelay=${ms}|${ms}[vo${k}]`);
        return `[vo${k}]`;
      });
      chains.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0,apad=whole_dur=${total.toFixed(3)},volume=1.8,${fmt},asplit=2[voice][voicesc]`);
      mix.push("[voice]");
    }
    if (song) {
      args.push("-stream_loop", "-1", "-i", mediaPath(song));
      const vol = num(music_volume, 0, 1, voiced.length ? 0.22 : 0.7);
      chains.push(`[${input++}:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,${fmt},volume=${vol},afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5[music0]`);
      if (voiced.length) chains.push("[music0][voicesc]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350[music]");
      else chains.push("[music0]anull[music]");
      mix.push("[music]");
    } else if (voiced.length) {
      chains.push("[voicesc]anullsink");
    }
    if ((sfx ?? true) && (n > 1 || plan.slides.some((s) => s.headline && s.anim === "pop"))) {
      // "Whoosh" a ogni cambio e un piccolo "pop" quando compare un titolo: generati qui, niente file da scaricare.
      const hits = [];
      for (let i = 1; i < n; i++) hits.push({ kind: "whoosh", t: Math.max(0, plan.slides[i].at - 0.12) });
      for (const [i, s] of plan.slides.entries()) if (s.headline && s.anim === "pop") hits.push({ kind: "pop", t: s.at + (i > 0 ? TDUR * 0.6 : 0.05) });
      const make = {
        whoosh: "anoisesrc=d=0.42:c=pink:r=44100:a=0.5,highpass=f=350,lowpass=f=5500,afade=t=in:d=0.22,afade=t=out:st=0.22:d=0.2,volume=0.55",
        pop: "sine=f=1250:d=0.07:sample_rate=44100,afade=t=out:st=0.01:d=0.06,volume=0.3",
      };
      const labels = [];
      for (const kind of ["whoosh", "pop"]) {
        const ts = hits.filter((h) => h.kind === kind);
        if (!ts.length) continue;
        args.push("-f", "lavfi", "-i", make[kind]);
        const src = input++;
        chains.push(`[${src}:a]${fmt},asplit=${ts.length}${ts.map((_, k) => `[${kind}s${k}]`).join("")}`);
        ts.forEach((h, k) => {
          const ms = Math.round(h.t * 1000);
          chains.push(`[${kind}s${k}]adelay=${ms}|${ms}[${kind}${k}]`);
          labels.push(`[${kind}${k}]`);
        });
      }
      chains.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0[sfx]`);
      mix.push("[sfx]");
    }
    chains.push(`${mix.join("")}amix=inputs=${mix.length}:duration=first:normalize=0,alimiter=limit=0.95[aout]`);

    args.push(
      "-filter_complex", chains.join(";"),
      "-map", `[${last}]`, "-map", "[aout]", "-t", total.toFixed(3),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", out,
    );
    const bin = await ffmpegPath();
    await run(bin, args, work);
    // Copertina: un fotogramma dall'inizio (dopo l'entrata del titolo).
    const poster = path.join(work, "poster.jpg");
    await run(bin, ["-y", "-v", "error", "-ss", String(Math.min(0.8, total / 2)), "-i", out, "-frames:v", "1", "-q:v", "3", poster], work);
    const said = plan.slides.map((s) => s.voice).filter(Boolean).join(" ");
    return await addVideoFile(id, {
      poster, title: title || "Video", description: description || said.slice(0, 1000), origin: "video", by,
      width: f.w, height: f.h, duration: Math.round(total * 10) / 10,
    });
  } catch (err) {
    fs.rmSync(out, { force: true });
    throw err;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Sfondo delle schermate di solo testo: il colore scelto, sfumato verso il nero. */
function backgroundSvg(f, color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f.w}" height="${f.h}"><defs><radialGradient id="g" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#000000"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
}

/** Movimento di camera sulle immagini (da un'immagine grande il doppio: il movimento resta fluido). */
function moveFilter(motion, f, frames) {
  if (motion === "none") return `loop=loop=${frames - 1}:size=1:start=0,setpts=N/${FPS}/TB`;
  const center = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
  const opts = {
    zoom_in: `z='1+0.10*on/${frames}':${center}`,
    zoom_out: `z='1.10-0.10*on/${frames}':${center}`,
    // Scatto veloce in avanti nei primi 6 fotogrammi, poi avvicinamento lento.
    punch: `z='if(lt(on,6),1+0.12*on/6,1.12+0.04*(on-6)/${frames})':${center}`,
    pan_left: `z='1.15':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`,
    pan_right: `z='1.15':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`,
  }[motion];
  return `scale=${f.w * 2}:${f.h * 2},zoompan=${opts}:d=${frames}:s=${f.w}x${f.h}:fps=${FPS}`;
}
