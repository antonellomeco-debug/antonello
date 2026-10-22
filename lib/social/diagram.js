// Diagrammi per caroselli e post (strumento create_diagram): l'agente passa solo i dati in JSON, il server disegna l'SVG
// con i colori e i caratteri di Venturo e lo trasforma in immagine con create_graphic. Regole prese da diagram-design
// (github.com/cathrynlavery/diagram-design, licenza MIT): pochi elementi, l'accento solo su 1–2 punti focali, linee sottili,
// niente ombre. Tipi: process, timeline, funnel, compare, quadrant, bars, cycle.
import { FORMATS, createGraphic } from "./media.js";

export const DIAGRAM_TYPES = ["process", "timeline", "funnel", "compare", "quadrant", "bars", "cycle"];
export const DIAGRAM_FORMATS = ["portrait", "square", "story", "landscape"];

const THEMES = {
  chiaro: { bg: "#F7F9FC", panel: "#EEF2F7", ink: "#0A1F44", muted: "#3F4A5C", soft: "#5B6575", rule: "#C9D1DE", accent: "#2F5BFF", tint: "#E3E9FF", onAccent: "#FFFFFF", green: "#0B7A45", dot: "#0B7A45" },
  notte: { bg: "#0A1F44", panel: "#13295A", ink: "#F7F9FC", muted: "#C3CBD9", soft: "#9AA6BA", rule: "#2A3F6B", accent: "#7C9BFF", tint: "#1C3570", onAccent: "#0B1220", green: "#2BD67B", dot: "#2BD67B" },
};
const TITLE_FONT = "Sora";
const TEXT_FONT = "Inter";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const str = (v, max, what) => {
  const t = String(v ?? "").replace(/\s+/g, " ").trim();
  if (t.length > max) throw new Error(`${what}: al massimo ${max} caratteri (ora ${t.length}): accorcia`);
  return t;
};

/** A capo approssimato: larghezza media di un carattere ≈ factor × dimensione (Inter ~0,53, Sora grassetto ~0,62). */
function wrap(text, maxPx, size, factor = 0.53) {
  const perLine = Math.max(4, Math.floor(maxPx / (size * factor)));
  const lines = [];
  let cur = "";
  for (const word of String(text).split(" ").filter(Boolean)) {
    if (!cur) cur = word;
    else if ((cur + " " + word).length <= perLine) cur += ` ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Riga o righe di testo (tspan), con l'altezza occupata. */
function textBlock(x, y, text, { size, maxPx, color, font = TEXT_FONT, weight = 400, factor, anchor = "start", lh = 1.22, maxLines = 4 }) {
  let lines = wrap(text, maxPx, size, factor ?? (font === TITLE_FONT ? 0.6 : 0.5));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[\s,.;:]+$/, "")}…`;
  }
  const tspans = lines.map((l, i) => `<tspan x="${x}" dy="${i ? size * lh : 0}">${esc(l)}</tspan>`).join("");
  return {
    svg: `<text x="${x}" y="${y + size * 0.82}" font-family="${font}" font-weight="${weight}" font-size="${size}" fill="${color}" text-anchor="${anchor}">${tspans}</text>`,
    h: lines.length ? size * (1 + (lines.length - 1) * lh) : 0,
    lines: lines.length,
  };
}

/** Il simbolo di Venturo (V con il punto verde) e la scritta. */
function logo(x, y, size, c) {
  const k = size / 200;
  return `<g transform="translate(${x} ${y}) scale(${k})"><path d="M36 70 L92 152 L148 54" fill="none" stroke="${c.ink}" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/><circle cx="170" cy="25" r="20" fill="${c.dot}"/></g>` +
    `<text x="${x + size * 1.02}" y="${y + size * 0.74}" font-family="${TITLE_FONT}" font-weight="800" font-size="${size * 0.62}" fill="${c.ink}">venturo</text>`;
}

const items = (spec, min, max, what = "items") => {
  const list = Array.isArray(spec[what]) ? spec[what] : [];
  if (list.length < min || list.length > max) throw new Error(`${what}: da ${min} a ${max} elementi (ora ${list.length}); un diagramma con troppi elementi non si legge: dividilo in due slide`);
  return list.map((it) => (typeof it === "string" ? { label: it } : it ?? {}));
};
const focusOf = (list) => {
  const n = list.filter((it) => it.focus).length;
  if (n > 2) throw new Error("focus: al massimo 2 elementi evidenziati (l'accento perde forza se è ovunque)");
};

// ------------------------------------------------------------------ tipi

function process(spec, box, c, s) {
  const list = items(spec, 2, 7);
  focusOf(list);
  const out = [];
  const gap = (box.h - 0) / list.length;
  const r = Math.min(34 * s, gap * 0.28);
  const tx = box.x + r * 2 + 30 * s;
  const maxPx = box.x + box.w - tx;
  list.forEach((it, i) => {
    const cy = box.y + gap * i + r;
    if (i < list.length - 1) out.push(`<line x1="${box.x + r}" y1="${cy + r + 8 * s}" x2="${box.x + r}" y2="${cy + gap - r - 8 * s}" stroke="${c.rule}" stroke-width="${3 * s}"/>`);
    const on = it.focus;
    out.push(`<circle cx="${box.x + r}" cy="${cy}" r="${r}" fill="${on ? c.accent : c.bg}" stroke="${on ? c.accent : c.ink}" stroke-width="${3 * s}"/>`);
    out.push(`<text x="${box.x + r}" y="${cy + r * 0.36}" text-anchor="middle" font-family="${TITLE_FONT}" font-weight="800" font-size="${r}" fill="${on ? c.onAccent : c.ink}">${i + 1}</text>`);
    const label = textBlock(tx, cy - r * 0.9, str(it.label, 70, `items[${i}].label`), { size: 34 * s, maxPx, color: on ? c.accent : c.ink, font: TITLE_FONT, weight: 700, maxLines: 2 });
    out.push(label.svg);
    if (it.text) out.push(textBlock(tx, cy - r * 0.9 + label.h + 10 * s, str(it.text, 160, `items[${i}].text`), { size: 25 * s, maxPx, color: c.muted, maxLines: Math.max(1, Math.floor((gap - label.h - 30 * s) / (25 * s * 1.22))) }).svg);
  });
  return out.join("");
}

function timeline(spec, box, c, s) {
  const list = items(spec, 2, 8);
  focusOf(list);
  const out = [];
  const lineX = box.x + 190 * s;
  const gap = box.h / list.length;
  out.push(`<line x1="${lineX}" y1="${box.y + 20 * s}" x2="${lineX}" y2="${box.y + gap * (list.length - 1) + 20 * s}" stroke="${c.rule}" stroke-width="${3 * s}"/>`);
  list.forEach((it, i) => {
    const y = box.y + gap * i;
    const on = it.focus;
    out.push(`<circle cx="${lineX}" cy="${y + 20 * s}" r="${(on ? 14 : 10) * s}" fill="${on ? c.accent : c.bg}" stroke="${on ? c.accent : c.ink}" stroke-width="${3 * s}"/>`);
    out.push(textBlock(lineX - 30 * s, y, str(it.date, 20, `items[${i}].date`), { size: 26 * s, maxPx: 170 * s, color: on ? c.accent : c.soft, weight: 600, anchor: "end", maxLines: 2 }).svg);
    const label = textBlock(lineX + 40 * s, y, str(it.label, 80, `items[${i}].label`), { size: 32 * s, maxPx: box.x + box.w - lineX - 40 * s, color: c.ink, font: TITLE_FONT, weight: 700, maxLines: 2 });
    out.push(label.svg);
    if (it.text) out.push(textBlock(lineX + 40 * s, y + label.h + 8 * s, str(it.text, 140, `items[${i}].text`), { size: 24 * s, maxPx: box.x + box.w - lineX - 40 * s, color: c.muted, maxLines: Math.max(1, Math.floor((gap - label.h - 26 * s) / (24 * s * 1.22))) }).svg);
  });
  return out.join("");
}

function funnel(spec, box, c, s) {
  const list = items(spec, 2, 6);
  focusOf(list);
  const out = [];
  const gap = 12 * s;
  const h = (box.h - gap * (list.length - 1)) / list.length;
  const cx = box.x + box.w / 2;
  const wTop = box.w;
  const wBot = box.w * 0.38;
  list.forEach((it, i) => {
    const w1 = wTop - ((wTop - wBot) * i) / list.length;
    const w2 = wTop - ((wTop - wBot) * (i + 1)) / list.length;
    const y = box.y + i * (h + gap);
    const on = it.focus;
    const fill = on ? c.accent : i % 2 ? c.panel : c.tint;
    out.push(`<path d="M${cx - w1 / 2} ${y} L${cx + w1 / 2} ${y} L${cx + w2 / 2} ${y + h} L${cx - w2 / 2} ${y + h} Z" fill="${fill}"/>`);
    const value = it.value != null && it.value !== "" ? str(it.value, 16, `items[${i}].value`) : "";
    const size = Math.min(34 * s, h * 0.32);
    const label = str(it.label, 50, `items[${i}].label`);
    if (value) {
      out.push(`<text x="${cx}" y="${y + h / 2 - size * 0.15}" text-anchor="middle" font-family="${TITLE_FONT}" font-weight="800" font-size="${size * 1.25}" fill="${on ? c.onAccent : c.ink}">${esc(value)}</text>`);
      out.push(`<text x="${cx}" y="${y + h / 2 + size * 1.05}" text-anchor="middle" font-family="${TEXT_FONT}" font-weight="500" font-size="${size * 0.8}" fill="${on ? c.onAccent : c.muted}">${esc(label)}</text>`);
    } else {
      out.push(`<text x="${cx}" y="${y + h / 2 + size * 0.35}" text-anchor="middle" font-family="${TITLE_FONT}" font-weight="700" font-size="${size}" fill="${on ? c.onAccent : c.ink}">${esc(label)}</text>`);
    }
  });
  return out.join("");
}

function compare(spec, box, c, s) {
  const sides = [spec.left, spec.right].map((x, i) => {
    const side = x ?? {};
    const list = (Array.isArray(side.items) ? side.items : []).map((v) => (typeof v === "string" ? v : v?.label ?? ""));
    if (list.length < 1 || list.length > 6) throw new Error(`${i ? "right" : "left"}.items: da 1 a 6 punti`);
    return { title: str(side.title, 40, `${i ? "right" : "left"}.title`), list: list.map((t, j) => str(t, 110, `${i ? "right" : "left"}.items[${j}]`)), focus: Boolean(side.focus) };
  });
  const gap = 28 * s;
  const w = (box.w - gap) / 2;
  const out = [];
  let bottom = box.y;
  const panels = sides.map((side, i) => {
    const x = box.x + i * (w + gap);
    const on = side.focus;
    const parts = [];
    const head = textBlock(x + 32 * s, box.y + 32 * s, side.title, { size: 34 * s, maxPx: w - 64 * s, color: on ? c.accent : c.ink, font: TITLE_FONT, weight: 800, maxLines: 2 });
    parts.push(head.svg);
    parts.push(`<line x1="${x + 32 * s}" y1="${box.y + 52 * s + head.h}" x2="${x + w - 32 * s}" y2="${box.y + 52 * s + head.h}" stroke="${c.rule}" stroke-width="${2 * s}"/>`);
    let y = box.y + 80 * s + head.h;
    const size = 28 * s;
    for (const t of side.list) {
      const left = box.y + box.h - 24 * s - y;
      if (left < size) break;
      parts.push(`<circle cx="${x + 40 * s}" cy="${y + size * 0.55}" r="${6 * s}" fill="${on ? c.accent : c.soft}"/>`);
      const b = textBlock(x + 60 * s, y, t, { size, maxPx: w - 92 * s, color: c.ink, maxLines: Math.max(1, Math.min(3, Math.floor(left / (size * 1.22)))) });
      parts.push(b.svg);
      y += b.h + 30 * s;
    }
    bottom = Math.max(bottom, y);
    return { x, on, parts };
  });
  // I due riquadri sono alti quanto il più lungo dei due elenchi (non tutto lo spazio: resterebbe vuoto).
  const height = Math.min(box.h, bottom - box.y + 6 * s);
  for (const p of panels) {
    out.push(`<rect x="${p.x}" y="${box.y}" width="${w}" height="${height}" rx="${18 * s}" fill="${p.on ? c.tint : c.panel}" ${p.on ? `stroke="${c.accent}" stroke-width="${3 * s}"` : ""}/>`, ...p.parts);
  }
  return out.join("");
}

function quadrant(spec, box, c, s) {
  const list = items(spec, 1, 8);
  focusOf(list);
  const size = Math.min(box.w, box.h) - 50 * s;
  const x0 = box.x + (box.w - size) / 2 + 30 * s;
  const y0 = box.y;
  const out = [];
  const q = Array.isArray(spec.quadrants) ? spec.quadrants.slice(0, 4).map((t, i) => str(t, 30, `quadrants[${i}]`)) : [];
  out.push(`<rect x="${x0}" y="${y0}" width="${size}" height="${size}" fill="${c.panel}" rx="${12 * s}"/>`);
  out.push(`<line x1="${x0 + size / 2}" y1="${y0}" x2="${x0 + size / 2}" y2="${y0 + size}" stroke="${c.rule}" stroke-width="${2 * s}"/>`);
  out.push(`<line x1="${x0}" y1="${y0 + size / 2}" x2="${x0 + size}" y2="${y0 + size / 2}" stroke="${c.rule}" stroke-width="${2 * s}"/>`);
  // Nomi dei quadranti: in alto a sinistra, in alto a destra, in basso a sinistra, in basso a destra.
  const corners = [[x0 + 18 * s, y0 + 18 * s, "start"], [x0 + size - 18 * s, y0 + 18 * s, "end"], [x0 + 18 * s, y0 + size / 2 + 18 * s, "start"], [x0 + size - 18 * s, y0 + size / 2 + 18 * s, "end"]];
  q.forEach((t, i) => out.push(textBlock(corners[i][0], corners[i][1], t.toUpperCase(), { size: 18 * s, maxPx: size / 2 - 40 * s, color: c.soft, weight: 600, anchor: corners[i][2], maxLines: 2 }).svg));
  const xl = str(spec.x_label ?? "", 40, "x_label");
  const yl = str(spec.y_label ?? "", 40, "y_label");
  if (xl) out.push(`<text x="${x0 + size}" y="${y0 + size + 34 * s}" text-anchor="end" font-family="${TEXT_FONT}" font-weight="600" font-size="${22 * s}" fill="${c.muted}">${esc(xl)} →</text>`);
  if (yl) out.push(`<text transform="translate(${x0 - 18 * s} ${y0}) rotate(-90)" text-anchor="end" font-family="${TEXT_FONT}" font-weight="600" font-size="${22 * s}" fill="${c.muted}">${esc(yl)} →</text>`);
  list.forEach((it, i) => {
    const px = Math.min(Math.max(Number(it.x), 0), 100);
    const py = Math.min(Math.max(Number(it.y), 0), 100);
    if (!Number.isFinite(Number(it.x)) || !Number.isFinite(Number(it.y))) throw new Error(`items[${i}]: servono x e y da 0 a 100`);
    const cx = x0 + (px / 100) * size;
    const cy = y0 + size - (py / 100) * size;
    const on = it.focus;
    out.push(`<circle cx="${cx}" cy="${cy}" r="${(on ? 16 : 11) * s}" fill="${on ? c.accent : c.ink}"/>`);
    const right = px < 70;
    out.push(textBlock(cx + (right ? 22 : -22) * s, cy - 16 * s, str(it.label, 40, `items[${i}].label`), { size: 22 * s, maxPx: size * 0.36, color: on ? c.accent : c.ink, weight: 600, anchor: right ? "start" : "end", maxLines: 2 }).svg);
  });
  return out.join("");
}

function bars(spec, box, c, s) {
  const list = items(spec, 2, 10);
  focusOf(list);
  const vals = list.map((it, i) => {
    const v = Number(it.value);
    if (!Number.isFinite(v) || v < 0) throw new Error(`items[${i}].value: un numero (0 o più)`);
    return v;
  });
  const max = Math.max(...vals) || 1;
  const unit = str(spec.unit ?? "", 12, "unit");
  const gap = box.h / list.length;
  const barH = Math.min(gap * 0.42, 44 * s);
  const fmt = (v) => `${v.toLocaleString("it-IT", { maximumFractionDigits: 2, useGrouping: "always" })}${unit ? (/^[%€$]/.test(unit) ? unit : ` ${unit}`) : ""}`;
  const out = [];
  list.forEach((it, i) => {
    const y = box.y + gap * i;
    const on = it.focus;
    out.push(textBlock(box.x, y, str(it.label, 50, `items[${i}].label`), { size: 26 * s, maxPx: box.w, color: on ? c.accent : c.ink, weight: on ? 700 : 600, maxLines: 1 }).svg);
    const valW = 170 * s;
    const w = Math.max(6 * s, ((box.w - valW) * vals[i]) / max);
    const by = y + 40 * s;
    out.push(`<rect x="${box.x}" y="${by}" width="${box.w - valW}" height="${barH}" rx="${barH / 2}" fill="${c.panel}"/>`);
    out.push(`<rect x="${box.x}" y="${by}" width="${w}" height="${barH}" rx="${barH / 2}" fill="${on ? c.accent : c.ink}"/>`);
    out.push(`<text x="${box.x + box.w}" y="${by + barH * 0.78}" text-anchor="end" font-family="${TITLE_FONT}" font-weight="800" font-size="${Math.min(30 * s, barH * 0.95)}" fill="${on ? c.accent : c.ink}">${esc(fmt(vals[i]))}</text>`);
  });
  return out.join("");
}

function cycle(spec, box, c, s) {
  const list = items(spec, 3, 6);
  focusOf(list);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const R = Math.min(box.w, box.h) / 2 - 110 * s;
  const out = [`<defs><marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="${7}" markerHeight="${7}" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${c.soft}"/></marker></defs>`];
  out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${c.rule}" stroke-width="${3 * s}"/>`);
  const n = list.length;
  for (let i = 0; i < n; i++) {
    // Freccia sull'arco tra un elemento e il successivo.
    const a1 = -Math.PI / 2 + ((i + 0.32) * 2 * Math.PI) / n;
    const a2 = -Math.PI / 2 + ((i + 0.68) * 2 * Math.PI) / n;
    out.push(`<path d="M${cx + R * Math.cos(a1)} ${cy + R * Math.sin(a1)} A${R} ${R} 0 0 1 ${cx + R * Math.cos(a2)} ${cy + R * Math.sin(a2)}" fill="none" stroke="${c.soft}" stroke-width="${3 * s}" marker-end="url(#ar)"/>`);
  }
  const center = str(spec.center ?? "", 40, "center");
  if (center) out.push(textBlock(cx, cy - 30 * s, center, { size: 32 * s, maxPx: R * 1.2, color: c.ink, font: TITLE_FONT, weight: 800, anchor: "middle", maxLines: 2 }).svg.replace(/<tspan x="[^"]*"/g, `<tspan x="${cx}"`));
  list.forEach((it, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const x = cx + R * Math.cos(a);
    const y = cy + R * Math.sin(a);
    const on = it.focus;
    const rw = 200 * s;
    const rh = 92 * s;
    out.push(`<rect x="${x - rw / 2}" y="${y - rh / 2}" width="${rw}" height="${rh}" rx="${rh / 2}" fill="${on ? c.accent : c.bg}" stroke="${on ? c.accent : c.ink}" stroke-width="${3 * s}"/>`);
    const t = textBlock(x, y - rh / 2 + 16 * s, str(it.label, 34, `items[${i}].label`), { size: 24 * s, maxPx: rw - 30 * s, color: on ? c.onAccent : c.ink, weight: 700, anchor: "middle", maxLines: 2 });
    const lines = t.lines;
    out.push(t.svg.replace(/<tspan x="[^"]*"/g, `<tspan x="${x}"`).replace(/ y="[^"]*"/, ` y="${y - ((lines - 1) * 24 * s * 1.22) / 2 + 24 * s * 0.36}"`));
  });
  return out.join("");
}

const DRAW = { process, timeline, funnel, compare, quadrant, bars, cycle };

/** SVG del diagramma (per le prove e per create_diagram). */
export function diagramSvg(spec = {}) {
  const type = String(spec.type ?? "");
  if (!DIAGRAM_TYPES.includes(type)) throw new Error(`type: ${DIAGRAM_TYPES.join(", ")}`);
  const format = spec.format ?? "portrait";
  if (!DIAGRAM_FORMATS.includes(format)) throw new Error(`format: ${DIAGRAM_FORMATS.join(", ")}`);
  const c = THEMES[spec.theme === "notte" ? "notte" : "chiaro"];
  const { w, h } = FORMATS[format];
  const s = Math.min(w / 1080, h / 1080);
  const m = 80 * s;
  const parts = [`<rect width="${w}" height="${h}" fill="${c.bg}"/>`];
  let y = m;
  const kicker = str(spec.kicker ?? "", 40, "kicker");
  if (kicker) {
    parts.push(`<text x="${m}" y="${y + 22 * s}" font-family="${TEXT_FONT}" font-weight="700" font-size="${22 * s}" letter-spacing="${3 * s}" fill="${c.accent}">${esc(kicker.toUpperCase())}</text>`);
    y += 44 * s;
  }
  const title = str(spec.title, 90, "title");
  if (!title) throw new Error("title: il titolo del diagramma (la cosa da capire, con un numero se c'è)");
  const t = textBlock(m, y, title, { size: (format === "landscape" ? 52 : 60) * s, maxPx: w - 2 * m, color: c.ink, font: TITLE_FONT, weight: 800, lh: 1.12, maxLines: 3 });
  parts.push(t.svg);
  y += t.h + 18 * s;
  const subtitle = str(spec.subtitle ?? "", 140, "subtitle");
  if (subtitle) {
    const st = textBlock(m, y, subtitle, { size: 28 * s, maxPx: w - 2 * m, color: c.muted, maxLines: 2 });
    parts.push(st.svg);
    y += st.h;
  }
  y += 44 * s;
  const footH = 70 * s;
  const box = { x: m, y, w: w - 2 * m, h: h - m - footH - y };
  parts.push(DRAW[type](spec, box, c, s));
  // Piè di pagina: fonte a sinistra, logo e numero della slide a destra.
  const fy = h - m * 0.75 - 34 * s;
  const source = str(spec.source ?? "", 120, "source");
  if (source) parts.push(textBlock(m, fy + 4 * s, `Fonte: ${source}`, { size: 20 * s, maxPx: w - 2 * m - 300 * s, color: c.soft, maxLines: 2 }).svg);
  const page = str(spec.page ?? "", 7, "page");
  const logoSize = 44 * s;
  const lx = w - m - logoSize * 3.2 - (page ? 80 * s : 0);
  parts.push(logo(lx, fy, logoSize, c));
  if (page) parts.push(`<text x="${w - m}" y="${fy + logoSize * 0.72}" text-anchor="end" font-family="${TEXT_FONT}" font-weight="600" font-size="${22 * s}" fill="${c.soft}">${esc(page)}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}</svg>`;
}

/** Diagramma → immagine nell'archivio (come create_graphic). */
export async function createDiagram(spec = {}, { by = null } = {}) {
  const svg = diagramSvg(spec);
  return createGraphic({ svg, format: spec.format ?? "portrait", title: spec.title, description: spec.description || `Diagramma (${spec.type}): ${spec.title}`, by });
}
