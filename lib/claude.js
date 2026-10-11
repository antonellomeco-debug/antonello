// Client Claude condiviso. La chiave inserita nell'app ha la precedenza su ANTHROPIC_API_KEY.
import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "./settings.js";

let cached = { key: undefined, client: null };

function apiKey() {
  return getSettings().anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
}

export function hasCredentials() {
  return Boolean(apiKey() || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function keyStatus() {
  const app = getSettings().anthropicApiKey;
  const key = apiKey();
  return {
    ready: hasCredentials(),
    source: app ? "app" : process.env.ANTHROPIC_API_KEY ? "env" : process.env.ANTHROPIC_AUTH_TOKEN ? "token" : null,
    hint: key ? `…${key.slice(-4)}` : null,
  };
}

export function getClient() {
  const key = apiKey();
  if (!cached.client || cached.key !== key) {
    cached = { key, client: key ? new Anthropic({ apiKey: key }) : new Anthropic() };
  }
  return cached.client;
}

/** Controlla una chiave senza consumare token (elenco modelli). */
export async function verifyKey(key) {
  try {
    await new Anthropic({ apiKey: key, maxRetries: 1, timeout: 15_000 }).models.list({ limit: 1 });
    return { ok: true };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, error: "Chiave non valida: controlla di averla copiata tutta (o che non sia scaduta)." };
    }
    return { ok: false, error: friendlyError(err) };
  }
}

/** Toglie spazi, virgolette e caratteri invisibili che a volte si copiano insieme alla chiave. */
export function cleanKey(raw) {
  return String(raw ?? "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
}

/** Traduce gli errori dell'API di Claude in messaggi chiari in italiano. */
export function friendlyError(err) {
  const msg = String(err?.message ?? err);
  if (err instanceof Anthropic.APIConnectionError) return "Impossibile raggiungere Claude: controlla la connessione a internet.";
  if (!(err instanceof Anthropic.APIError)) return msg;
  if (/organization has been disabled|organization_on_hold/i.test(msg)) {
    return "Il tuo account Anthropic è sospeso: non dipende dal programma né dalla chiave. Puoi chiedere la riattivazione su console.anthropic.com/appeal oppure scrivere al supporto da support.anthropic.com.";
  }
  if (/credit balance/i.test(msg)) return "Credito di Claude esaurito: aggiungilo su console.anthropic.com → Billing, poi riprova.";
  if (/workspace-id/i.test(msg)) return "Questa chiave va creata per un solo workspace: creane una nuova scegliendo il workspace «Default» e incollala in ⚙️ Impostazioni.";
  switch (err.status) {
    case 401: return "La chiave di Claude non funziona più (scaduta o disattivata): creane una nuova e incollala in ⚙️ Impostazioni.";
    case 403: return "La chiave di Claude non ha i permessi necessari: creane una nuova in console.anthropic.com.";
    case 429: return "Troppe richieste a Claude in poco tempo: riprova tra un minuto.";
    case 529: return "Claude è momentaneamente sovraccarico: riprova tra poco.";
  }
  if (err.status >= 500) return "Claude ha avuto un problema temporaneo: riprova tra poco.";
  return msg;
}

export const MISSING_KEY = "Manca la chiave di Claude: inseriscila in ⚙️ Impostazioni (in basso a sinistra).";
