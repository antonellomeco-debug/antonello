// Email dei report settimanali con Resend (resend.com): un'API su https, perché Railway (piano Hobby) blocca le porte
// SMTP. Chiave dell'utente (`resendKey`, mai mostrata per intero) e indirizzo a cui mandare i report (`reportEmail`) in
// settings.json, solo dall'interfaccia. Senza un dominio verificato su Resend si può scrivere solo all'email con cui ci
// si è registrati, dal mittente onboarding@resend.dev.
import { getSettings, updateSettings } from "./settings.js";

const API = () => (process.env.RESEND_BASE ?? "https://api.resend.com").replace(/\/+$/, "");
export const DEFAULT_FROM = "Venturo Agenti <onboarding@resend.dev>";
const EMAIL = /^[^\s@<>"',;]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24}$/;
const MAX_BYTES = 30 * 1024 * 1024; // Resend: al massimo 40 MB per email, allegati compresi (in base64)

export function mailStatus() {
  const s = getSettings();
  return {
    configured: Boolean(s.resendKey && s.reportEmail),
    hasKey: Boolean(s.resendKey),
    keyHint: s.resendKey ? `…${String(s.resendKey).slice(-4)}` : null,
    to: s.reportEmail ?? null,
    from: s.reportFrom || DEFAULT_FROM,
    customFrom: Boolean(s.reportFrom),
  };
}

/** Salva chiave, destinatario e (facoltativo) mittente. key "" la toglie; key assente la lascia com'è. */
export function setMailSettings({ key, to, from } = {}) {
  const patch = {};
  if (key !== undefined) {
    const k = String(key ?? "").replace(/\s+/g, "");
    if (k && !/^re_[A-Za-z0-9_-]{8,200}$/.test(k)) throw new Error("La chiave di Resend inizia con «re_»: copiala di nuovo intera.");
    patch.resendKey = k || null;
  }
  if (to !== undefined) {
    const t = String(to ?? "").trim();
    if (t && !EMAIL.test(t)) throw new Error("Email a cui mandare i report: scrivila intera, es. nome@gmail.com");
    patch.reportEmail = t || null;
  }
  if (from !== undefined) {
    const f = String(from ?? "").trim();
    const addr = f.match(/<([^>]+)>$/)?.[1] ?? f;
    if (f && (!EMAIL.test(addr) || f.length > 120 || /[\r\n]/.test(f))) throw new Error("Mittente: un'email del tuo dominio verificato su Resend, es. «Venturo <report@venturo.it>»");
    patch.reportFrom = f || null;
  }
  updateSettings(patch);
  return mailStatus();
}

/** Messaggio d'errore di Resend in italiano semplice. */
function friendly(status, body) {
  const msg = String(body?.message ?? body?.error ?? body ?? "").slice(0, 300);
  if (status === 401 || /api key is invalid|missing api key/i.test(msg)) return "Resend dice che la chiave non è valida: creane una nuova su resend.com → API Keys e incollala nell'app.";
  if (status === 403 && /only send testing emails|verify a domain/i.test(msg)) {
    return "Resend permette di scrivere solo all'email con cui ti sei registrato finché non verifichi un dominio: metti quella come destinatario (o verifica il dominio su resend.com → Domains).";
  }
  if (status === 403 && /restricted/i.test(msg)) return "La chiave di Resend non ha il permesso di inviare: creane una con «Sending access».";
  if (status === 429) return "Resend: troppe email in poco tempo, riprova tra un minuto.";
  return `Resend: ${msg || `errore ${status}`}`;
}

/**
 * Manda un'email al destinatario dei report. attachments: [{ filename, content: Buffer }].
 * Restituisce { id } oppure lancia un Error con un messaggio leggibile.
 */
export async function sendMail({ subject, html, text, attachments = [] }) {
  const s = getSettings();
  if (!s.resendKey) throw new Error("Manca la chiave di Resend: mettila in 📄 Report → Email.");
  if (!s.reportEmail) throw new Error("Manca l'email a cui mandare i report: scrivila in 📄 Report → Email.");
  const files = attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64") }));
  if (files.reduce((n, f) => n + f.content.length, 0) > MAX_BYTES) throw new Error("allegato troppo grande per l'email");
  let res;
  try {
    res = await fetch(`${API()}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${s.resendKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: s.reportFrom || DEFAULT_FROM, to: [s.reportEmail], subject: String(subject).slice(0, 200), html, ...(text ? { text } : {}), ...(files.length ? { attachments: files } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new Error(`Resend non raggiungibile (${err.name === "TimeoutError" ? "nessuna risposta" : err.cause?.code ?? err.message})`);
  }
  const raw = await res.text();
  let body = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    // risposta non JSON: resta testo
  }
  if (!res.ok) throw new Error(friendly(res.status, body));
  return { id: body?.id ?? null };
}

/** Email di prova dall'interfaccia. */
export async function sendTestMail() {
  const r = await sendMail({
    subject: "Prova: i report degli agenti arriveranno qui",
    html: `<p>Ciao!</p><p>Questa è un'email di prova della tua piattaforma di agenti: da ora i <b>report settimanali in PDF</b> arriveranno a questo indirizzo.</p><p>— Venturo Agenti</p>`,
    text: "Email di prova della tua piattaforma di agenti: da ora i report settimanali in PDF arriveranno a questo indirizzo.",
  });
  return { ...r, ...mailStatus() };
}
