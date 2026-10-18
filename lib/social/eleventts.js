// Voce clonata dell'utente con ElevenLabs (elevenlabs.io): la sua voce vera come voce narrante dei video.
// L'utente crea la voce sul sito di ElevenLabs (Instant Voice Clone, piano Starter o superiore: il piano gratuito non
// permette l'uso commerciale) e mette qui la chiave API e l'ID della voce. Si chiede l'audio grezzo (PCM 16 bit, 24 kHz)
// e lo si avvolge in un WAV. Se ElevenLabs non risponde o i crediti del mese sono finiti, il video usa la voce dopo
// (Google, poi quella gratuita del server), così si fa comunque.
import { endpoint } from "./http.js";
import { getSettings, updateSettings } from "../settings.js";
import { parseWav } from "../voice.js";
import { wavBuffer } from "./wav.js";

const API = "https://api.elevenlabs.io/v1";
const RATE = 24000;
export const ELEVEN_MODELS = ["eleven_multilingual_v2", "eleven_v3", "eleven_flash_v2_5"];
const SAMPLE = "Ciao! Questa è la voce dei video di Venturo. Ti piace come suono?";

const month = () => new Date().toISOString().slice(0, 7);
function usage() {
  const u = getSettings().elevenUsage;
  return u?.month === month() ? u.chars : 0;
}
function addUsage(chars) {
  updateSettings({ elevenUsage: { month: month(), chars: usage() + chars } });
}

export function elevenStatus() {
  const s = getSettings();
  return {
    configured: Boolean(s.elevenKey && s.elevenVoiceId),
    hint: s.elevenKey ? `…${String(s.elevenKey).slice(-4)}` : null,
    voiceId: s.elevenVoiceId ?? null,
    voiceName: s.elevenVoiceName ?? null,
    model: s.elevenModel ?? ELEVEN_MODELS[0],
    charsThisMonth: usage(),
  };
}

/** Errori di ElevenLabs spiegati all'utente. */
function explain(status, text) {
  if (status === 401 && /permission|missing_permissions/i.test(text)) return "La chiave di ElevenLabs non ha il permesso «Text to Speech»: nelle impostazioni della chiave attivalo e salva.";
  if (status === 401 && /quota|credits|exceed/i.test(text)) return "ElevenLabs: crediti del mese finiti.";
  if (status === 401) return "ElevenLabs dice che la chiave non è valida: copiala di nuovo intera.";
  if (status === 402 || /paid_plan|subscription|upgrade|commercial/i.test(text)) return "ElevenLabs chiede un piano a pagamento per usare le voci clonate (basta lo Starter).";
  if (status === 404 || /voice_not_found/i.test(text)) return "ElevenLabs non trova la voce: copia di nuovo l'ID della voce (Voices → My Voices → … → Copy voice ID).";
  if (status === 429) return "ElevenLabs: troppe richieste insieme o servizio occupato, riprova tra poco.";
  return `ElevenLabs ha risposto con un errore (HTTP ${status})${text ? `: ${text.slice(0, 160)}` : ""}`;
}

async function eleven(path, { method = "GET", key, json, query } = {}) {
  const u = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(endpoint(u.toString()), {
      method,
      headers: { "xi-api-key": key, ...(json ? { "content-type": "application/json" } : {}) },
      body: json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw Object.assign(new Error("Non riesco a raggiungere ElevenLabs: riprova tra poco."), { network: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(explain(res.status, text)), { status: res.status });
  }
  return res;
}

/** PCM 16 bit mono → { samples, rate } come per un WAV. */
function fromPcm(buf, rate) {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + buf.length, 4); head.write("WAVEfmt ", 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(buf.length, 40);
  return parseWav(Buffer.concat([head, buf]));
}

// ElevenLabs accetta poche richieste insieme (Starter 3, gratis 2): un video con tante scene ne mandava una
// dozzina, quelle in più tornavano 429 e il video usciva con la voce di riserva. Qui passano al massimo 2 per
// volta in tutto il programma; un 429 o un errore momentaneo si riprova dopo una pausa.
const PARALLEL = Math.max(1, Number(process.env.ELEVEN_PARALLEL) || 2);
const RETRY_MS = Number(process.env.ELEVEN_RETRY_MS ?? 1500);
const RETRIES = 4;
let active = 0;
let limit = PARALLEL; // dopo un 429 una richiesta per volta, per un minuto
let calmUntil = 0;
const queue = [];
async function slot(fn) {
  if (limit < PARALLEL && Date.now() > calmUntil) limit = PARALLEL;
  while (active >= limit) await new Promise((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

async function speak(key, voiceId, model, text, speed) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await slot(() => speakOnce(key, voiceId, model, text, speed));
    } catch (err) {
      const busy = err.status === 429 || err.status >= 500 || err.network;
      if (!busy || attempt >= RETRIES) throw err;
      if (err.status === 429) {
        limit = 1;
        calmUntil = Date.now() + 60_000;
      }
      await new Promise((r) => setTimeout(r, RETRY_MS * 2 ** attempt));
    }
  }
}

async function speakOnce(key, voiceId, model, text, speed) {
  const res = await eleven(`/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    key,
    query: { output_format: `pcm_${RATE}` },
    json: {
      text,
      model_id: model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.1, use_speaker_boost: true, speed: Math.min(1.2, Math.max(0.7, speed)) },
    },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2) throw new Error("ElevenLabs ha mandato un audio vuoto");
  addUsage(text.length);
  return fromPcm(buf.length % 2 ? buf.subarray(0, buf.length - 1) : buf, RATE);
}

/** Salva chiave, ID della voce e modello dopo una prova breve (così si sa subito se funziona). Chiave vuota = toglie tutto. */
export async function setElevenVoice({ key, voiceId, model } = {}) {
  const s = getSettings();
  if (key === undefined && !s.elevenKey) throw new Error("Metti la chiave di ElevenLabs.");
  const k = key === undefined ? s.elevenKey : String(key ?? "").replace(/\s+/g, "").replace(/^["'«]+|["'»]+$/g, "");
  if (!k) {
    updateSettings({ elevenKey: null, elevenVoiceId: null, elevenVoiceName: null, ...(s.videoVoice === "eleven" ? { videoVoice: "local" } : {}) });
    return elevenStatus();
  }
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(k)) throw new Error("La chiave di ElevenLabs non sembra giusta: copiala di nuovo intera (di solito inizia con «sk_»).");
  const v = String(voiceId ?? s.elevenVoiceId ?? "").trim();
  if (!/^[A-Za-z0-9]{10,40}$/.test(v)) throw new Error("L'ID della voce non sembra giusto: su ElevenLabs apri Voices → My Voices → … sulla tua voce → Copy voice ID.");
  const m = ELEVEN_MODELS.includes(model) ? model : s.elevenModel ?? ELEVEN_MODELS[0];
  // Il nome della voce si chiede solo se la chiave può leggere le voci; altrimenti basta che la prova funzioni.
  let name = null;
  try {
    const r = await eleven(`/voices/${encodeURIComponent(v)}`, { key: k });
    name = (await r.json())?.name ?? null;
  } catch (err) {
    if (err.network || err.status === 404) throw err;
  }
  await speak(k, v, m, "Prova.", 1);
  updateSettings({ elevenKey: k, elevenVoiceId: v, elevenVoiceName: name ? String(name).slice(0, 60) : null, elevenModel: m, videoVoice: "eleven" });
  return elevenStatus();
}

/** La voce di ElevenLabs è scelta per i video? */
export function elevenVoiceFor() {
  const s = getSettings();
  if (s.videoVoice !== "eleven" || !s.elevenKey || !s.elevenVoiceId) return null;
  return { key: s.elevenKey, voiceId: s.elevenVoiceId, model: s.elevenModel ?? ELEVEN_MODELS[0] };
}

/** Legge le frasi con la voce clonata (2 per volta: i piani piccoli hanno poche richieste in parallelo). */
export async function elevenSentences(voice, sentences, speed) {
  const out = new Array(sentences.length);
  let next = 0;
  const work = async () => {
    while (next < sentences.length) {
      const i = next++;
      const { samples, rate } = await speak(voice.key, voice.voiceId, voice.model, sentences[i], speed);
      out[i] = { text: sentences[i], samples, rate };
    }
  };
  await Promise.all([work(), work()]);
  return out;
}

/** Breve frase di prova con la voce clonata (WAV). */
export async function previewEleven() {
  const v = elevenVoiceFor() ?? (() => {
    const s = getSettings();
    if (!s.elevenKey || !s.elevenVoiceId) throw new Error("prima metti la chiave e l'ID della voce di ElevenLabs");
    return { key: s.elevenKey, voiceId: s.elevenVoiceId, model: s.elevenModel ?? ELEVEN_MODELS[0] };
  })();
  const { samples, rate } = await speak(v.key, v.voiceId, v.model, SAMPLE, 1);
  return wavBuffer(samples, rate);
}
