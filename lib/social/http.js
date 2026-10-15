// Chiamate alle API dei social (Instagram, Threads, LinkedIn, X) e dell'IA per le immagini.
// SOCIAL_API_BASE (solo per le prove): tutti gli indirizzi https://host/percorso diventano
// <SOCIAL_API_BASE>/host/percorso, cioè vanno al finto server di test/helpers/fake-social.js.
const FAKE = process.env.SOCIAL_API_BASE?.replace(/\/+$/, "");

export function endpoint(url) {
  if (!FAKE) return url;
  const u = new URL(url);
  return `${FAKE}/${u.host}${u.pathname}${u.search}`;
}

/** Messaggio d'errore leggibile dalle risposte dei vari social. */
function errorText(body, status) {
  if (body && typeof body === "object") {
    const e = body.error;
    const parts = [
      typeof e === "object" ? (e.error_user_msg ?? e.message) : null,
      body.error_description,
      typeof e === "string" ? e : null,
      body.detail,
      body.title,
      body.message,
      Array.isArray(body.errors) ? body.errors.map((x) => x.message ?? x.detail).filter(Boolean).join("; ") : null,
    ].filter(Boolean);
    if (parts.length) return `${parts[0]} (HTTP ${status})`;
  }
  return `HTTP ${status}${typeof body === "string" && body.trim() ? `: ${body.trim().slice(0, 200)}` : ""}`;
}

/**
 * Richiesta HTTP con risposta JSON. form = corpo application/x-www-form-urlencoded, json = corpo JSON,
 * body = corpo già pronto (Buffer, FormData). query = parametri aggiunti all'indirizzo.
 * Restituisce { data, headers, status }; con una risposta di errore lancia un Error con status e body.
 */
export async function request(url, { method = "GET", query, form, json, body, headers = {}, token, timeoutMs = 120_000 } = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) u.searchParams.set(k, String(v));
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload = body;
  if (form) {
    payload = new URLSearchParams(Object.entries(form).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
  } else if (json !== undefined) {
    payload = JSON.stringify(json);
    h["content-type"] = "application/json";
  }
  let res;
  try {
    res = await fetch(endpoint(u.toString()), { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = err.name === "TimeoutError" ? "nessuna risposta in tempo" : err.cause?.code ?? err.message;
    throw Object.assign(new Error(`${u.host} non raggiungibile (${why})`), { network: true });
  }
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // risposta non JSON (es. caricamento di un file): resta testo
  }
  if (!res.ok) throw Object.assign(new Error(errorText(data, res.status)), { status: res.status, body: data });
  return { data, headers: res.headers, status: res.status };
}

/** Come request, ma restituisce solo i dati. */
export const call = async (url, opts) => (await request(url, opts)).data;

const POLL_MS = Number(process.env.SOCIAL_POLL_MS) || 5000;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Pausa tra due controlli di un video in lavorazione (più corta nelle prove). */
export const pollPause = (factor = 1) => sleep(POLL_MS * factor);
