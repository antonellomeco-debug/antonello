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
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: "Chiave non valida: controlla di averla copiata tutta." };
    if (err instanceof Anthropic.PermissionDeniedError) return { ok: false, error: "La chiave non ha i permessi necessari." };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, error: "Impossibile raggiungere Claude: controlla la connessione a internet." };
    return { ok: false, error: `Verifica non riuscita: ${err.message}` };
  }
}

export const MISSING_KEY = "Manca la chiave di Claude: inseriscila in ⚙️ Impostazioni (in basso a sinistra).";
