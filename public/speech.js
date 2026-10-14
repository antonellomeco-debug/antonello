// Orion risponde a voce: lettura delle risposte con le voci italiane del dispositivo (speechSynthesis, gratis).
// Sull'iPhone la voce parte solo se è stata "sbloccata" una volta con un tocco (unlock), poi funziona anche
// per le risposte che arrivano dopo. Il testo si legge a frasi brevi: i testi lunghi altrimenti si interrompono.

const synth = window.speechSynthesis;
export const speechSupported = () => Boolean(synth && window.SpeechSynthesisUtterance);

const MAX_CHARS = 1500; // oltre, si legge l'inizio e si rimanda al testo scritto
const NOVELTY = /^(Eddy|Flo|Grandma|Grandpa|Nonna|Nonno|Reed|Rocko|Sandy|Shelley|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/i;

let voice = null;
let queue = [];
let current = null;
let watchdog = null;
let onChange = () => {};

/** Viene chiamata quando la voce comincia o smette di parlare. */
export function onSpeakingChange(fn) {
  onChange = fn;
}

export const isSpeaking = () => Boolean(current || queue.length);

function pickVoice() {
  const all = synth.getVoices().filter((v) => /^it([-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name));
  const score = (v) =>
    (v.localService ? 4 : 0) + (/premium|enhanced|migliorat/i.test(v.name) ? 2 : 0) + (/federica|alice|luca|emma|paola/i.test(v.name) ? 1 : 0);
  voice = all.sort((a, b) => score(b) - score(a))[0] ?? null;
}
if (speechSupported()) {
  pickVoice();
  synth.addEventListener?.("voiceschanged", pickVoice);
}

/** Da chiamare dentro un tocco: sull'iPhone sblocca la voce per le risposte che arriveranno dopo. */
export function unlock() {
  if (!speechSupported() || isSpeaking()) return;
  const u = new SpeechSynthesisUtterance(".");
  u.lang = "it-IT";
  u.volume = 0.01;
  u.rate = 2;
  synth.speak(u);
}

/** Toglie dal testo ciò che non va letto: simboli del formato, link, emoji, codice. */
export function speakableText(text) {
  let t = String(text ?? "")
    .replace(/```[\s\S]*?```/g, " (codice omesso) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/\*\*|__|[*_~|]/g, " ")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ([.,;:!?»)])/g, "$1")
    .trim();
  if (t.length > MAX_CHARS) {
    const cut = t.lastIndexOf(".", MAX_CHARS);
    t = `${t.slice(0, cut > MAX_CHARS / 2 ? cut + 1 : MAX_CHARS)} Il resto lo trovi scritto nella chat.`;
  }
  return t;
}

/** Frasi di al massimo ~200 caratteri (senza spezzare i numeri come 2.350 o 1,5). */
export function chunks(text) {
  const out = [];
  for (const piece of text.split(/(?<=[.!?…;:])\s+|\n+/)) {
    let p = piece.trim();
    while (p.length > 220) {
      let cut = p.lastIndexOf(", ", 200);
      if (cut < 80) cut = p.lastIndexOf(" ", 200);
      if (cut < 80) cut = 200;
      out.push(p.slice(0, cut + 1).trim());
      p = p.slice(cut + 1).trim();
    }
    if (!p) continue;
    if (out.length && out[out.length - 1].length + p.length < 200) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}

/** Legge una risposta (si mette in coda dopo quelle già in lettura). */
export function say(text) {
  if (!speechSupported() || document.hidden) return;
  const parts = chunks(speakableText(text));
  if (!parts.length) return;
  const wasIdle = !isSpeaking();
  queue.push(...parts);
  if (wasIdle) {
    onChange(true);
    next();
  }
}

function next() {
  clearTimeout(watchdog);
  current = null;
  const text = queue.shift();
  if (!text) return onChange(false);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "it-IT";
  if (voice) u.voice = voice;
  u.rate = 1.05;
  current = u; // tenuta in memoria fino alla fine, altrimenti alcuni browser perdono gli eventi
  u.onend = u.onerror = () => current === u && next();
  watchdog = setTimeout(() => {
    if (current !== u) return;
    synth.cancel();
    next();
  }, (text.length / 10 + 8) * 1000);
  synth.speak(u);
}

/** Zittisce subito. */
export function stop() {
  if (!speechSupported()) return;
  const was = isSpeaking();
  queue = [];
  current = null;
  clearTimeout(watchdog);
  synth.cancel();
  if (was) onChange(false);
}

document.addEventListener("visibilitychange", () => document.hidden && stop());
