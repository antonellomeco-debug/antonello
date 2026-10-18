// Video "da grande studio" (motion graphics nello stile delle testate economiche): l'agente descrive le scene in JSON
// (titolo d'impatto, numero che scorre, barre, linea, percentuale, confronto, lista, frase, foto o video, ultim'ora,
// linea del tempo, chiusura) e qui diventano una pagina HTML animata con GSAP, nei colori e nei caratteri di Venturo.
// HyperFrames (pacchetto "hyperframes", Apache-2.0) la trasforma in MP4 con Chrome senza finestra; poi ffmpeg aggiunge
// voce narrante (tts.js: la voce dell'utente, Google o quella del server), musica abbassata sotto la voce ed effetti.
// Gli agenti non scrivono codice: solo dati e testi, così la grafica resta sempre "di marca".
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { ROOT } from "../paths.js";
import { MEDIA_DIR, newId, getMedia, mediaPath, addVideoFile, assertSpace } from "./media.js";
import { synthesize } from "./tts.js";
import { ffmpegPath, run, enqueue } from "./video.js";

const require = createRequire(import.meta.url);
const FPS = 30;
const MAX_SCENES = 20;
const MAX_TOTAL = 90;
const RENDER_TIMEOUT_MS = 12 * 60_000;
const WIPE = 0.26; // metà della tendina tra due scene (copre, cambia scena, scopre)

/** Misure e zone sicure (in alto e in basso Instagram mette nome, pulsanti e didascalia). */
export const MOTION_FORMATS = {
  story: { w: 1080, h: 1920, top: 270, bottom: 1230, capTop: 1285, capBottom: 1470, pad: 84, label: "reel/storia 9:16 1080×1920" },
  portrait: { w: 1080, h: 1350, top: 150, bottom: 960, capTop: 1000, capBottom: 1200, pad: 84, label: "verticale 4:5 1080×1350" },
  square: { w: 1080, h: 1080, top: 120, bottom: 770, capTop: 800, capBottom: 960, pad: 80, label: "quadrato 1080×1080" },
  landscape: { w: 1920, h: 1080, top: 120, bottom: 780, capTop: 820, capBottom: 980, pad: 220, label: "orizzontale 16:9 1920×1080" },
};

export const THEMES = {
  notte: { bg1: "#0A1F44", bg2: "#040D1F", ink: "#F7F9FC", muted: "#9FB0CC", accent: "#2BD67B", accent2: "#5B7CFF", card: "rgba(255,255,255,0.06)", line: "rgba(255,255,255,0.12)", wipe: "#2F5BFF", onAccent: "#04101F" },
  chiaro: { bg1: "#FFFFFF", bg2: "#E6ECF5", ink: "#0A1F44", muted: "#4A5568", accent: "#0B7A45", accent2: "#2F5BFF", card: "rgba(10,31,68,0.06)", line: "rgba(10,31,68,0.14)", wipe: "#0A1F44", onAccent: "#FFFFFF" },
  verde: { bg1: "#0B7A45", bg2: "#063D24", ink: "#F2FBF6", muted: "#B8F0D2", accent: "#FFD166", accent2: "#B8F0D2", card: "rgba(255,255,255,0.08)", line: "rgba(255,255,255,0.16)", wipe: "#0A1F44", onAccent: "#0A1F44" },
};

export const SCENE_TYPES = ["hook", "number", "bars", "line", "donut", "compare", "list", "statement", "media", "news", "timeline", "cta"];

// ---------- controllo dei dati delle scene (errori chiari per l'agente) ----------

const str = (v, max, where, field, { required = false } = {}) => {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  if (required && !t) throw new Error(`${where}: manca ${field}`);
  if (t.length > max) throw new Error(`${where}: ${field} troppo lungo (massimo ${max} caratteri)`);
  return t;
};
const numv = (v, where, field) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`${where}: ${field} dev'essere un numero`);
  return n;
};
const hex = (v) => (/^#[0-9a-f]{6}$/i.test(String(v ?? "")) ? String(v) : null);

function checkScene(s, i) {
  const where = `scena ${i + 1}`;
  if (!s || typeof s !== "object") throw new Error(`${where}: dev'essere un oggetto`);
  const type = String(s.type ?? "");
  if (!SCENE_TYPES.includes(type)) throw new Error(`${where}: type dev'essere uno di ${SCENE_TYPES.join(", ")}`);
  const base = {
    type,
    voice: str(s.voice, 400, where, "voice"),
    seconds: s.seconds == null ? null : Math.min(20, Math.max(1.5, Number(s.seconds) || 3)),
    kicker: str(s.kicker, 40, where, "kicker"),
    source: str(s.source, 90, where, "source"),
  };
  const items = (arr, max, field) => {
    if (!Array.isArray(arr) || !arr.length) throw new Error(`${where}: ${field} dev'essere un elenco non vuoto`);
    if (arr.length > max) throw new Error(`${where}: ${field} al massimo ${max} elementi`);
    return arr;
  };
  switch (type) {
    case "hook":
      return { ...base, text: str(s.text, 90, where, "text", { required: true }), highlight: (Array.isArray(s.highlight) ? s.highlight : []).map((h) => String(h).trim()).filter(Boolean).slice(0, 4) };
    case "number":
      return { ...base, value: numv(s.value, where, "value"), prefix: str(s.prefix, 6, where, "prefix"), suffix: str(s.suffix, 14, where, "suffix"), decimals: Math.min(2, Math.max(0, Math.round(Number(s.decimals) || 0))), label: str(s.label, 80, where, "label", { required: true }) };
    case "bars":
      return {
        ...base, title: str(s.title, 60, where, "title", { required: true }), unit: str(s.unit, 12, where, "unit"), highlight: str(s.highlight, 30, where, "highlight"),
        items: items(s.items, 7, "items").map((it, k) => ({ label: str(it?.label, 22, `${where}, barra ${k + 1}`, "label", { required: true }), value: numv(it?.value, `${where}, barra ${k + 1}`, "value") })),
      };
    case "line": {
      const pts = items(s.points, 12, "points").map((p, k) => ({ label: str(p?.label, 10, `${where}, punto ${k + 1}`, "label", { required: true }), value: numv(p?.value, `${where}, punto ${k + 1}`, "value") }));
      if (pts.length < 2) throw new Error(`${where}: servono almeno 2 punti`);
      return { ...base, title: str(s.title, 60, where, "title", { required: true }), unit: str(s.unit, 12, where, "unit"), points: pts };
    }
    case "donut": {
      const v = numv(s.value, where, "value");
      if (v < 0 || v > 100) throw new Error(`${where}: value è una percentuale da 0 a 100`);
      return { ...base, value: v, label: str(s.label, 80, where, "label", { required: true }) };
    }
    case "compare": {
      const side = (o, k) => ({ label: str(o?.label, 24, `${where}, ${k}`, "label", { required: true }), value: str(o?.value, 14, `${where}, ${k}`, "value", { required: true }), note: str(o?.note, 50, `${where}, ${k}`, "note") });
      return { ...base, title: str(s.title, 60, where, "title"), left: side(s.left, "left"), right: side(s.right, "right") };
    }
    case "list":
      return { ...base, title: str(s.title, 60, where, "title", { required: true }), ordered: Boolean(s.ordered), items: items(s.items, 5, "items").map((t, k) => str(t, 70, `${where}, voce ${k + 1}`, "testo", { required: true })) };
    case "statement":
      return { ...base, text: str(s.text, 140, where, "text", { required: true }), author: str(s.author, 50, where, "author") };
    case "media": {
      const m = getMedia(String(s.media ?? ""));
      if (m.kind !== "image" && m.kind !== "video") throw new Error(`${where}: media dev'essere una foto o un video dell'archivio`);
      return { ...base, media: m, text: str(s.text, 90, where, "text"), start: Math.max(0, Number(s.start) || 0) };
    }
    case "news":
      return { ...base, kicker: base.kicker || "ULTIM'ORA", text: str(s.text, 110, where, "text", { required: true }), ticker: str(s.ticker, 160, where, "ticker") };
    case "timeline":
      return { ...base, title: str(s.title, 60, where, "title", { required: true }), items: items(s.items, 5, "items").map((it, k) => ({ when: str(it?.when, 12, `${where}, tappa ${k + 1}`, "when", { required: true }), text: str(it?.text, 60, `${where}, tappa ${k + 1}`, "text", { required: true }) })) };
    case "cta":
      return { ...base, text: str(s.text, 80, where, "text", { required: true }), sub: str(s.sub, 70, where, "sub") };
    default:
      throw new Error(`${where}: tipo sconosciuto`);
  }
}

/** Durata senza voce, per tipo di scena (secondi). */
function defaultSeconds(s) {
  switch (s.type) {
    case "bars": return 2.6 + 0.35 * s.items.length;
    case "line": return 4.2;
    case "list": return 1.4 + 0.75 * s.items.length;
    case "timeline": return 1.6 + 0.8 * s.items.length;
    case "hook": return Math.min(4.5, 1.6 + s.text.split(" ").length * 0.22);
    case "statement": return Math.min(5, 2 + s.text.split(" ").length * 0.15);
    default: return 3.2;
  }
}

/** Nome del file di una foto o di un video nella cartella di lavoro. */
const mediaFile = (s, i) => (s.type === "media" ? `m${i}${path.extname(mediaPath(s.media)).toLowerCase() || (s.media.kind === "video" ? ".mp4" : ".jpg")}` : null);

// ---------- pagina animata ----------

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtNum = (n, d = 0) => n.toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d });
/** Numero compatto per le etichette dei grafici. */
const short = (n) => (Math.abs(n) >= 1e6 ? `${fmtNum(n / 1e6, 1)} mln` : fmtNum(n, Number.isInteger(n) ? 0 : 1));
const fit = (len, sizes) => {
  for (const [max, px] of sizes) if (len <= max) return px;
  return sizes.at(-1)[1];
};

const LOGO = (color, dot) => `<svg viewBox="0 0 200 200" aria-hidden="true"><path class="lg" d="M36 70 L92 152 L148 54" fill="none" stroke="${color}" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/><circle cx="168" cy="26" r="17" fill="${dot}"/></svg>`;

/** HTML di una scena e le sue animazioni (GSAP, tempi assoluti dall'inizio del video). */
function sceneMarkup(s, i, at, dur, f, t) {
  const id = `s${i}`;
  const q = (sel) => `#${id} ${sel}`;
  const a = [];
  const T = (x) => (at + x).toFixed(3);
  const kicker = s.kicker ? `<div class="kicker"><span class="kbar"></span>${esc(s.kicker)}</div>` : "";
  if (s.kicker) a.push(`tl.from("${q(".kicker")}",{opacity:0,x:-40,duration:.45,ease:"power3.out"},${T(0.12)});tl.from("${q(".kbar")}",{scaleX:0,transformOrigin:"left",duration:.5,ease:"power3.out"},${T(0.12)});`);
  const source = s.source ? `<div class="source">Fonte: ${esc(s.source.replace(/^fonte:\s*/i, ""))}</div>` : "";
  if (s.source) a.push(`tl.from("${q(".source")}",{opacity:0,duration:.5},${T(0.6)});`);
  let body = "";
  switch (s.type) {
    case "hook": {
      const words = s.text.split(" ");
      const hl = s.highlight.flatMap((h) => h.toLowerCase().split(" "));
      const size = fit(s.text.length, [[22, 132], [40, 112], [60, 96], [90, 82]]);
      body = `${kicker}<h1 class="hook" style="font-size:${size}px">${words.map((w) => {
        const on = hl.includes(w.toLowerCase().replace(/[.,!?;:]+$/, ""));
        return `<span class="w${on ? " hl" : ""}">${on ? `<span class="mk"></span>` : ""}<span class="tx">${esc(w)}</span></span>`;
      }).join(" ")}</h1>`;
      a.push(`tl.from("${q(".w")}",{opacity:0,y:70,rotateX:-50,filter:"blur(12px)",duration:.5,stagger:.07,ease:"power4.out"},${T(0.1)});`);
      a.push(`tl.from("${q(".mk")}",{scaleX:0,transformOrigin:"left",duration:.45,stagger:.1,ease:"power3.inOut"},${T(0.35 + words.length * 0.07)});`);
      break;
    }
    case "number": {
      const final = `${s.prefix}${fmtNum(s.value, s.decimals)}${s.suffix}`;
      const size = fit(final.length, [[5, 260], [8, 210], [11, 170], [14, 140], [20, 112]]);
      body = `${kicker}<div class="bignum" style="font-size:${size}px"><span class="glow"></span><span class="nv" data-v="${s.value}">${esc(s.prefix)}0${esc(s.suffix)}</span></div><div class="nlabel">${esc(s.label)}</div><div class="nline"></div>`;
      a.push(`(function(){const el=document.querySelector("${q(".nv")}");const o={v:0};tl.to(o,{v:${s.value},duration:1.6,ease:"power3.out",onUpdate:()=>{el.textContent=${JSON.stringify(s.prefix)}+o.v.toLocaleString("it-IT",{minimumFractionDigits:${s.decimals},maximumFractionDigits:${s.decimals}})+${JSON.stringify(s.suffix)}}},${T(0.2)});})();`);
      a.push(`tl.from("${q(".bignum")}",{scale:.6,opacity:0,filter:"blur(18px)",duration:.6,ease:"back.out(1.6)"},${T(0.15)});`);
      a.push(`tl.from("${q(".glow")}",{scale:0,opacity:0,duration:1.2,ease:"power2.out"},${T(0.2)});`);
      a.push(`tl.from("${q(".nlabel")}",{opacity:0,y:30,duration:.5,ease:"power3.out"},${T(0.7)});tl.from("${q(".nline")}",{scaleX:0,duration:.7,ease:"power3.inOut"},${T(0.8)});`);
      break;
    }
    case "bars": {
      const max = Math.max(...s.items.map((x) => Math.abs(x.value)), 1e-9);
      const full = f.w - 2 * f.pad - 300;
      body = `${kicker}<h2 class="title">${esc(s.title)}</h2><div class="bars">${s.items.map((it) => {
        const on = s.highlight && it.label.toLowerCase() === s.highlight.toLowerCase();
        return `<div class="brow${on ? " on" : ""}"><div class="blab">${esc(it.label)}</div><div class="btrack"><div class="bar" style="width:${Math.max(8, (Math.abs(it.value) / max) * full).toFixed(1)}px"></div><div class="bval" data-v="${it.value}">0</div></div></div>`;
      }).join("")}</div>${s.unit ? `<div class="unit">${esc(s.unit)}</div>` : ""}`;
      a.push(`tl.from("${q(".title")}",{opacity:0,y:40,duration:.5,ease:"power3.out"},${T(0.15)});`);
      a.push(`tl.from("${q(".brow")}",{opacity:0,x:-30,duration:.35,stagger:.12,ease:"power2.out"},${T(0.35)});`);
      a.push(`tl.from("${q(".bar")}",{scaleX:0,transformOrigin:"left",duration:.9,stagger:.12,ease:"expo.out"},${T(0.45)});`);
      a.push(`document.querySelectorAll("${q(".bval")}").forEach((el,k)=>{const v=+el.dataset.v;const o={v:0};tl.to(o,{v,duration:.9,ease:"expo.out",onUpdate:()=>{el.textContent=(Math.abs(v)>=1e6?(o.v/1e6).toLocaleString("it-IT",{maximumFractionDigits:1})+" mln":o.v.toLocaleString("it-IT",{maximumFractionDigits:Number.isInteger(v)?0:1}))}},${T(0.45)}+k*.12);});`);
      a.push(`tl.fromTo("${q(".brow.on .bar")}",{boxShadow:"0 0 0 rgba(0,0,0,0)"},{boxShadow:"0 0 46px ${t.accent}",duration:.6,yoyo:true,repeat:1},${T(1.4)});`);
      break;
    }
    case "line": {
      const W = f.w - 2 * f.pad;
      const H = Math.round((f.bottom - f.top) * 0.5);
      const vals = s.points.map((p) => p.value);
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const span = hi - lo || Math.abs(hi) || 1;
      const x = (k) => 20 + (k / (s.points.length - 1)) * (W - 140);
      const y = (v) => 30 + (1 - (v - lo) / span) * (H - 80);
      const d = s.points.map((p, k) => `${k ? "L" : "M"}${x(k).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
      const area = `${d} L${x(s.points.length - 1).toFixed(1)} ${H} L${x(0).toFixed(1)} ${H} Z`;
      const lastP = s.points.at(-1);
      const grid = [0.25, 0.5, 0.75].map((g) => `<line x1="0" x2="${W}" y1="${(30 + g * (H - 80)).toFixed(1)}" y2="${(30 + g * (H - 80)).toFixed(1)}" stroke="${t.line}" stroke-width="2" stroke-dasharray="6 10"/>`).join("");
      const labels = s.points.map((p, k) => (k === 0 || k === s.points.length - 1 || s.points.length <= 6 ? `<text x="${x(k).toFixed(1)}" y="${H + 46}" text-anchor="middle" class="ax">${esc(p.label)}</text>` : "")).join("");
      body = `${kicker}<h2 class="title">${esc(s.title)}</h2><svg class="chart" width="${W}" height="${H + 60}" viewBox="0 0 ${W} ${H + 60}"><defs><linearGradient id="ga${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.accent}" stop-opacity=".45"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0"/></linearGradient></defs>${grid}<path class="area" d="${area}" fill="url(#ga${i})"/><path class="ln" d="${d}" fill="none" stroke="${t.accent}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><circle class="dot" cx="${x(s.points.length - 1).toFixed(1)}" cy="${y(lastP.value).toFixed(1)}" r="16" fill="${t.accent}"/><circle class="ring" cx="${x(s.points.length - 1).toFixed(1)}" cy="${y(lastP.value).toFixed(1)}" r="16" fill="none" stroke="${t.accent}" stroke-width="4"/>${labels}</svg><div class="lval">${esc(short(lastP.value))}${s.unit ? ` <small>${esc(s.unit)}</small>` : ""}</div>`;
      a.push(`tl.from("${q(".title")}",{opacity:0,y:40,duration:.5,ease:"power3.out"},${T(0.15)});`);
      a.push(`(function(){const p=document.querySelector("${q(".ln")}");const L=p.getTotalLength();gsap.set(p,{strokeDasharray:L,strokeDashoffset:L});tl.to(p,{strokeDashoffset:0,duration:1.8,ease:"power2.inOut"},${T(0.4)});})();`);
      a.push(`tl.from("${q(".area")}",{opacity:0,duration:1},${T(1.2)});tl.from("${q(".dot")}",{scale:0,transformOrigin:"center",duration:.4,ease:"back.out(3)"},${T(2.1)});`);
      a.push(`tl.fromTo("${q(".ring")}",{scale:1,opacity:1,transformOrigin:"center"},{scale:3,opacity:0,duration:1.1,repeat:2,ease:"power1.out"},${T(2.2)});tl.from("${q(".lval")}",{opacity:0,y:30,duration:.5},${T(2.1)});`);
      break;
    }
    case "donut": {
      const R = 210;
      const C = 2 * Math.PI * R;
      body = `${kicker}<div class="donut"><svg width="520" height="520" viewBox="0 0 520 520"><circle cx="260" cy="260" r="${R}" fill="none" stroke="${t.line}" stroke-width="44"/><circle class="arc" cx="260" cy="260" r="${R}" fill="none" stroke="${t.accent}" stroke-width="44" stroke-linecap="round" transform="rotate(-90 260 260)" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}"/></svg><div class="pct"><span class="pv">0</span><small>%</small></div></div><div class="nlabel">${esc(s.label)}</div>`;
      a.push(`tl.from("${q(".donut")}",{scale:.7,opacity:0,duration:.6,ease:"back.out(1.7)"},${T(0.1)});tl.to("${q(".arc")}",{strokeDashoffset:${(C * (1 - s.value / 100)).toFixed(1)},duration:1.6,ease:"power3.inOut"},${T(0.35)});`);
      a.push(`(function(){const el=document.querySelector("${q(".pv")}");const o={v:0};tl.to(o,{v:${s.value},duration:1.6,ease:"power3.inOut",onUpdate:()=>{el.textContent=Math.round(o.v)}},${T(0.35)});})();tl.from("${q(".nlabel")}",{opacity:0,y:30,duration:.5},${T(1)});`);
      break;
    }
    case "compare": {
      const card = (o, cls) => `<div class="cmp ${cls}"><div class="clab">${esc(o.label)}</div><div class="cval">${esc(o.value)}</div>${o.note ? `<div class="cnote">${esc(o.note)}</div>` : ""}</div>`;
      body = `${kicker}${s.title ? `<h2 class="title">${esc(s.title)}</h2>` : ""}<div class="cmps">${card(s.left, "l")}<div class="vs">VS</div>${card(s.right, "r")}</div>`;
      if (s.title) a.push(`tl.from("${q(".title")}",{opacity:0,y:40,duration:.5,ease:"power3.out"},${T(0.15)});`);
      a.push(`tl.from("${q(".cmp.l")}",{x:-260,opacity:0,duration:.7,ease:"expo.out"},${T(0.3)});tl.from("${q(".cmp.r")}",{x:260,opacity:0,duration:.7,ease:"expo.out"},${T(0.45)});`);
      a.push(`tl.from("${q(".vs")}",{scale:0,rotate:-90,duration:.5,ease:"back.out(2.5)"},${T(0.85)});tl.from("${q(".cval")}",{y:30,opacity:0,duration:.45,stagger:.15},${T(0.9)});`);
      break;
    }
    case "list": {
      body = `${kicker}<h2 class="title">${esc(s.title)}</h2><div class="list">${s.items.map((it, k) => `<div class="li"><div class="badge">${s.ordered ? k + 1 : "✓"}</div><div class="lt">${esc(it)}</div></div>`).join("")}</div>`;
      a.push(`tl.from("${q(".title")}",{opacity:0,y:40,duration:.5,ease:"power3.out"},${T(0.15)});`);
      a.push(`tl.from("${q(".li")}",{opacity:0,x:80,duration:.5,stagger:.55,ease:"power3.out"},${T(0.5)});tl.from("${q(".badge")}",{scale:0,rotate:-120,duration:.45,stagger:.55,ease:"back.out(2.6)"},${T(0.55)});`);
      break;
    }
    case "statement": {
      const size = fit(s.text.length, [[40, 96], [70, 82], [100, 70], [140, 60]]);
      body = `${kicker}<div class="quote">“</div><p class="stmt" style="font-size:${size}px">${s.text.split(" ").map((w) => `<span class="sw">${esc(w)}</span>`).join(" ")}</p><div class="sline"></div>${s.author ? `<div class="author">${esc(s.author)}</div>` : ""}`;
      a.push(`tl.from("${q(".quote")}",{scale:0,opacity:0,rotate:-30,duration:.6,ease:"back.out(2)"},${T(0.1)});tl.from("${q(".sw")}",{opacity:.08,duration:.18,stagger:.05,ease:"none"},${T(0.3)});`);
      a.push(`tl.from("${q(".sline")}",{scaleX:0,transformOrigin:"left",duration:.8,ease:"power3.inOut"},${T(0.6)});${s.author ? `tl.from("${q(".author")}",{opacity:0,y:20,duration:.4},${T(1)});` : ""}`);
      break;
    }
    case "media": {
      const file = s.file;
      const tag = s.media.kind === "video"
        ? `<video class="mbg clip" id="v${i}" src="${file}" muted playsinline data-start="${at.toFixed(3)}" data-duration="${dur.toFixed(3)}" data-media-start="${s.start}" data-track-index="${10 + i}"></video>`
        : `<img class="mbg" src="${file}" alt=""/>`;
      body = `<div class="mwrap">${tag}<div class="mshade"></div></div><div class="lower">${kicker}${s.text ? `<div class="ltext">${esc(s.text)}</div>` : ""}</div>`;
      a.push(`tl.fromTo("${q(".mbg")}",{scale:1.18},{scale:1.02,duration:${dur.toFixed(3)},ease:"none"},${T(0)});tl.from("${q(".mwrap")}",{opacity:0,duration:.4},${T(0)});`);
      if (s.text) a.push(`tl.from("${q(".ltext")}",{y:60,opacity:0,clipPath:"inset(0 0 100% 0)",duration:.6,ease:"power3.out"},${T(0.35)});`);
      break;
    }
    case "news": {
      body = `<div class="nbadge"><span class="live"></span>${esc(s.kicker)}</div><h1 class="ntext">${esc(s.text)}</h1>${s.ticker ? `<div class="ticker"><div class="tk">${esc(s.ticker)} · ${esc(s.ticker)} · </div></div>` : ""}`;
      a.push(`tl.from("${q(".nbadge")}",{x:-300,duration:.5,ease:"expo.out"},${T(0.1)});tl.fromTo("${q(".live")}",{opacity:1},{opacity:.2,duration:.4,repeat:${Math.max(1, Math.floor(dur / 0.8))},yoyo:true},${T(0.3)});`);
      a.push(`tl.from("${q(".ntext")}",{opacity:0,y:50,clipPath:"inset(0 0 100% 0)",duration:.6,ease:"power3.out"},${T(0.3)});`);
      if (s.ticker) a.push(`tl.fromTo("${q(".tk")}",{x:0},{x:-${Math.round(s.ticker.length * 16)},duration:${dur.toFixed(3)},ease:"none"},${T(0)});`);
      break;
    }
    case "timeline": {
      body = `${kicker}<h2 class="title">${esc(s.title)}</h2><div class="tline"><div class="tbar"></div>${s.items.map((it) => `<div class="ti"><div class="tdot"></div><div class="tw">${esc(it.when)}</div><div class="tt">${esc(it.text)}</div></div>`).join("")}</div>`;
      a.push(`tl.from("${q(".title")}",{opacity:0,y:40,duration:.5,ease:"power3.out"},${T(0.15)});tl.from("${q(".tbar")}",{scaleY:0,transformOrigin:"top",duration:${(0.6 + 0.6 * s.items.length).toFixed(2)},ease:"none"},${T(0.4)});`);
      a.push(`tl.from("${q(".ti")}",{opacity:0,x:60,duration:.45,stagger:.6,ease:"power3.out"},${T(0.5)});tl.from("${q(".tdot")}",{scale:0,duration:.35,stagger:.6,ease:"back.out(3)"},${T(0.5)});`);
      break;
    }
    case "cta": {
      body = `<div class="ctalogo">${LOGO(t.ink, t.accent)}</div><h1 class="ctat">${esc(s.text)}</h1>${s.sub ? `<div class="ctas">${esc(s.sub)}</div>` : ""}<div class="ctabtn">venturo</div>`;
      a.push(`(function(){const p=document.querySelector("${q(".lg")}");const L=p.getTotalLength();gsap.set(p,{strokeDasharray:L,strokeDashoffset:L});tl.to(p,{strokeDashoffset:0,duration:.9,ease:"power3.inOut"},${T(0.1)});})();`);
      a.push(`tl.from("${q(".ctalogo circle")}",{scale:0,transformOrigin:"center",duration:.4,ease:"back.out(3)"},${T(0.9)});tl.from("${q(".ctat")}",{opacity:0,y:50,duration:.55,ease:"power3.out"},${T(0.5)});`);
      a.push(`${s.sub ? `tl.from("${q(".ctas")}",{opacity:0,y:30,duration:.45},${T(0.8)});` : ""}tl.from("${q(".ctabtn")}",{scale:.6,opacity:0,duration:.5,ease:"back.out(2)"},${T(1)});tl.to("${q(".ctabtn")}",{scale:1.06,duration:.45,yoyo:true,repeat:${Math.max(1, Math.floor((dur - 1.6) / 0.45))},ease:"sine.inOut"},${T(1.6)});`);
      break;
    }
  }
  // Uscita: piccola dissolvenza alla fine (sotto la tendina).
  a.push(`tl.to("#${id} .inner",{opacity:0,y:-30,duration:.22,ease:"power2.in"},${T(Math.max(0.3, dur - 0.24))});`);
  const full = s.type === "media";
  return {
    html: `<div id="${id}" class="clip scene t-${s.type}" data-start="${at.toFixed(3)}" data-duration="${dur.toFixed(3)}" data-track-index="1">${full ? `<div class="inner full">${body}</div>` : `<div class="inner">${body}</div>`}${source}</div>`,
    js: a.join("\n"),
  };
}

/** Sottotitoli a gruppi di 2-3 parole, la parola detta in colore. */
function captionsMarkup(scenes, t) {
  const html = [];
  const js = [];
  let c = 0;
  for (const s of scenes) {
    if (!s.words?.length) continue;
    const groups = [];
    let cur = [];
    for (const w of s.words) {
      cur.push(w);
      if (cur.length >= 3 || /[.,!?;:]$/.test(w.text)) {
        groups.push(cur);
        cur = [];
      }
    }
    if (cur.length) groups.push(cur);
    for (const g of groups) {
      const start = s.voiceAt + g[0].start;
      const end = s.voiceAt + g.at(-1).end + 0.08;
      const id = `c${c++}`;
      html.push(`<div class="cap" id="${id}">${g.map((w, k) => `<span class="cw" id="${id}w${k}">${esc(w.text)}</span>`).join(" ")}</div>`);
      js.push(`tl.set("#${id}",{autoAlpha:1},${start.toFixed(3)});tl.from("#${id}",{y:24,scale:.92,duration:.16,ease:"back.out(2)"},${start.toFixed(3)});tl.set("#${id}",{autoAlpha:0},${end.toFixed(3)});`);
      g.forEach((w, k) => js.push(`tl.set("#${id}w${k}",{color:"${t.accent}"},${(s.voiceAt + w.start).toFixed(3)});tl.set("#${id}w${k}",{color:"${t.ink}"},${(s.voiceAt + w.end).toFixed(3)});`));
    }
  }
  return { html: html.join(""), js: js.join("\n") };
}

function pageHtml({ f, t, scenes, total, transition, captions }) {
  const parts = scenes.map((s, i) => sceneMarkup(s, i, s.at, s.dur, f, t));
  const cap = captions ? captionsMarkup(scenes, t) : { html: "", js: "" };
  const u = Math.min(f.w, f.h) / 1080;
  const wipes = [];
  scenes.slice(1).forEach((s, k) => {
    const kind = transition === "fade" ? null : transition === "wipe" ? "x" : ["x", "y", "d"][k % 3];
    if (!kind) return;
    const from = kind === "x" ? { xPercent: 101 } : kind === "y" ? { yPercent: 101 } : { xPercent: 101, yPercent: 101 };
    const to = kind === "x" ? { xPercent: -101 } : kind === "y" ? { yPercent: -101 } : { xPercent: -101, yPercent: -101 };
    wipes.push(`tl.fromTo("#wipe",${JSON.stringify(from)},{xPercent:0,yPercent:0,duration:${WIPE},ease:"power3.in"},${(s.at - WIPE).toFixed(3)});tl.to("#wipe",{...${JSON.stringify(to)},duration:${WIPE},ease:"power3.out"},${s.at.toFixed(3)});tl.set("#wipe",{xPercent:101,yPercent:0},${(s.at + WIPE + 0.01).toFixed(3)});`);
  });
  const contentH = f.bottom - f.top;
  const css = `
@font-face{font-family:"Sora";src:url(Sora-latin.woff2) format("woff2");font-weight:100 800;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Sora";src:url(Sora-latin-ext.woff2) format("woff2");font-weight:100 800;unicode-range:U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Inter";src:url(Inter.ttf);font-weight:100 900}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${f.w}px;height:${f.h}px;overflow:hidden;background:${t.bg2}}
#root{position:relative;width:100%;height:100%;overflow:hidden;font-family:"Inter",Arial,sans-serif;color:${t.ink};background:radial-gradient(120% 80% at 50% 25%,${t.bg1} 0%,${t.bg2} 75%)}
.grid{position:absolute;inset:-10%;background-image:linear-gradient(${t.line} 1px,transparent 1px),linear-gradient(90deg,${t.line} 1px,transparent 1px);background-size:${Math.round(90 * u)}px ${Math.round(90 * u)}px;opacity:.35;-webkit-mask-image:radial-gradient(70% 60% at 50% 45%,#000 0%,transparent 75%);mask-image:radial-gradient(70% 60% at 50% 45%,#000 0%,transparent 75%)}
.blob{position:absolute;border-radius:50%;filter:blur(${Math.round(120 * u)}px);opacity:.55}
.b1{width:${Math.round(700 * u)}px;height:${Math.round(700 * u)}px;background:${t.accent2};left:-15%;top:8%}
.b2{width:${Math.round(600 * u)}px;height:${Math.round(600 * u)}px;background:${t.accent};right:-20%;bottom:10%;opacity:.28}
.vig{position:absolute;inset:0;background:radial-gradient(90% 70% at 50% 50%,transparent 55%,rgba(0,0,0,.45) 100%)}
.brand{position:absolute;left:${f.pad}px;top:${Math.round(f.top - 130 * u)}px;display:flex;align-items:center;gap:${Math.round(14 * u)}px;font-family:"Sora";font-weight:800;font-size:${Math.round(34 * u)}px;letter-spacing:-.5px;opacity:.92}
.brand svg{width:${Math.round(48 * u)}px;height:${Math.round(48 * u)}px}
#prog{position:absolute;left:0;top:0;height:${Math.max(8, Math.round(10 * u))}px;width:100%;background:${t.accent};transform-origin:left;transform:scaleX(0)}
.scene{position:absolute;left:0;top:0;width:100%;height:100%}
.inner{position:absolute;left:${f.pad}px;right:${f.pad}px;top:${f.top}px;height:${contentH}px;display:flex;flex-direction:column;justify-content:center;gap:${Math.round(34 * u)}px}
.inner.full{left:0;right:0;top:0;height:100%}
.kicker{display:flex;align-items:center;gap:${Math.round(16 * u)}px;font-family:"Sora";font-weight:700;font-size:${Math.round(32 * u)}px;letter-spacing:${Math.round(5 * u)}px;text-transform:uppercase;color:${t.accent}}
.kbar{display:inline-block;width:${Math.round(56 * u)}px;height:${Math.round(8 * u)}px;border-radius:9px;background:${t.accent}}
.source{position:absolute;left:${f.pad}px;right:${f.pad}px;top:${f.bottom + Math.round(6 * u)}px;font-size:${Math.round(24 * u)}px;color:${t.muted};opacity:.85}
.hook{font-family:"Sora";font-weight:800;line-height:1.06;letter-spacing:-2px;perspective:900px}
.hook .w{display:inline-block;position:relative;transform-origin:50% 100%}
.hook .w .tx{position:relative}
.hook .hl .tx{color:${t.onAccent}}
.hook .mk{position:absolute;left:-.08em;right:-.08em;top:.12em;bottom:.02em;background:${t.accent};border-radius:.12em}
.bignum{position:relative;font-family:"Sora";font-weight:800;letter-spacing:-4px;line-height:1;color:${t.ink};white-space:nowrap}
.glow{position:absolute;left:50%;top:50%;width:${Math.round(620 * u)}px;height:${Math.round(620 * u)}px;margin:-${Math.round(310 * u)}px;border-radius:50%;background:radial-gradient(circle,${t.accent}55 0%,transparent 65%);z-index:-1}
.nlabel{font-size:${Math.round(52 * u)}px;line-height:1.25;color:${t.ink};font-weight:600;max-width:95%}
.nline{width:${Math.round(220 * u)}px;height:${Math.round(10 * u)}px;border-radius:9px;background:${t.accent};transform-origin:left}
.title{font-family:"Sora";font-weight:700;font-size:${Math.round(62 * u)}px;line-height:1.12;letter-spacing:-1px}
.bars{display:flex;flex-direction:column;gap:${Math.round(22 * u)}px}
.brow{display:flex;align-items:center;gap:${Math.round(20 * u)}px}
.blab{width:${Math.round(250 * u)}px;flex:none;font-size:${Math.round(36 * u)}px;color:${t.muted};font-weight:600}
.brow.on .blab{color:${t.ink}}
.btrack{display:flex;align-items:center;gap:${Math.round(16 * u)}px;flex:1}
.bar{height:${Math.round(64 * u)}px;border-radius:${Math.round(12 * u)}px;background:linear-gradient(90deg,${t.accent2},${t.accent2}cc);opacity:.75}
.brow.on .bar{background:linear-gradient(90deg,${t.accent},${t.accent}dd);opacity:1}
.bval{font-family:"Sora";font-weight:700;font-size:${Math.round(38 * u)}px;white-space:nowrap}
.unit{font-size:${Math.round(28 * u)}px;color:${t.muted}}
.chart{overflow:visible}
.ax{font:600 ${Math.round(30 * u)}px "Inter";fill:${t.muted}}
.lval{font-family:"Sora";font-weight:800;font-size:${Math.round(96 * u)}px;color:${t.accent};letter-spacing:-2px}
.lval small{font-size:.4em;color:${t.muted};letter-spacing:0}
.donut{position:relative;width:${Math.round(520 * u)}px;height:${Math.round(520 * u)}px;align-self:center}
.donut svg{width:100%;height:100%}
.pct{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:"Sora";font-weight:800;font-size:${Math.round(150 * u)}px;letter-spacing:-4px}
.pct small{font-size:.45em;margin-left:.05em}
.t-donut .nlabel,.t-number .nlabel{text-align:center;align-self:center}
.t-number .inner{align-items:center;text-align:center}
.cmps{display:flex;align-items:stretch;gap:${Math.round(24 * u)}px;position:relative}
.cmp{flex:1;min-width:0;background:${t.card};border:2px solid ${t.line};border-radius:${Math.round(28 * u)}px;padding:${Math.round(40 * u)}px ${Math.round(30 * u)}px;display:flex;flex-direction:column;gap:${Math.round(14 * u)}px}
.cmp.r{border-color:${t.accent}}
.clab{font-size:${Math.round(32 * u)}px;color:${t.muted};font-weight:600}
.cval{font-family:"Sora";font-weight:800;font-size:${Math.round(78 * u)}px;letter-spacing:-2px;line-height:1.05}
.cmp.r .cval{color:${t.accent}}
.cnote{font-size:${Math.round(28 * u)}px;color:${t.muted};line-height:1.3}
.vs{position:absolute;left:50%;top:50%;width:${Math.round(96 * u)}px;height:${Math.round(96 * u)}px;margin:-${Math.round(48 * u)}px;border-radius:50%;background:${t.ink};color:${t.bg2};display:flex;align-items:center;justify-content:center;font-family:"Sora";font-weight:800;font-size:${Math.round(32 * u)}px}
.list{display:flex;flex-direction:column;gap:${Math.round(26 * u)}px}
.li{display:flex;align-items:center;gap:${Math.round(26 * u)}px;background:${t.card};border-radius:${Math.round(22 * u)}px;padding:${Math.round(24 * u)}px ${Math.round(28 * u)}px}
.badge{flex:none;width:${Math.round(68 * u)}px;height:${Math.round(68 * u)}px;border-radius:50%;background:${t.accent};color:${t.onAccent};display:flex;align-items:center;justify-content:center;font-family:"Sora";font-weight:800;font-size:${Math.round(34 * u)}px}
.lt{font-size:${Math.round(40 * u)}px;line-height:1.25;font-weight:600}
.quote{font-family:"Sora";font-weight:800;font-size:${Math.round(220 * u)}px;line-height:.6;height:${Math.round(110 * u)}px;color:${t.accent}}
.stmt{font-family:"Sora";font-weight:700;line-height:1.18;letter-spacing:-1px}
.sline{width:${Math.round(260 * u)}px;height:${Math.round(10 * u)}px;border-radius:9px;background:${t.accent}}
.author{font-size:${Math.round(34 * u)}px;color:${t.muted};font-weight:600}
.mwrap{position:absolute;inset:0;overflow:hidden}
.mbg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.mshade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(4,13,31,.25) 0%,rgba(4,13,31,0) 30%,rgba(4,13,31,.35) 55%,rgba(4,13,31,.92) 100%)}
.lower{position:absolute;left:${f.pad}px;right:${f.pad}px;bottom:${f.h - f.bottom}px;display:flex;flex-direction:column;gap:${Math.round(20 * u)}px}
.ltext{font-family:"Sora";font-weight:800;font-size:${Math.round(76 * u)}px;line-height:1.08;letter-spacing:-1.5px;color:#F7F9FC;text-shadow:0 4px 30px rgba(0,0,0,.5)}
.nbadge{align-self:flex-start;display:flex;align-items:center;gap:${Math.round(14 * u)}px;background:#E5484D;color:#fff;font-family:"Sora";font-weight:800;font-size:${Math.round(34 * u)}px;letter-spacing:${Math.round(3 * u)}px;padding:${Math.round(12 * u)}px ${Math.round(24 * u)}px;border-radius:${Math.round(10 * u)}px}
.live{width:${Math.round(18 * u)}px;height:${Math.round(18 * u)}px;border-radius:50%;background:#fff}
.ntext{font-family:"Sora";font-weight:800;font-size:${Math.round(84 * u)}px;line-height:1.08;letter-spacing:-1.5px}
.ticker{overflow:hidden;white-space:nowrap;border-top:2px solid ${t.line};border-bottom:2px solid ${t.line};padding:${Math.round(14 * u)}px 0;font-size:${Math.round(32 * u)}px;color:${t.muted};font-weight:600}
.tk{display:inline-block}
.tline{position:relative;display:flex;flex-direction:column;gap:${Math.round(34 * u)}px;padding-left:${Math.round(64 * u)}px}
.tbar{position:absolute;left:${Math.round(18 * u)}px;top:${Math.round(14 * u)}px;bottom:${Math.round(14 * u)}px;width:${Math.round(6 * u)}px;border-radius:6px;background:${t.line}}
.ti{position:relative}
.tdot{position:absolute;left:-${Math.round(60 * u)}px;top:${Math.round(8 * u)}px;width:${Math.round(34 * u)}px;height:${Math.round(34 * u)}px;border-radius:50%;background:${t.accent};box-shadow:0 0 0 ${Math.round(8 * u)}px ${t.accent}33}
.tw{font-family:"Sora";font-weight:800;font-size:${Math.round(40 * u)}px;color:${t.accent}}
.tt{font-size:${Math.round(38 * u)}px;line-height:1.25;font-weight:600}
.t-cta .inner{align-items:center;text-align:center}
.ctalogo{width:${Math.round(220 * u)}px;height:${Math.round(220 * u)}px}
.ctalogo svg{width:100%;height:100%}
.ctat{font-family:"Sora";font-weight:800;font-size:${Math.round(78 * u)}px;line-height:1.1;letter-spacing:-1.5px}
.ctas{font-size:${Math.round(40 * u)}px;color:${t.muted};font-weight:600}
.ctabtn{background:${t.accent};color:${t.onAccent};font-family:"Sora";font-weight:800;font-size:${Math.round(40 * u)}px;padding:${Math.round(18 * u)}px ${Math.round(46 * u)}px;border-radius:999px}
#caps{position:absolute;left:${f.pad}px;right:${f.pad}px;top:${f.capTop}px;height:${f.capBottom - f.capTop}px}
.cap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:0 .28em;text-align:center;visibility:hidden;font-family:"Sora";font-weight:800;font-size:${Math.round(66 * u)}px;line-height:1.1;letter-spacing:-.5px;color:${t.ink};text-shadow:0 ${Math.round(4 * u)}px ${Math.round(24 * u)}px rgba(0,0,0,.55);-webkit-text-stroke:${Math.max(1, Math.round(2 * u))}px rgba(0,0,0,.25)}
.cw{display:inline-block}
#wipe{position:absolute;inset:0;background:${t.wipe};transform:translateX(101%);z-index:50;display:flex;align-items:center;justify-content:center}
#wipe svg{width:${Math.round(180 * u)}px;height:${Math.round(180 * u)}px}
#caps{z-index:40}
`;
  const js = `
const tl=gsap.timeline({paused:true});
tl.to("#prog",{scaleX:1,duration:${total.toFixed(3)},ease:"none"},0);
tl.fromTo(".b1",{x:0,y:0},{x:${Math.round(220 * u)},y:${Math.round(160 * u)},duration:${total.toFixed(3)},ease:"sine.inOut"},0);
tl.fromTo(".b2",{x:0,y:0},{x:-${Math.round(200 * u)},y:-${Math.round(240 * u)},duration:${total.toFixed(3)},ease:"sine.inOut"},0);
tl.fromTo(".grid",{y:0},{y:${Math.round(90 * u)},duration:${total.toFixed(3)},ease:"none"},0);
tl.from(".brand",{opacity:0,y:-20,duration:.5},0.05);
${parts.map((p) => p.js).join("\n")}
${wipes.join("\n")}
${cap.js}
window.__timelines=window.__timelines||{};window.__timelines["main"]=tl;tl.seek(0);`;
  return `<!doctype html><html lang="it"><head><meta charset="UTF-8"/><meta name="viewport" content="width=${f.w}, height=${f.h}"/><script src="gsap.min.js"></script><style>${css}</style></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="${total.toFixed(3)}" data-width="${f.w}" data-height="${f.h}" data-fps="${FPS}"><div class="grid"></div><div class="blob b1"></div><div class="blob b2"></div><div class="vig"></div><div class="brand">${LOGO(t.ink, t.accent)}<span>venturo</span></div>${parts.map((p) => p.html).join("")}<div id="caps">${cap.html}</div><div id="wipe">${LOGO(t.onAccent === "#FFFFFF" ? "#FFFFFF" : "#F7F9FC", t.accent)}</div><div id="prog"></div></div><script>${js}</script></body></html>`;
}

// ---------- rendering ----------

function hyperframesBin() {
  try {
    const dir = path.dirname(require.resolve("hyperframes/package.json"));
    return path.join(dir, "bin", "hyperframes.mjs");
  } catch {
    return null;
  }
}

/** Il motore dei video animati è installato? (pacchetto facoltativo "hyperframes"). */
export function motionAvailable() {
  return Boolean(process.env.MOTION_RENDERER || hyperframesBin());
}

function render(dir, out, f, total) {
  const custom = process.env.MOTION_RENDERER; // nei test: un finto motore che scrive un MP4 qualsiasi
  const bin = custom || hyperframesBin();
  if (!bin) throw new Error("Il motore dei video animati non è installato: premi 🔄 Aggiorna (o chiedi a chi gestisce il server).");
  const workers = String(Math.max(1, Math.min(4, Number(process.env.MOTION_WORKERS) || 2)));
  const args = custom
    ? [bin, dir, out, String(f.w), String(f.h), total.toFixed(3)]
    : [bin, "render", dir, "-o", out, "--fps", String(FPS), "--quality", "standard", "--workers", workers, "--quiet"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DO_NOT_TRACK: "1", HYPERFRAMES_TELEMETRY_DISABLED: "1", NO_UPDATE_NOTIFIER: "1", CI: "1" },
    });
    let log = "";
    const keep = (d) => (log = (log + d).slice(-6000));
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), RENDER_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(out)) resolve();
      else {
        const lines = log.split("\n").map((l) => l.trim()).filter((l) => l && /error|fail|errore|lint/i.test(l)).slice(-4).join(" · ");
        reject(new Error(signal ? "video animato interrotto: ci metteva troppo (meno scene o più corte)" : `video animato non riuscito: ${lines || log.trim().split("\n").slice(-3).join(" ")}`));
      }
    });
  });
}

/**
 * Crea un video animato e lo mette nell'archivio. Input: { format, theme, accent, transition ("mix"|"wipe"|"fade"),
 * captions, music, music_volume, voice_speed, title, description, scenes: [...] }.
 */
export function createMotionVideo(input = {}) {
  return enqueue(() => motion(input));
}

async function motion({ format = "story", theme = "notte", accent, transition = "mix", captions, music, music_volume, voice_speed, title = "", description = "", scenes, by = null } = {}) {
  const f = MOTION_FORMATS[format];
  if (!f) throw new Error(`format: ${Object.keys(MOTION_FORMATS).join(", ")}`);
  const t = { ...(THEMES[theme] ?? THEMES.notte) };
  if (hex(accent)) t.accent = hex(accent);
  if (!Array.isArray(scenes) || !scenes.length) throw new Error("scenes: serve almeno una scena");
  if (scenes.length > MAX_SCENES) throw new Error(`scenes: al massimo ${MAX_SCENES} scene`);
  const list = scenes.map(checkScene);
  const song = music ? getMedia(String(music)) : null;
  if (song && song.kind !== "audio") throw new Error(`music: ${song.id} non è una musica (carica un MP3 o M4A nell'archivio)`);
  assertSpace(120 * 1024 * 1024);

  const id = newId();
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(MEDIA_DIR, `.motion-${id}-`));
  const silent = path.join(work, "grafica.mp4");
  const out = path.join(MEDIA_DIR, `${id}.mp4`);
  try {
    // 1. Voce, scena per scena, con i tempi delle parole (per i sottotitoli).
    const voices = list.some((s) => s.voice) ? await synthesize(list.map((s) => s.voice), work, { speed: Math.min(1.3, Math.max(0.85, Number(voice_speed) || 1.06)) }) : list.map(() => null);
    // 2. Tempi: ogni scena dura quanto la sua frase (con un attimo prima e dopo) o il tempo giusto per la sua animazione.
    let at = 0;
    const plan = list.map((s, i) => {
      const v = voices[i];
      const lead = i === 0 ? 0.25 : 0.32;
      const dur = Math.min(20, Math.max(s.seconds ?? defaultSeconds(s), v ? lead + v.seconds + 0.45 : 0, 1.5));
      const p = { ...s, at, dur, voiceAt: at + lead, voiceFile: v?.file, words: v?.words ?? [], file: mediaFile(s, i) };
      at += dur;
      return p;
    });
    const total = at;
    if (total > MAX_TOTAL) throw new Error(`video troppo lungo (${Math.round(total)} s): al massimo ${MAX_TOTAL} secondi (accorcia le frasi o togli scene)`);

    // 3. Pagina animata con caratteri, GSAP e file dell'archivio nella cartella di lavoro (niente internet).
    fs.copyFileSync(require.resolve("gsap/dist/gsap.min.js"), path.join(work, "gsap.min.js"));
    for (const font of ["Sora-latin.woff2", "Sora-latin-ext.woff2", "Inter.ttf"]) fs.copyFileSync(path.join(ROOT, "assets", "fonts", font), path.join(work, font));
    for (const s of plan) {
      if (s.type !== "media") continue;
      const src = mediaPath(s.media);
      try {
        fs.symlinkSync(src, path.join(work, s.file));
      } catch {
        fs.copyFileSync(src, path.join(work, s.file));
      }
    }
    fs.writeFileSync(path.join(work, "index.html"), pageHtml({ f, t, scenes: plan, total, transition, captions: captions ?? plan.some((s) => s.words.length) }));
    await render(work, silent, f, total);

    // 4. Audio: voce + musica (più bassa quando parla la voce) + un "whoosh" a ogni cambio di scena.
    const args = ["-y", "-v", "error", "-i", silent];
    const chains = [];
    let input = 1;
    const fmt = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";
    args.push("-f", "lavfi", "-t", total.toFixed(3), "-i", "anullsrc=r=44100:cl=stereo");
    chains.push(`[${input++}:a]${fmt}[base]`);
    const mix = ["[base]"];
    const voiced = plan.filter((s) => s.voiceFile);
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
      const vol = Math.min(1, Math.max(0, Number(music_volume ?? (voiced.length ? 0.2 : 0.7))));
      chains.push(`[${input++}:a]atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,${fmt},volume=${vol},afade=t=in:d=0.4,afade=t=out:st=${Math.max(0, total - 1.5).toFixed(3)}:d=1.5[music0]`);
      if (voiced.length) chains.push("[music0][voicesc]sidechaincompress=threshold=0.03:ratio=8:attack=15:release=350[music]");
      else chains.push("[music0]anull[music]");
      mix.push("[music]");
    } else if (voiced.length) {
      chains.push("[voicesc]anullsink");
    }
    if (plan.length > 1 && transition !== "fade") {
      args.push("-f", "lavfi", "-i", "anoisesrc=d=0.5:c=pink:r=44100:a=0.5,highpass=f=350,lowpass=f=6000,afade=t=in:d=0.25,afade=t=out:st=0.25:d=0.25,volume=0.5");
      const src = input++;
      const hits = plan.slice(1).map((s) => Math.max(0, s.at - WIPE - 0.05));
      chains.push(`[${src}:a]${fmt},asplit=${hits.length}${hits.map((_, k) => `[w${k}]`).join("")}`);
      hits.forEach((h, k) => {
        const ms = Math.round(h * 1000);
        chains.push(`[w${k}]adelay=${ms}|${ms}[wd${k}]`);
      });
      chains.push(`${hits.map((_, k) => `[wd${k}]`).join("")}amix=inputs=${hits.length}:normalize=0[sfx]`);
      mix.push("[sfx]");
    }
    chains.push(`${mix.join("")}amix=inputs=${mix.length}:duration=first:normalize=0,alimiter=limit=0.95[aout]`);
    args.push("-filter_complex", chains.join(";"), "-map", "0:v", "-map", "[aout]", "-t", total.toFixed(3), "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", out);
    const bin = await ffmpegPath();
    await run(bin, args, work);
    const poster = path.join(work, "poster.jpg");
    await run(bin, ["-y", "-v", "error", "-ss", String(Math.min(1.4, total / 2)), "-i", out, "-frames:v", "1", "-q:v", "3", poster], work);
    const said = plan.map((s) => s.voice).filter(Boolean).join(" ");
    return await addVideoFile(id, {
      poster, title: title || "Video animato", description: description || said.slice(0, 1000), origin: "video", by,
      width: f.w, height: f.h, duration: Math.round(total * 10) / 10,
    });
  } catch (err) {
    fs.rmSync(out, { force: true });
    throw err;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Solo per le prove: la pagina HTML che verrebbe disegnata (senza voce). */
export function previewHtml({ format = "story", theme = "notte", accent, transition = "mix", scenes } = {}) {
  const f = MOTION_FORMATS[format];
  const t = { ...(THEMES[theme] ?? THEMES.notte), ...(hex(accent) ? { accent: hex(accent) } : {}) };
  let at = 0;
  const plan = scenes.map(checkScene).map((s, i) => {
    const dur = s.seconds ?? defaultSeconds(s);
    const p = { ...s, at, dur, voiceAt: at + 0.25, words: [], file: mediaFile(s, i) };
    at += dur;
    return p;
  });
  return { html: pageHtml({ f, t, scenes: plan, total: at, transition, captions: false }), total: at, plan };
}
