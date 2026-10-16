// Voci di Google per la voce narrante dei video (Cloud Text-to-Speech, voci "Chirp 3 HD": molto naturali).
// Chiave API dell'utente (console.cloud.google.com, con "Cloud Text-to-Speech API" attiva e la fatturazione collegata).
// Google regala 1 milione di caratteri al mese per queste voci: contiamo i caratteri e oltre 950.000 nel mese si torna
// alla voce gratuita del server, così l'utente non paga mai senza saperlo. L'elenco delle voci si chiede a Google
// (niente nomi scritti a mano) e si ricorda nelle impostazioni.
import { call } from "./http.js";
import { getSettings, updateSettings } from "../settings.js";
import { parseWav } from "../voice.js";
import { wavBuffer } from "./wav.js";

const API = "https://texttospeech.googleapis.com/v1";
export const FREE_CHARS = 1_000_000;
const SAFE_CHARS = 950_000;
const SAMPLE = "Ciao! Sono la voce dei tuoi video. Ti piace come suono? Seguici su Venturo.";
const ENABLE_URL = "https://console.cloud.google.com/apis/library/texttospeech.googleapis.com";

const month = () => new Date().toISOString().slice(0, 7);
function usage() {
  const u = getSettings().ttsUsage;
  return u?.month === month() ? u.chars : 0;
}
function addUsage(chars) {
  updateSettings({ ttsUsage: { month: month(), chars: usage() + chars } });
}

export function voiceStatus() {
  const s = getSettings();
  return {
    google: { configured: Boolean(s.googleTtsKey), hint: s.googleTtsKey ? `…${String(s.googleTtsKey).slice(-4)}` : null },
    voices: s.googleVoices ?? [],
    selected: s.videoVoice ?? "local",
    usage: { chars: usage(), free: FREE_CHARS },
  };
}

/** Errori di Google spiegati all'utente (attivare l'API, la fatturazione, chiave limitata ad altre API). */
function explain(err) {
  const body = JSON.stringify(err.body ?? "");
  if (err.network) return "Non riesco a raggiungere Google: riprova tra poco.";
  if (/API_KEY_INVALID/.test(body) || err.status === 400 && /API key/i.test(err.message)) return "Google dice che la chiave non è valida: copiala di nuovo intera.";
  if (/SERVICE_DISABLED|has not been used|is disabled/i.test(body)) return `Nel progetto della chiave l'API «Cloud Text-to-Speech» non è attiva: aprila da ${ENABLE_URL}, premi Abilita (Enable), aspetta un minuto e riprova.`;
  if (/BILLING/i.test(body)) return "Google chiede di collegare la fatturazione al progetto (serve una carta, ma il primo milione di caratteri al mese è gratis): console.cloud.google.com → Fatturazione.";
  if (/API_KEY_SERVICE_BLOCKED|blocked/i.test(body)) return "La chiave è limitata ad altre API: nelle impostazioni della chiave aggiungi «Cloud Text-to-Speech API» tra le API consentite.";
  if (err.status === 429) return "Google: troppe richieste in questo momento, riprova tra poco.";
  return `Google ha risposto con un errore: ${err.message}`;
}

async function google(path, opts) {
  try {
    return await call(`${API}${path}`, { ...opts, timeoutMs: 60_000 });
  } catch (err) {
    throw Object.assign(new Error(explain(err)), { status: err.status, network: err.network });
  }
}

/** Voci italiane di Google: prima le Chirp 3 HD (le più naturali), con il genere. */
async function listVoices(key) {
  const r = await google("/voices", { headers: { "x-goog-api-key": key }, query: { languageCode: "it-IT" } });
  const all = (r.voices ?? []).filter((v) => (v.languageCodes ?? []).includes("it-IT") && v.name);
  const best = all.filter((v) => /Chirp3-HD/i.test(v.name));
  return (best.length ? best : all).map((v) => ({ name: v.name, gender: v.ssmlGender === "MALE" ? "uomo" : v.ssmlGender === "FEMALE" ? "donna" : "" }))
    .sort((a, b) => a.gender.localeCompare(b.gender) || a.name.localeCompare(b.name));
}

/** Salva la chiave dopo aver chiesto a Google l'elenco delle voci (così si sa subito se funziona). */
export async function setGoogleTtsKey(key) {
  const k = String(key ?? "").replace(/\s+/g, "").replace(/^["'«]+|["'»]+$/g, "");
  if (!k) {
    updateSettings({ googleTtsKey: null, googleVoices: [], videoVoice: "local" });
    return voiceStatus();
  }
  if (!/^[A-Za-z0-9._-]{20,300}$/.test(k)) throw new Error("La chiave di Google non sembra giusta: copiala di nuovo intera (di solito inizia con «AIza»).");
  const voices = await listVoices(k);
  if (!voices.length) throw new Error("Google non ha voci italiane per questa chiave: riprova tra qualche minuto.");
  const current = getSettings().videoVoice;
  const keep = voices.some((v) => v.name === current);
  updateSettings({ googleTtsKey: k, googleVoices: voices, videoVoice: keep ? current : (voices.find((v) => v.gender === "uomo") ?? voices[0]).name });
  return voiceStatus();
}

/** Voce dei video: "local" (gratuita, sul server) oppure il nome di una voce di Google. */
export function setVideoVoice(name) {
  const n = String(name ?? "");
  const s = getSettings();
  if (n !== "local" && !(s.googleVoices ?? []).some((v) => v.name === n)) throw new Error("voce sconosciuta: scegline una dall'elenco");
  updateSettings({ videoVoice: n });
  return voiceStatus();
}

let rateUnsupported = false; // alcune voci non accettano la velocità: dopo il primo rifiuto non la si manda più

async function speak(key, name, text, speed) {
  const body = { input: { text }, voice: { languageCode: "it-IT", name }, audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24000, ...(rateUnsupported ? {} : { speakingRate: speed }) } };
  let r;
  try {
    r = await call(`${API}/text:synthesize`, { method: "POST", headers: { "x-goog-api-key": key }, json: body, timeoutMs: 60_000 });
  } catch (err) {
    if (!rateUnsupported && err.status === 400 && /speaking.?rate|speakingRate|not supported/i.test(err.message)) {
      rateUnsupported = true;
      return speak(key, name, text, speed);
    }
    throw Object.assign(new Error(explain(err)), { status: err.status });
  }
  addUsage(text.length);
  return parseWav(Buffer.from(r.audioContent ?? "", "base64"));
}

/** La voce di Google è scelta e ci sono ancora caratteri gratuiti per questi testi? */
export function googleVoiceFor(chars) {
  const s = getSettings();
  if (!s.googleTtsKey || !s.videoVoice || s.videoVoice === "local") return null;
  if (usage() + chars > SAFE_CHARS) return { exhausted: true };
  return { key: s.googleTtsKey, name: s.videoVoice };
}

/** Legge le frasi con la voce di Google (3 per volta). Restituisce [{ text, samples, rate }]. */
export async function googleSentences(voice, sentences, speed) {
  const out = new Array(sentences.length);
  let next = 0;
  const work = async () => {
    while (next < sentences.length) {
      const i = next++;
      const { samples, rate } = await speak(voice.key, voice.name, sentences[i], speed);
      out[i] = { text: sentences[i], samples, rate };
    }
  };
  await Promise.all([work(), work(), work()]);
  return out;
}

/** Breve frase di prova per ascoltare una voce prima di sceglierla (WAV). */
export async function previewVoice(name) {
  const s = getSettings();
  if (!s.googleTtsKey) throw new Error("prima metti la chiave di Google");
  if (!(s.googleVoices ?? []).some((v) => v.name === name)) throw new Error("voce sconosciuta");
  const { samples, rate } = await speak(s.googleTtsKey, name, SAMPLE, 1.05);
  return wavBuffer(samples, rate);
}
