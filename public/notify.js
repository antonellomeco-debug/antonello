// 🔔 Notifiche sul telefono (⚙️ Impostazioni): iscrive questo dispositivo alle notifiche del server (lib/push.js).
// Sull'iPhone funzionano solo nell'app installata sulla schermata Home (iOS 16.4 o più recente) e il permesso si
// chiede dentro un tocco.

const $ = (sel) => document.querySelector(sel);
let api = null;
let status = null;

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installed = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;

function keyBytes(base64url) {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || isIos()) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "computer";
}

async function currentSubscription() {
  if (!supported() || location.protocol !== "https:") return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export function initNotify(apiFn) {
  api = apiFn;
  $("#push-on").addEventListener("click", turnOn);
  $("#push-off").addEventListener("click", turnOff);
  $("#push-test").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const r = await api("/api/push/test", { method: "POST" });
      if (!r.sent) alert("Nessun dispositivo ha ricevuto la prova: prova a disattivare e riattivare le notifiche.");
    } catch (err) {
      alert(err.message);
    } finally {
      e.target.disabled = false;
    }
  });
  for (const k of ["approvals", "published", "replies"]) {
    $(`#push-${k}`).addEventListener("change", async (e) => {
      try {
        status = await api("/api/push/prefs", { method: "PUT", body: JSON.stringify({ [k]: e.target.checked }) });
      } catch (err) {
        alert(err.message);
      }
      render();
    });
  }
}

/** Da chiamare all'apertura delle Impostazioni. */
export async function renderNotify() {
  try {
    status = await api("/api/push");
  } catch {
    status = null;
  }
  await render();
}

async function render() {
  const st = $("#push-state");
  const sub = await currentSubscription().catch(() => null);
  const mine = Boolean(sub && status?.devices.some((d) => d.endpoint === sub.endpoint));
  const show = (id, on) => $(id).classList.toggle("hidden", !on);
  show("#push-on", !mine);
  show("#push-off", mine);
  show("#push-test", Boolean(status?.devices.length));
  for (const k of ["approvals", "published", "replies"]) $(`#push-${k}`).checked = Boolean(status?.prefs?.[k]);
  $("#push-replies").disabled = !status?.prefs?.published;
  const n = status?.devices.length ?? 0;
  $("#push-devices").textContent = n ? `Dispositivi con le notifiche: ${status.devices.map((d) => d.label).join(", ")}.` : "";
  $("#push-on").disabled = false;
  if (mine) st.textContent = Notification.permission === "granted" ? "✔ Attive su questo dispositivo." : "⚠️ Iscritto, ma il permesso delle notifiche è spento: riattivalo nelle impostazioni del telefono.";
  else if (location.protocol !== "https:") st.textContent = "Le notifiche funzionano con l'app sul server (indirizzo https), non con il programma sul Mac.";
  else if (isIos() && !installed()) {
    st.textContent = "Su iPhone le notifiche funzionano solo dall'app installata: in Safari tocca Condividi → «Aggiungi alla schermata Home», apri l'app da lì e torna qui.";
    $("#push-on").disabled = true;
  } else if (!supported()) {
    st.textContent = "Questo browser non supporta le notifiche (su iPhone serve iOS 16.4 o più recente).";
    $("#push-on").disabled = true;
  } else if (Notification.permission === "denied") {
    st.textContent = "Le notifiche sono bloccate per questa app: sbloccale nelle impostazioni del telefono (Impostazioni → Notifiche → l'app), poi tocca Attiva.";
  } else st.textContent = "Non attive su questo dispositivo.";
}

async function turnOn(e) {
  const btn = e.target;
  btn.disabled = true;
  try {
    // Il permesso va chiesto subito, dentro il tocco (sull'iPhone non si può chiedere dopo un'attesa).
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Permesso negato: senza il permesso il telefono non mostra le notifiche.");
    const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
    await navigator.serviceWorker.ready;
    status ??= await api("/api/push");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.publicKey) });
    status = await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON(), label: deviceLabel() }) });
    await api("/api/push/test", { method: "POST" }).catch(() => {});
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    render();
  }
}

async function turnOff() {
  try {
    const sub = await currentSubscription();
    if (sub) {
      status = await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe().catch(() => {});
    }
  } catch (err) {
    alert(err.message);
  }
  render();
}
