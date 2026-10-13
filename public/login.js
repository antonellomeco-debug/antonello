// Pagina di accesso: manda la password al server e poi apre l'app (o la pagina da cui si arrivava).
// File a parte (niente script dentro la pagina) per rispettare la Content-Security-Policy del server.
const $ = (id) => document.getElementById(id);
const form = $("login-form");
const pass = $("password");
const enter = $("enter");
const error = $("error");
const toggle = $("toggle");

/** Dove andare dopo l'accesso: solo un percorso di questo sito ("/…"), mai un altro sito né di nuovo il login. */
function safeNext(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  try {
    const u = new URL(raw, location.origin);
    // "/.//sito.it" diventa "//sito.it": sarebbe un altro sito.
    if (u.origin !== location.origin || u.pathname.startsWith("//") || u.pathname === "/login" || u.pathname === "/login.html") return "/";
    return u.pathname + u.search + u.hash;
  } catch {
    return "/";
  }
}
let next = safeNext(new URLSearchParams(location.search).get("next"));
// Il pezzo dopo # (es. /#broker) il server non lo vede: lo si riattacca qui.
if (location.hash && !next.includes("#")) next += location.hash;

// Già dentro (o password non richiesta, come sul Mac): si va direttamente all'app.
fetch("/api/session", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : null))
  .then((s) => {
    if (s && (!s.auth || s.loggedIn)) location.replace(next);
  })
  .catch(() => {});

const show = (text) => (error.textContent = text);

toggle.addEventListener("click", () => {
  const visible = pass.type === "password";
  pass.type = visible ? "text" : "password";
  toggle.textContent = visible ? "🙈 Nascondi" : "👁️ Mostra";
  toggle.setAttribute("aria-pressed", String(visible));
  toggle.setAttribute("aria-label", visible ? "Nascondi la password" : "Mostra la password");
  pass.focus();
});

for (const ev of ["keydown", "keyup"]) {
  pass.addEventListener(ev, (e) => $("caps").classList.toggle("hidden", !e.getModifierState?.("CapsLock")));
}

let lockTimer = null;
/** Troppi tentativi: il pulsante resta spento fino allo scadere dell'attesa indicata dal server. */
function lockFor(seconds, text) {
  let left = Math.max(1, Math.ceil(Number(seconds) || 60));
  show(text || `Troppi tentativi: riprova tra ${Math.ceil(left / 60)} minuti`);
  enter.disabled = true;
  clearInterval(lockTimer);
  const tick = () => {
    const m = Math.floor(left / 60);
    const s = String(left % 60).padStart(2, "0");
    enter.textContent = `Riprova tra ${m}:${s}`;
    if (left-- <= 0) {
      clearInterval(lockTimer);
      enter.disabled = false;
      enter.textContent = "Entra";
      show("");
    }
  };
  tick();
  lockTimer = setInterval(tick, 1000);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (enter.disabled) return;
  const password = pass.value;
  if (!password) {
    show("Scrivi la password.");
    pass.focus();
    return;
  }
  enter.disabled = true;
  enter.textContent = "Controllo…";
  show("");
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      credentials: "same-origin",
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) {
      enter.textContent = "Entro…";
      location.replace(next);
      return;
    }
    if (res.status === 429) return lockFor(body.retryAfter ?? res.headers.get("Retry-After"), body.error);
    if (res.status === 401) {
      show(body.error || "Password sbagliata");
      pass.select();
    } else {
      show(body.error || `Il server non ha accettato la richiesta (errore ${res.status}). Riprova tra poco.`);
    }
  } catch {
    show("Server non raggiungibile: controlla la connessione e riprova.");
  }
  enter.disabled = false;
  enter.textContent = "Entra";
});
