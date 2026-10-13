// Impostazioni che arrivano dalle variabili d'ambiente. Sul Mac non ne serve nessuna: l'app resta su
// http://localhost:3000 senza password. Sul server in cloud (es. Railway) si impostano nel servizio:
// APP_PASSWORD (obbligatoria), PUBLIC_URL (su Railway si ricava da sola), TRUST_PROXY, UPDATER.
import { DATA_DIR } from "./paths.js";

const env = process.env;

export const PORT = Number(env.PORT ?? 3000);
// Solo questo computer può aprire l'app; HOST=0.0.0.0 la rende raggiungibile da fuori (serve APP_PASSWORD).
export const HOST = env.HOST ?? "127.0.0.1";
export const LOOPBACK = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";

/** Indirizzo pubblico dell'app (senza "/" finale), o null sul Mac. */
function publicUrl() {
  let raw = (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : "") || env.RENDER_EXTERNAL_URL || "").trim();
  if (!raw) return { url: null };
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`; // es. "agenti.up.railway.app" senza https://
  try {
    const u = new URL(raw);
    if (u.pathname !== "/" && u.pathname !== "") return { url: null, problem: "PUBLIC_URL deve essere solo l'indirizzo del sito, senza percorso (es. https://nome.up.railway.app)." };
    return { url: u.origin };
  } catch {
    return { url: null, problem: `PUBLIC_URL non è un indirizzo valido (${raw.slice(0, 80)}).` };
  }
}
const pub = publicUrl();
export const PUBLIC_URL = pub.url;
export const CLOUD = Boolean(PUBLIC_URL) || Boolean(pub.problem);
export const PUBLIC_ORIGIN = PUBLIC_URL; // origin = schema://host[:porta], uguale all'indirizzo pubblico
export const PUBLIC_HOST = PUBLIC_URL ? new URL(PUBLIC_URL).host : null;
export const HTTPS = Boolean(PUBLIC_URL?.startsWith("https://"));

export const ON_RAILWAY = Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PROJECT_ID);
// Sul server i dati devono stare in un volume, altrimenti spariscono a ogni nuova versione.
export const VOLUME_OK = !(
  (ON_RAILWAY && !env.RAILWAY_VOLUME_MOUNT_PATH && !env.AGENTI_DATA_DIR) ||
  (env.RENDER && !env.AGENTI_DATA_DIR)
);
export { DATA_DIR };

// ---------- password ----------
export const MIN_PASSWORD_LENGTH = 10;
export const APP_PASSWORD = env.APP_PASSWORD ?? "";
// Con APP_PASSWORD, o sul server in cloud, l'app chiede la password.
export const AUTH_ENABLED = Boolean(APP_PASSWORD) || CLOUD;

/**
 * Motivi per cui l'app NON deve partire senza protezione (pagina "da configurare", mai l'app aperta a tutti):
 * - in cloud senza APP_PASSWORD, o con una password troppo corta;
 * - raggiungibile da altri computer (HOST non locale) senza password.
 */
export const CONFIG_PROBLEMS = [
  pub.problem,
  AUTH_ENABLED && !APP_PASSWORD ? "Manca la password dell'app." : null,
  APP_PASSWORD && APP_PASSWORD.length < MIN_PASSWORD_LENGTH ? `La password dell'app è troppo corta (servono almeno ${MIN_PASSWORD_LENGTH} caratteri).` : null,
  !LOOPBACK && !APP_PASSWORD && !CLOUD ? "L'app è raggiungibile da altri computer ma non ha una password." : null,
].filter(Boolean);
export const FAIL_CLOSED = CONFIG_PROBLEMS.length > 0;

// ---------- proxy (Railway, Render, nginx…) ----------
/**
 * TRUST_PROXY = numero di proxy davanti all'app (es. 1) oppure i nomi/indirizzi accettati da Express
 * ("loopback", "10.0.0.0/8"…). Serve per sapere l'indirizzo vero di chi si collega (limite dei tentativi
 * per indirizzo) e se la richiesta è arrivata in https. Mai "true": chiunque potrebbe fingere un indirizzo.
 */
function trustProxy() {
  const v = String(env.TRUST_PROXY ?? "").trim();
  if (!v || v === "0" || v.toLowerCase() === "false") return null;
  if (/^\d+$/.test(v)) return Number(v);
  if (v.toLowerCase() === "true") {
    console.warn("[avviso] TRUST_PROXY=true non è sicuro: uso 1 (un solo proxy davanti all'app).");
    return 1;
  }
  return v;
}
export const TRUST_PROXY = trustProxy();

// ---------- aggiornamenti e versione ----------
// Sul server la nuova versione arriva da GitHub con un nuovo deploy: l'aggiornamento dall'app è spento.
export const UPDATER_ON = !CLOUD && String(env.UPDATER ?? "").toLowerCase() !== "off";
export const UPDATER_OFF_REASON = "Sul server gli aggiornamenti arrivano da soli da GitHub: non serve fare niente.";
/** Codice della versione indicato dal servizio di hosting (Railway lo imposta a ogni deploy). */
export const ENV_COMMIT = (env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT || env.RENDER_GIT_COMMIT || "").trim().toLowerCase() || null;

// ---------- cTrader ----------
// Indirizzo a cui cTrader rimanda il browser dopo l'accesso: va aggiunto tra i "Redirect URI" dell'app cTrader.
export const REDIRECT_URI = `${PUBLIC_URL ?? `http://localhost:${PORT}`}/ctrader/callback`;

// ---------- sessione ----------
// "__Host-" vincola il cookie a questo sito (solo https); in locale (http) basta un nome normale.
export const COOKIE_NAME = HTTPS ? "__Host-agenti" : "agenti_sid";
