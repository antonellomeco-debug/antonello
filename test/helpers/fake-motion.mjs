// Finto motore dei video animati (al posto di HyperFrames, che richiede Chrome): controlla la pagina animata e
// scrive un MP4 muto delle misure e della durata chieste. Uso: node fake-motion.mjs <cartella> <uscita> <w> <h> <secondi>
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [dir, out, w, h, secs] = process.argv.slice(2);
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
if (!html.includes('window.__timelines["main"]=tl') || !fs.existsSync(path.join(dir, "gsap.min.js"))) {
  console.error("errore: pagina animata incompleta");
  process.exit(2);
}
for (const m of html.matchAll(/src="(m\d+\.[a-z0-9]+)"/g)) {
  if (!fs.existsSync(path.join(dir, m[1]))) {
    console.error(`errore: manca ${m[1]}`);
    process.exit(3);
  }
}
if (process.env.MOTION_PAGE_COPY) fs.writeFileSync(process.env.MOTION_PAGE_COPY, html); // per le prove
const ffmpeg = process.env.FFMPEG_PATH || (await import("ffmpeg-static")).default;
execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=0x0A1F44:s=${w}x${h}:r=30:d=${secs}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
