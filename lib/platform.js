// Personalizzazioni della piattaforma che può cambiare anche Orion: aspetto (colori, nome e simbolo dell'app),
// tasti rapidi (scorciatoie nella chat e nell'Ufficio) e idee di miglioramento da portare a chi sviluppa il programma.
// Dati in <dati>/platform.json. Niente codice: solo valori controllati (colori esadecimali, testi brevi, link https),
// così un testo sbagliato non può rompere l'app né eseguire niente.
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./paths.js";
import { writeFileAtomic, readJsonSafe } from "./files.js";
import { bus } from "./store.js";

const FILE = path.join(DATA_DIR, "platform.json");

/** Colori modificabili → variabili del foglio di stile. */
export const COLOR_KEYS = {
  sfondo: "--bg",
  pannelli: "--surface",
  pannelli_2: "--surface-2",
  pannelli_3: "--surface-3",
  bordi: "--border",
  testo: "--text",
  testo_secondario: "--muted",
  accento: "--accent",
  accento_2: "--accent-2",
  positivo: "--good",
  negativo: "--bad",
  avviso: "--warn",
};
export const DEFAULT_COLORS = {
  sfondo: "#0b0d16", pannelli: "#13162a", pannelli_2: "#1b1f36", pannelli_3: "#242944", bordi: "#2a2f4d", testo: "#e9ebf6",
  testo_secondario: "#8a90b2", accento: "#6f7dff", accento_2: "#a46bff", positivo: "#34c08a", negativo: "#ff6b6b", avviso: "#ffc94d",
};
/** Temi pronti (tutti scuri: l'app e il palazzo 3D sono pensati per lo sfondo scuro). */
export const PRESETS = {
  notte: {},
  oceano: { sfondo: "#07121c", pannelli: "#0d1d2b", pannelli_2: "#13283a", pannelli_3: "#1a3349", bordi: "#22405a", testo: "#e6f2fb", testo_secondario: "#86a3ba", accento: "#2bb3ff", accento_2: "#36d6c3" },
  smeraldo: { sfondo: "#08130f", pannelli: "#0f1f19", pannelli_2: "#162a22", pannelli_3: "#1e362c", bordi: "#26453a", testo: "#e7f5ef", testo_secondario: "#8bab9e", accento: "#2fd38a", accento_2: "#c4e86b" },
  tramonto: { sfondo: "#140b10", pannelli: "#21121a", pannelli_2: "#2c1822", pannelli_3: "#38202c", bordi: "#4a2a39", testo: "#fbeef2", testo_secondario: "#b8929f", accento: "#ff7a59", accento_2: "#ff4f9a" },
  oro: { sfondo: "#0f0d08", pannelli: "#1a170e", pannelli_2: "#242013", pannelli_3: "#2f2a19", bordi: "#423a22", testo: "#f8f2e2", testo_secondario: "#aea284", accento: "#e8b84a", accento_2: "#f08a3c" },
  venturo: { sfondo: "#0a0c14", pannelli: "#121624", pannelli_2: "#1a2033", pannelli_3: "#232b43", bordi: "#2c3552", testo: "#eef1fa", testo_secondario: "#8f98b8", accento: "#ffd166", accento_2: "#5b8cff" },
};
export const VIEWS = ["office", "chat", "approvals", "notes", "portfolio", "costs", "social", "broker", "building", "log"];
const ACTIONS = ["chat", "run_agent", "link", "view"];
const MAX_SHORTCUTS = 12;
const MAX_IDEAS = 50;

let data = load();
function load() {
  const r = readJsonSafe(FILE);
  const d = r.data && typeof r.data === "object" && !Array.isArray(r.data) ? r.data : {};
  return {
    look: d.look && typeof d.look === "object" ? d.look : {},
    shortcuts: Array.isArray(d.shortcuts) ? d.shortcuts : [],
    ideas: Array.isArray(d.ideas) ? d.ideas : [],
  };
}
function save(what) {
  writeFileAtomic(FILE, JSON.stringify(data, null, 2));
  bus.emit("event", { type: "platform", what });
}

const HEX = /^#[0-9a-f]{6}$/i;
function hex(v, key) {
  let s = String(v ?? "").trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${[...s.slice(1)].map((c) => c + c).join("")}`;
  if (!HEX.test(s)) throw new Error(`colore "${key}": scrivilo in esadecimale, es. #6f7dff`);
  return s;
}
/** Contrasto tra due colori (1–21): sotto 4,5 il testo si legge male. */
export function contrast(a, b) {
  const lum = (h) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const cleanText = (v, max) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const emoji = (v) => {
  const s = String(v ?? "").trim();
  return s && [...s].length <= 4 && !/[<>"'&\w]/.test(s) ? s : "";
};

export function getPlatform() {
  const colors = { ...DEFAULT_COLORS, ...(data.look.colors ?? {}) };
  return {
    look: {
      preset: data.look.preset ?? "notte",
      colors,
      vars: Object.fromEntries(Object.entries(colors).map(([k, v]) => [COLOR_KEYS[k], v])),
      title: data.look.title || null,
      logo: data.look.logo || null,
      fontScale: data.look.fontScale ?? 1,
      radius: data.look.radius ?? 14,
    },
    presets: Object.keys(PRESETS),
    shortcuts: data.shortcuts,
    ideas: data.ideas.slice().reverse(),
  };
}

/**
 * Aspetto dell'app. preset = tema pronto (poi si possono ritoccare i singoli colori); reset = torna all'aspetto
 * originale. Il testo deve restare leggibile sullo sfondo e sui pannelli.
 */
export function setLook({ preset, colors, title, logo, font_scale, radius, reset } = {}) {
  const look = reset ? {} : { ...data.look, colors: { ...(data.look.colors ?? {}) } };
  if (preset !== undefined) {
    if (!PRESETS[preset]) throw new Error(`tema sconosciuto: ${Object.keys(PRESETS).join(", ")}`);
    look.preset = preset;
    look.colors = { ...PRESETS[preset] };
  }
  for (const [k, v] of Object.entries(colors ?? {})) {
    if (!COLOR_KEYS[k]) throw new Error(`colore sconosciuto "${k}": usa ${Object.keys(COLOR_KEYS).join(", ")}`);
    look.colors ??= {};
    look.colors[k] = hex(v, k);
  }
  const all = { ...DEFAULT_COLORS, ...(look.colors ?? {}) };
  for (const bg of ["sfondo", "pannelli", "pannelli_2"]) {
    const c = contrast(all.testo, all[bg]);
    if (c < 4.5) throw new Error(`il testo (${all.testo}) si leggerebbe male su ${bg} (${all[bg]}): contrasto ${c.toFixed(1)}, serve almeno 4,5`);
  }
  if (contrast(all.testo_secondario, all.pannelli) < 3) throw new Error("testo_secondario troppo simile ai pannelli: non si leggerebbe");
  if (title !== undefined) look.title = cleanText(title, 40) || undefined;
  if (logo !== undefined) {
    const e = emoji(logo);
    if (logo && !e) throw new Error("logo: una sola emoji (es. 🚀)");
    look.logo = e || undefined;
  }
  if (font_scale !== undefined) {
    const n = Number(font_scale);
    if (!(n >= 0.85 && n <= 1.3)) throw new Error("font_scale: da 0.85 (più piccolo) a 1.3 (più grande)");
    look.fontScale = Math.round(n * 100) / 100;
  }
  if (radius !== undefined) {
    const n = Number(radius);
    if (!Number.isInteger(n) || n < 0 || n > 28) throw new Error("radius: arrotondamento degli angoli da 0 a 28");
    look.radius = n;
  }
  data.look = look;
  save("look");
  return getPlatform().look;
}

/** Tasto rapido: manda un messaggio a Orion, fa lavorare un agente, apre un link https o una sezione dell'app. */
export function saveShortcut({ id, label, icon, action, value } = {}, { agentExists = () => true } = {}) {
  const lab = cleanText(label, 30);
  if (!lab) throw new Error("label: il nome del tasto (max 30 caratteri)");
  if (!ACTIONS.includes(action)) throw new Error(`action: ${ACTIONS.join(", ")}`);
  let val = String(value ?? "").trim();
  if (action === "chat") {
    val = cleanText(val, 500);
    if (!val) throw new Error("value: il messaggio da mandare a Orion");
  } else if (action === "run_agent") {
    if (!agentExists(val)) throw new Error(`value: agente ${val} inesistente`);
  } else if (action === "link") {
    let u;
    try {
      u = new URL(val);
    } catch {
      throw new Error("value: un indirizzo completo, es. https://www.instagram.com/…");
    }
    if (u.protocol !== "https:") throw new Error("value: solo indirizzi https://");
    val = u.toString();
  } else if (!VIEWS.includes(val)) {
    throw new Error(`value: una sezione tra ${VIEWS.join(", ")}`);
  }
  const old = id ? data.shortcuts.find((s) => s.id === id) : null;
  if (id && !old) throw new Error(`tasto ${id} inesistente`);
  if (!old && data.shortcuts.length >= MAX_SHORTCUTS) throw new Error(`al massimo ${MAX_SHORTCUTS} tasti: eliminane uno`);
  const s = { id: old?.id ?? `t${crypto.randomBytes(3).toString("hex")}`, label: lab, icon: emoji(icon) || "⚡", action, value: val };
  data.shortcuts = old ? data.shortcuts.map((x) => (x.id === s.id ? s : x)) : [...data.shortcuts, s];
  save("shortcuts");
  return s;
}

export function deleteShortcut(id) {
  if (!data.shortcuts.some((s) => s.id === id)) throw new Error(`tasto ${id} inesistente`);
  data.shortcuts = data.shortcuts.filter((s) => s.id !== id);
  save("shortcuts");
  return { deleted: id };
}

/** Riordina i tasti (ids nell'ordine voluto; quelli non citati restano in fondo). */
export function orderShortcuts(ids = []) {
  const pos = new Map([].concat(ids).map((id, i) => [String(id), i]));
  data.shortcuts = data.shortcuts.slice().sort((a, b) => (pos.get(a.id) ?? 99) - (pos.get(b.id) ?? 99));
  save("shortcuts");
  return data.shortcuts;
}

/** Idea di miglioramento che richiede di cambiare il programma: l'utente la porta a chi lo sviluppa. */
export function addIdea({ title, text, by = "Orion" } = {}) {
  const t = cleanText(title, 80);
  const body = String(text ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, 2000);
  if (!t || !body) throw new Error("serve un titolo e una descrizione dell'idea");
  const idea = { id: `i${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`, title: t, text: body, by: cleanText(by, 40), at: new Date().toISOString() };
  data.ideas = [...data.ideas, idea].slice(-MAX_IDEAS);
  save("ideas");
  return idea;
}

export function deleteIdea(id) {
  if (!data.ideas.some((i) => i.id === id)) throw new Error("idea inesistente");
  data.ideas = data.ideas.filter((i) => i.id !== id);
  save("ideas");
  return { deleted: id };
}

export function _reload() {
  data = load();
}
