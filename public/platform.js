// Aspetto dell'app (colori, nome, logo, testo, angoli), tasti rapidi e idee di Orion (lib/platform.js).
// L'aspetto vale per tutti i dispositivi; i colori si applicano come variabili del foglio di stile.

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (iso) => new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const PRESET_LABEL = { notte: "Notte (originale)", oceano: "Oceano", smeraldo: "Smeraldo", tramonto: "Tramonto", oro: "Oro", venturo: "Venturo" };
const VIEW_LABEL = { office: "Ufficio", chat: "Chat", approvals: "Approvazioni", notes: "Bacheca", portfolio: "Portafoglio", costs: "Spesa", social: "Social", broker: "Broker", building: "Universo", log: "Attività" };

let api = null;
let actions = null; // { chat(text), showView(view), agentName(id) }
let data = null;
const DEFAULT_TITLE = document.title;
const DEFAULT_LOGO = $(".logo")?.textContent;

export function initPlatform(apiFn, acts) {
  api = apiFn;
  actions = acts;
  for (const el of [$("#office-shortcuts"), $("#chat-shortcuts")]) {
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-shortcut]");
      if (b) runShortcut(b.dataset.shortcut, b);
    });
  }
  // Nella chat i tasti non tolgono il cursore al campo (come i suggerimenti): sul telefono la tastiera resta aperta.
  $("#chat-shortcuts").addEventListener("mousedown", (e) => e.target.closest("button") && e.preventDefault());
  $("#look-preset").addEventListener("change", (e) => act(() => api("/api/platform/look", { method: "PUT", body: JSON.stringify({ preset: e.target.value }) })));
  $("#look-reset").addEventListener("click", () => confirm("Tornare all'aspetto originale (colori, nome e logo)?") && act(() => api("/api/platform/look", { method: "PUT", body: JSON.stringify({ reset: true }) })));
  $("#platform-box").addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.delShortcut) {
      if (confirm("Eliminare questo tasto?")) act(() => api(`/api/platform/shortcuts/${encodeURIComponent(b.dataset.delShortcut)}`, { method: "DELETE" }));
    } else if (b.dataset.delIdea) {
      if (confirm("Eliminare questa idea?")) act(() => api(`/api/platform/ideas/${encodeURIComponent(b.dataset.delIdea)}`, { method: "DELETE" }));
    } else if (b.dataset.copyIdea) {
      const i = data.ideas.find((x) => x.id === b.dataset.copyIdea);
      await navigator.clipboard?.writeText(`${i.title}\n\n${i.text}`).catch(() => {});
      b.textContent = "Copiata";
      setTimeout(() => (b.textContent = "Copia"), 1500);
    }
  });
}

async function act(fn) {
  try {
    data = await fn();
    applyPlatform();
  } catch (err) {
    alert(err.message);
  }
}

export async function loadPlatform() {
  try {
    data = await api("/api/platform");
    applyPlatform();
  } catch {
    // senza i dati della piattaforma l'app resta con l'aspetto originale
  }
}

function applyPlatform() {
  if (!data) return;
  const { look } = data;
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(look.vars)) root.setProperty(name, value);
  root.setProperty("--radius", `${look.radius}px`);
  document.body.style.fontSize = look.fontScale === 1 ? "" : `${Math.round(14 * look.fontScale * 10) / 10}px`;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", look.vars["--bg"]);
  document.title = look.title || DEFAULT_TITLE;
  const logo = $(".logo");
  if (logo) logo.textContent = look.logo || DEFAULT_LOGO;
  renderShortcuts();
  renderSettings();
}

function renderShortcuts() {
  const html = data.shortcuts.map((s) => `<button type="button" class="chip shortcut" data-shortcut="${esc(s.id)}" title="${esc(describe(s))}">${esc(s.icon)} ${esc(s.label)}</button>`).join("");
  for (const id of ["#office-shortcuts", "#chat-shortcuts"]) {
    $(id).innerHTML = html;
    $(id).classList.toggle("hidden", !data.shortcuts.length);
  }
}

function describe(s) {
  if (s.action === "chat") return `Scrive a Orion: ${s.value}`;
  if (s.action === "run_agent") return `Fa lavorare ${actions.agentName(s.value)}`;
  if (s.action === "link") return `Apre ${s.value}`;
  return `Apre la sezione ${VIEW_LABEL[s.value] ?? s.value}`;
}

async function runShortcut(id, btn) {
  const s = data?.shortcuts.find((x) => x.id === id);
  if (!s) return;
  if (s.action === "chat") return actions.chat(s.value);
  if (s.action === "view") return actions.showView(s.value);
  if (s.action === "link") return window.open(s.value, "_blank", "noopener");
  btn.disabled = true;
  try {
    await api(`/api/agents/${encodeURIComponent(s.value)}/run`, { method: "POST" });
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
}

function renderSettings() {
  const sel = $("#look-preset");
  if (document.activeElement !== sel) {
    sel.innerHTML = data.presets.map((p) => `<option value="${esc(p)}" ${p === data.look.preset ? "selected" : ""}>${esc(PRESET_LABEL[p] ?? p)}</option>`).join("");
  }
  $("#platform-shortcuts").innerHTML = data.shortcuts.length
    ? `<h4 class="platform-h">⚡ Tasti rapidi</h4>${data.shortcuts.map((s) => `<div class="platform-row"><span>${esc(s.icon)} <b>${esc(s.label)}</b> <small class="meta">${esc(describe(s))}</small></span><button type="button" class="btn small ghost" data-del-shortcut="${esc(s.id)}" aria-label="Elimina">✕</button></div>`).join("")}`
    : `<p class="hint">Nessun tasto rapido: chiedi a Orion di crearne (compaiono nella chat e in cima all'Ufficio).</p>`;
  $("#platform-ideas").innerHTML = data.ideas.length
    ? data.ideas.map((i) => `<details class="platform-idea"><summary><b>${esc(i.title)}</b> <small class="meta">${when(i.at)}</small></summary><p class="idea-text">${esc(i.text)}</p><div class="row"><button type="button" class="btn small" data-copy-idea="${esc(i.id)}">Copia</button><button type="button" class="btn small ghost" data-del-idea="${esc(i.id)}">Elimina</button></div></details>`).join("")
    : `<p class="hint">Ancora nessuna idea.</p>`;
}

/** Evento "platform" dal server (Orion ha cambiato qualcosa): si ricarica tutto. */
export const onPlatformEvent = loadPlatform;
