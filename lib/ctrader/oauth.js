// Accesso all'account cTrader (OAuth): l'utente accede sul sito di cTrader e autorizza l'app;
// il codice ricevuto viene scambiato con i token. Il refresh token cambia a ogni rinnovo.
export const AUTH_URL = process.env.CTRADER_AUTH_URL ?? "https://openapi.ctrader.com/apps/auth";
export const TOKEN_URL = process.env.CTRADER_TOKEN_URL ?? "https://openapi.ctrader.com/apps/token";

export function authorizationUrl({ clientId, redirectUri }) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: "trading" });
  return `${AUTH_URL}?${q}`;
}

/** Estrae il codice da un indirizzo incollato dall'utente (o accetta il codice da solo). */
export function codeFromInput(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.searchParams.get("code");
  } catch {
    return /^[\w.~-]{10,}$/.test(text) ? text : null;
  }
}

async function tokenRequest(params) {
  let res;
  try {
    res = await fetch(`${TOKEN_URL}?${new URLSearchParams(params)}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error("Impossibile raggiungere cTrader per l'accesso: controlla la connessione a internet.");
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Risposta inattesa da cTrader (${res.status}).`);
  }
  // Nomi dei campi: cTrader usa camelCase; accettiamo anche lo stile OAuth classico.
  const accessToken = body.accessToken ?? body.access_token;
  const refreshToken = body.refreshToken ?? body.refresh_token;
  const expiresIn = Number(body.expiresIn ?? body.expires_in ?? 0);
  if (!res.ok || !accessToken) {
    const why = body.description ?? body.error_description ?? body.errorCode ?? body.error ?? `errore ${res.status}`;
    throw new Error(`cTrader ha rifiutato l'accesso: ${why}`);
  }
  return {
    accessToken,
    refreshToken,
    // Se cTrader non indica la durata, rinnoviamo comunque dopo 7 giorni.
    expiresAt: Date.now() + (expiresIn > 0 ? expiresIn : 7 * 86400) * 1000,
  };
}

export function exchangeCode({ clientId, clientSecret, redirectUri, code }) {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret });
}

export function refreshTokens({ clientId, clientSecret, refreshToken }) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
}
