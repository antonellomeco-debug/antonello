// Service worker dell'app installabile: mostra una pagina chiara quando il server non risponde e le notifiche
// (Web Push, lib/push.js): un tocco sulla notifica apre l'app nella sezione giusta.
// Le pagine dell'app arrivano sempre dalla rete (così dopo un aggiornamento si vede subito la versione nuova);
// se la rete manca si mostra /offline.html, salvata all'installazione. Tutto il resto (/api/*, /login, /ctrader/*,
// /healthz, script, immagini…) non passa di qui: va dritto al server, senza copie salvate.
const CACHE = "agenti-offline-v1"; // cambiare il numero quando cambia offline.html
const OFFLINE_URL = "/offline.html";
const APP_PAGES = new Set(["/", "/index.html"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Cancella le copie delle versioni precedenti.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("agenti-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return; // non è l'apertura di una pagina: nessun intervento
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !APP_PAGES.has(url.pathname)) return; // /login, /ctrader/…: dritto al server
  // Prima la rete; solo se il server non è raggiungibile, la pagina "Server non raggiungibile".
  event.respondWith(fetch(req).catch(async () => (await caches.match(OFFLINE_URL)) ?? Response.error()));
});

// ---------- notifiche ----------

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data?.json() ?? {};
  } catch {
    d = { body: event.data?.text() ?? "" };
  }
  const show = self.registration.showNotification(d.title || "I miei agenti", {
    body: d.body || "",
    tag: d.tag || undefined,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: d.url || "/" },
  });
  // Numerino sull'icona dell'app: cose da approvare e domande aperte.
  const badge = Number.isInteger(d.badge) && self.navigator.setAppBadge ? (d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()) : null;
  event.waitUntil(Promise.all([show, badge && badge.catch(() => {})]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin);
  event.waitUntil(
    (async () => {
      // Link di un social (il post pubblicato): si apre fuori dall'app.
      if (url.origin !== self.location.origin) return self.clients.openWindow(url.href);
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = list.find((c) => new URL(c.url).origin === self.location.origin);
      if (client) {
        client.postMessage({ type: "open", hash: url.hash });
        return client.focus();
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});
