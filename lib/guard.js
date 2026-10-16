// Protezioni di ogni richiesta, prima di qualsiasi pagina o API:
// - intestazioni di sicurezza (CSP, niente iframe di altri siti, https obbligatorio sul server);
// - l'app risponde solo al suo indirizzo (Host): blocca il "DNS rebinding" di siti malevoli;
// - le modifiche devono partire da pagine dell'app stessa (Origin): blocca il CSRF;
// - configurazione insicura (in cloud senza password): pagina che spiega cosa impostare, mai l'app aperta.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PUBLIC_DIR } from "./paths.js";
import { PORT, LOOPBACK, PUBLIC_URL, PUBLIC_HOST, PUBLIC_ORIGIN, HTTPS, TRUST_PROXY, FAIL_CLOSED, CONFIG_PROBLEMS, MIN_PASSWORD_LENGTH } from "./env.js";

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------- Content-Security-Policy ----------

/** Impronta dello script "importmap" di index.html (l'unico script scritto dentro la pagina). */
function importmapHash() {
  try {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
    const m = html.match(/<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return null;
    // Il browser calcola l'impronta sul testo con gli a capo normalizzati.
    return `'sha256-${crypto.createHash("sha256").update(m[1].replace(/\r\n?/g, "\n"), "utf8").digest("base64")}'`;
  } catch {
    return null;
  }
}
const IMPORTMAP = importmapHash();

export const CSP = [
  "default-src 'self'",
  `script-src 'self'${IMPORTMAP ? ` ${IMPORTMAP}` : ""}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:", // ascolto di prova delle voci dei video
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

export function securityHeaders(req, res, next) {
  res.set({
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin", // l'indirizzo di ritorno da cTrader contiene il codice di accesso
  });
  if (HTTPS) res.set("Strict-Transport-Security", "max-age=31536000");
  if (req.path.startsWith("/api/") || req.path.startsWith("/ctrader/")) res.set("Cache-Control", "no-store");
  next();
}

// ---------- configurazione insicura ----------

function configPage() {
  const lines = CONFIG_PROBLEMS.map((p) => `<li>${escHtml(p)}</li>`).join("");
  const lan = !LOOPBACK && !PUBLIC_URL;
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>App da configurare</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1420;color:#e8ecf4;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:560px;line-height:1.5}h1{font-size:1.4rem}code{background:#1c2436;padding:2px 6px;border-radius:4px}li{margin:4px 0}</style></head>
<body><main><h1>🔒 L'app non è ancora protetta</h1>
<p>Per sicurezza non la apro finché non ha una password:</p><ul>${lines}</ul>
<p><b>Cosa fare:</b> imposta la variabile <code>APP_PASSWORD</code> con una password di almeno ${MIN_PASSWORD_LENGTH} caratteri e riavvia.</p>
<p>Su Railway: apri il servizio → <b>Variables</b> → <b>New Variable</b>, nome <code>APP_PASSWORD</code>, poi salva: il servizio ripartirà da solo.</p>
${lan ? `<p>Se vuoi usare l'app solo da questo computer, togli invece la variabile <code>HOST</code>.</p>` : ""}
</main></body></html>`;
}

/** Con una configurazione insicura ogni richiesta (tranne /healthz) riceve la pagina che spiega cosa impostare. */
export function failClosed(req, res, next) {
  if (!FAIL_CLOSED) return next();
  res.set("Cache-Control", "no-store");
  if (req.path.startsWith("/api/")) {
    return res.status(503).json({ error: `L'app non è ancora protetta: ${CONFIG_PROBLEMS.join(" ")} Imposta la variabile APP_PASSWORD con una password di almeno ${MIN_PASSWORD_LENGTH} caratteri e riavvia.` });
  }
  res.status(503).type("html").send(configPage());
}

// ---------- indirizzo (Host) ----------

const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const firstValue = (h) => String(h ?? "").split(",")[0].trim().toLowerCase();

/**
 * Sul Mac: solo localhost / 127.0.0.1 (come sempre). Sul server: solo l'indirizzo pubblico (più localhost per i
 * controlli fatti dalla macchina stessa). Dietro un proxy noto vale anche l'X-Forwarded-Host che il proxy imposta.
 * In rete locale con password (HOST=0.0.0.0, senza PUBLIC_URL) non si controlla, come prima.
 */
export function hostCheck(req, res, next) {
  if (!LOOPBACK && !PUBLIC_URL) return next();
  const host = String(req.headers.host ?? "").toLowerCase();
  if (LOCAL_HOSTS.has(host)) return next();
  if (PUBLIC_HOST && (host === PUBLIC_HOST || (TRUST_PROXY != null && firstValue(req.headers["x-forwarded-host"]) === PUBLIC_HOST))) return next();
  if (!PUBLIC_URL) return res.status(403).send("Accesso consentito solo da questo computer.");
  if (req.path.startsWith("/api/")) return res.status(403).json({ error: `Apri l'app dal suo indirizzo: ${PUBLIC_URL}` });
  res.status(403).type("html").send(`<!doctype html><meta charset="utf-8"><title>Indirizzo sbagliato</title><p>Apri l'app dal suo indirizzo: <a href="${escHtml(PUBLIC_URL)}/">${escHtml(PUBLIC_URL)}</a></p>`);
}

// ---------- richieste da altri siti (CSRF) ----------

/** Le richieste che cambiano qualcosa, se dichiarano da dove arrivano (Origin), devono arrivare dall'app. */
export function originCheck(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.get("origin");
  if (!origin) return next(); // es. curl o vecchi browser: serve comunque il cookie dell'accesso
  const host = String(req.headers.host ?? "").toLowerCase();
  const allowed = new Set();
  if (PUBLIC_ORIGIN) allowed.add(PUBLIC_ORIGIN);
  if (!PUBLIC_ORIGIN || LOCAL_HOSTS.has(host)) allowed.add(`${req.protocol}://${host}`);
  if (!allowed.has(origin.toLowerCase())) return res.status(403).json({ error: "Richiesta da un altro sito bloccata." });
  next();
}
