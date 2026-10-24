// Interfaccia: palazzo 3D, gestione di piani/stanze/collegamenti, approvazioni, bacheca, portafoglio,
// attività, chat con il regista ed editor degli agenti.
import { Office3D } from "./office3d.js";
import { VoiceRecorder, recordingSupported, micErrorText, MAX_SECONDS } from "./recorder.js";
import * as speech from "./speech.js";
import { initSocial, loadSocial, renderSocial, renderPostApproval, bindShareButtons } from "./social.js";
import { initCosts, renderCosts, loadCosts } from "./costs.js";
import { initReports, renderReports, loadReports } from "./reports.js";
import { initPlatform, loadPlatform, onPlatformEvent } from "./platform.js";
import { initNotify, renderNotify } from "./notify.js";

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 2) => (n == null ? "—" : Number(n).toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d }));
const time = (iso) => new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
const when = (iso) => new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

// Sessione: se il server non la conosce (versione senza password) l'app funziona come sul Mac.
const DEFAULT_SESSION = { auth: false, loggedIn: true, cloud: false, updater: true, publicUrl: null, volumeOk: true };

const state = {
  office: null, notes: {}, log: [], approvals: [], requests: [], portfolio: null, stats: null,
  approvalsTab: "pending", showRejected: false, // ✅ Approvazioni: scheda scelta e scartate visibili
  chat: { name: "", busy: false, transcript: [], live: "" }, status: {}, view: "office", room: null, editing: null,
  floorFocus: null, broker: null, brokerAccounts: null, session: { ...DEFAULT_SESSION },
};

// Messaggi vocali: stato del riconoscimento sul server, registrazione in corso, invio, lettura della risposta.
const voice = { status: null, rec: null, sending: false, speakTurn: false };

// Telefono (schermo stretto) e schermo touch (niente mouse).
const phoneMQ = matchMedia("(max-width: 860px)");
const touchMQ = matchMedia("(hover: none) and (pointer: coarse)");
// Sezioni che sul telefono stanno dentro "Altro".
const MORE_VIEWS = ["building", "costs", "reports", "social", "portfolio", "broker", "log"];

// ---------- utilità sul palazzo ----------
const B = () => state.office.building;
const floorById = (id) => B().floors.find((f) => f.id === id);
const roomById = (id) => B().rooms.find((r) => r.id === id);
const floorOfRoom = (roomId) => roomById(roomId)?.floor;
/** "1 piano", "3 piani". */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Universo: più palazzi, ogni piano sta in un palazzo.
const palaces = () => B().palaces ?? [];
const palaceById = (id) => palaces().find((p) => p.id === id);
const floorsOf = (palaceId) => B().floors.filter((f) => f.palace === palaceId);
/** Nome del piano, con il palazzo quando ce n'è più d'uno (es. "Piano Tendenze · Palazzo Social"). */
const floorLabel = (f) => (!f ? "" : palaces().length > 1 ? `${f.name} · ${palaceById(f.palace)?.name ?? ""}` : f.name);
/** Agenti e stanze di un palazzo. */
function palaceStats(palaceId) {
  const ids = new Set(floorsOf(palaceId).map((f) => f.id));
  const rooms = B().rooms.filter((r) => ids.has(r.floor));
  const roomIds = new Set(rooms.map((r) => r.id));
  return { floors: ids.size, rooms: rooms.length, agents: state.office.agents.filter((a) => roomIds.has(a.room)).length, roomIds };
}
/** Le opzioni dei piani raggruppate per palazzo (per i menu a tendina). */
function floorOptions(filter = () => true) {
  const opt = (f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`;
  if (palaces().length < 2) return B().floors.filter(filter).map(opt).join("");
  return palaces()
    .map((p) => {
      const fl = floorsOf(p.id).filter(filter);
      return fl.length ? `<optgroup label="${esc(p.name)}">${fl.map(opt).join("")}</optgroup>` : "";
    })
    .join("");
}
/** true se gli agenti del piano `to` leggono le bacheche del piano `from` (stessa regola del server). */
function flowsInto(from, to) {
  if (from === to) return true;
  return B().links.some(
    (l) =>
      l.active &&
      ((l.direction === "both" && ((l.from === from && l.to === to) || (l.from === to && l.to === from))) ||
        (l.direction === "one-way" && l.from === from && l.to === to)),
  );
}
let office3d;

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  // Sessione scaduta: si torna alla pagina di accesso. (Una password sbagliata per un'operazione delicata
  // risponde invece con "stepUp": basta mostrare l'errore.)
  if (res.status === 401 && body.login) goLogin();
  if (!res.ok) throw Object.assign(new Error(body.error ?? res.statusText), { body, status: res.status });
  return body;
}

let leaving = false;
/** Pagina di accesso, con il ritorno al punto in cui si era (solo percorsi di questo sito). */
function goLogin() {
  if (leaving) return;
  leaving = true;
  location.href = `/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
}

/** Chiede al server lo stato della sessione; con un server vecchio (senza /api/session) vale DEFAULT_SESSION. */
async function loadSession() {
  try {
    const res = await fetch("/api/session", { cache: "no-store" });
    if (res.ok) return (state.session = { ...DEFAULT_SESSION, ...(await res.json()) });
    // Solo un server vecchio non conosce /api/session. Un errore del server (es. 502 mentre si riavvia) non deve
    // far dimenticare che serve la password: si tiene lo stato di prima.
    if (res.status === 404) return (state.session = { ...DEFAULT_SESSION });
  } catch {
    // server non raggiungibile: si riprova più tardi
  }
  return null;
}

/** Mostra o nasconde ciò che dipende dalla sessione: avviso sul volume, Esci, aggiornamenti, app sul telefono. */
function applySession() {
  const s = state.session;
  $("#volume-banner").classList.toggle("hidden", s.volumeOk !== false);
  $("#more-logout").classList.toggle("hidden", !s.auth);
  $("#account-box").classList.toggle("hidden", !s.auth);
  $("#phone-box").classList.toggle("hidden", !s.cloud || !s.publicUrl);
  $("#phone-url").textContent = s.publicUrl ?? "";
  $("#update-buttons").classList.toggle("hidden", !s.updater);
  $("#update-note").classList.toggle("hidden", !s.updater);
}

async function logout() {
  await fetch("/api/logout", { method: "POST" }).catch(() => null);
  location.href = "/login";
}

// ---------- caricamento ----------

async function loadOffice() {
  state.office = await api("/api/office");
  for (const a of state.office.agents) state.status[a.id] ??= { status: a.running ? "working" : "idle" };
  const { building, agents, assistant } = state.office;
  resolvePalace();
  updateOfficeSub();
  $("#touch-hint").textContent = touchMQ.matches
    ? "Tocca un agente per il nome, tocca il nome per la scheda"
    : "Passa sopra un agente per il nome, clicca per la scheda";
  $("#chat-title").textContent = `Parla con ${assistant}`;
  $("#nav-chat-label").textContent = assistant;
  $("#key-cta").classList.toggle("hidden", state.office.llmReady);
  $("#badge-settings").classList.toggle("hidden", state.office.llmReady);
  $("#more-settings-badge").classList.toggle("hidden", state.office.llmReady);
  $("#more-settings-state").textContent = state.office.llmReady ? "Chiave di Claude, orario, dati" : "🔑 Claude non è collegato: inserisci la chiave";
  syncMoreBadge();
  if (!office3d) {
    office3d = new Office3D($("#scene"), {
      assistantName: assistant,
      onAgentClick: (id) => openEditor(state.office.agents.find((a) => a.id === id)),
      onFloorFocus: (id) => {
        state.floorFocus = id;
        renderElevator();
      },
      onPalaceClick: (id) => selectPalace(id),
    });
    syncOffice3d();
  }
  // Il palazzo 3D si ricostruisce solo se è cambiato (non a ogni riallineamento con il server).
  const shape = JSON.stringify([state.palace, building, agents.map(({ running, lastRun, ...a }) => a)]);
  if (shape !== state.officeShape) drawScene();
  state.officeShape = shape;
  state.floorFocus = office3d.focused;
  for (const [id, s] of Object.entries(state.status)) office3d.setStatus(id, s.status, s.detail);
  renderPalaceBar();
  renderElevator();
  renderRoster();
  renderFilter();
  if (state.view === "building") renderBuilding();
}

// ---------- universo: quale palazzo si guarda ----------
// state.palace = id del palazzo in vista, oppure null = 🌌 tutto l'universo. Ricordato su ogni dispositivo.
const PALACE_PREF = "agenti.palazzo";

function resolvePalace() {
  const ids = palaces().map((p) => p.id);
  if (state.palace === null) return; // universo
  if (state.palace && ids.includes(state.palace)) return;
  let saved = null;
  try {
    saved = localStorage.getItem(PALACE_PREF);
  } catch {
    // memoria del browser non disponibile
  }
  if (state.palace === undefined && saved === "*") state.palace = null;
  else state.palace = ids.includes(saved) ? saved : ids.length > 1 ? null : ids[0] ?? null;
}

function selectPalace(id) {
  state.palace = id ?? null;
  try {
    localStorage.setItem(PALACE_PREF, id ?? "*");
  } catch {
    // vale fino alla chiusura
  }
  state.officeShape = null;
  if (office3d) drawScene();
  state.floorFocus = office3d?.focused ?? null;
  updateOfficeSub();
  renderPalaceBar();
  renderElevator();
  renderRoster();
}

/** Disegna il palazzo scelto (solo i suoi piani, stanze e collegamenti interni) oppure tutto l'universo. */
function drawScene() {
  const { building, agents } = state.office;
  if (state.palace == null) return office3d.setUniverse(building, agents);
  const floors = building.floors.filter((f) => f.palace === state.palace);
  const ids = new Set(floors.map((f) => f.id));
  office3d.setBuilding(
    {
      name: palaceById(state.palace)?.name ?? "",
      floors,
      rooms: building.rooms.filter((r) => ids.has(r.floor)),
      links: building.links.filter((l) => ids.has(l.from) && ids.has(l.to)),
    },
    agents,
    state.palace,
  );
}

function updateOfficeSub() {
  const { building, agents, assistant } = state.office;
  const p = state.palace ? palaceById(state.palace) : null;
  let text;
  if (p) {
    const st = palaceStats(p.id);
    text =
      `${p.name}: ${count(st.agents, "agente", "agenti")} in ${count(st.rooms, "stanza", "stanze")} su ${count(st.floors, "piano", "piani")}, coordinati da ${assistant}. ` +
      (touchMQ.matches
        ? "Scegli un piano nell'ascensore, gira il palazzo con un dito e avvicinati con due; tocca un agente per vederne il nome, tocca il nome per aprire la scheda."
        : "Scegli un piano nell'ascensore, trascina per girare, passa sopra un agente per vederne il nome, clicca una scrivania per aprire la scheda.");
  } else {
    text =
      `${building.name}: ${count(palaces().length, "palazzo", "palazzi")} e ${count(agents.length, "agente", "agenti")}, coordinati da ${assistant}. ` +
      (touchMQ.matches ? "Tocca un palazzo per entrare." : "Clicca un palazzo per entrare, trascina per girare.");
  }
  $("#office-sub").textContent = text;
}

/** Barra sopra il palco: 🌌 Universo, un pulsante per palazzo, + Palazzo. */
function renderPalaceBar() {
  const chip = (id, html, title, c) =>
    `<button class="palace-chip ${state.palace === id ? "active" : ""}" data-palace="${esc(id ?? "")}" title="${esc(title)}"${c ? ` style="--c:${esc(c)}"` : ""}>${html}</button>`;
  $("#palace-bar").innerHTML =
    chip(null, "🌌 Universo", "Tutti i palazzi") +
    palaces().map((p) => chip(p.id, `<i></i>${esc(p.name)}`, p.description || p.name, p.color)).join("") +
    `<button class="palace-chip add" id="palace-add" title="Crea un nuovo palazzo">+ Palazzo</button>`;
  $("#palace-bar").querySelectorAll("[data-palace]").forEach((b) => (b.onclick = () => selectPalace(b.dataset.palace || null)));
  $("#palace-add").onclick = () => openPalaceEditor(null);
}

async function loadAll() {
  await loadOffice();
  [state.notes, state.log, state.approvals, state.chat] = await Promise.all([
    api("/api/notes"), api("/api/log"), api("/api/approvals"), api("/api/chat"),
  ]);
  state.requests = await api("/api/requests").catch(() => []);
  await loadBroker();
  if (!state.chat.busy) voice.speakTurn = false; // risposta finita mentre la diretta era interrotta
  refreshVoiceStatus();
  renderChat();
  renderView();
  refreshStats();
  refreshPortfolio();
}

let statsTimer;
function refreshStatsSoon() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(refreshStats, 300);
}

async function refreshStats() {
  state.stats = await api("/api/stats").catch(() => null);
  const s = state.stats;
  if (!s) return;
  // Sul telefono la striscia dei numeri inizia con "da approvare" e "spesa API" (classi stat-pending e stat-cost).
  const cells = [
    [s.working, "al lavoro ora"], [s.agents, "agenti"], ...(s.palaces > 1 ? [[s.palaces, "palazzi"]] : []), [s.floors, "piani"], [s.rooms, "stanze"], [s.notes, "note in bacheca"],
    [s.trades + (s.brokerTrades ?? 0), "ordini eseguiti"], [s.pending, "da approvare", `stat-pending clickable ${s.pending ? "alert" : ""}`],
    [`$${fmt(s.costMonth ?? s.costUsd)}`, s.budget ? `spesa del mese (su ${fmt(s.budget, 0)} $)` : "spesa del mese", `stat-cost clickable ${s.budget && s.costMonth >= s.budget * 0.8 ? "alert" : ""}`],
    [state.office.llmReady ? "sì" : "no", "Claude collegato", "stat-key clickable"], [s.scheduled, "programmati"],
  ];
  $("#stats").innerHTML = cells
    .map(([v, l, cls = ""]) => `<div class="stat ${cls}"><b>${esc(v)}</b><small>${esc(l)}</small></div>`)
    .join("");
  $("#stats .stat-key").addEventListener("click", openSettings);
  $("#stats .stat-pending").addEventListener("click", () => showView("approvals"));
  $("#stats .stat-cost").addEventListener("click", () => showView("costs"));
  const near = Boolean(s.budget && s.costMonth >= s.budget * 0.8);
  $("#badge-costs").classList.toggle("hidden", !near);
  $("#more-costs-badge").classList.toggle("hidden", !near);
  $("#more-costs-state").textContent = `${fmt(s.costMonth ?? 0)} $ questo mese${s.budget ? ` su ${fmt(s.budget, 0)} $` : ""}`;
  const badge = $("#badge-approvals");
  badge.textContent = s.pending;
  badge.classList.toggle("hidden", !s.pending);
  // Numerino anche sull'icona dell'app installata (dove il telefono lo permette).
  if (navigator.setAppBadge) (s.pending ? navigator.setAppBadge(s.pending) : navigator.clearAppBadge()).catch(() => {});
  const off = Boolean(s.schedule?.enabled && !s.schedule.working);
  $("#schedule-line").classList.toggle("hidden", !off);
  if (off) $("#schedule-line").textContent = `${scheduleText(s.schedule)} Orion risponde comunque e con ▶ puoi far lavorare un agente a mano.`;
  renderStopControls();
}

/** Pulsante STOP in alto (quando cTrader è in uso) e avviso se lo STOP è attivo. */
function renderStopControls() {
  const s = state.stats;
  const stopped = s?.stop ?? state.broker?.safety.killSwitch.active;
  const cta = $("#stop-cta");
  cta.classList.toggle("hidden", !stopped && s?.broker !== "in uso");
  cta.textContent = stopped ? "⛔ STOP attivo" : "⛔ STOP";
  cta.classList.toggle("active", Boolean(stopped));
  $("#badge-broker").classList.toggle("hidden", !stopped);
  $("#more-broker-badge").classList.toggle("hidden", !stopped);
  $("#more-broker-state").textContent = stopped ? "⛔ STOP attivo: gli agenti non fanno ordini" : "Conto cTrader, STOP e limiti";
  syncMoreBadge();
}

/** Sul telefono Broker e Impostazioni stanno in "Altro": il loro "!" compare sulla scheda Altro. */
function syncMoreBadge() {
  const on = ["#badge-broker", "#badge-settings"].some((id) => !$(id).classList.contains("hidden"));
  $("#badge-more").classList.toggle("hidden", !on);
}

const CURRENCY_SIGN = { EUR: "€", USD: "$", GBP: "£", CHF: "CHF", JPY: "¥" };

/** In alto a destra: il conto cTrader in uso (saldo vero); il portafoglio simulato solo se cTrader non è usato. */
function renderAccountCard(accounts) {
  const sign = (cur) => CURRENCY_SIGN[cur] ?? esc(cur ?? "");
  const one = (a) => `<small>${a.isLive ? "Conto REALE" : "Conto demo"} cTrader${a.login ? ` · ${esc(String(a.login))}` : ""}</small>
    <b>${sign(a.currency)} ${fmt(a.equity)}</b>
    <small>saldo ${sign(a.currency)} ${fmt(a.balance)} · ${a.positions} ${a.positions === 1 ? "posizione" : "posizioni"}</small><br/>
    ${a.positions ? `<small class="${a.openPnl >= 0 ? "up" : "down"}">aperte ${money(a.openPnl)}</small>` : ""}
    ${a.today != null ? `<small class="${a.today >= 0 ? "up" : "down"}">${a.positions ? " · " : ""}oggi ${money(a.today)}</small>` : ""}
    ${a.positions || a.today != null ? "<br/>" : ""}<span class="tag ${a.isLive ? "tag-live" : "tag-demo"}">${a.isLive ? "soldi veri" : "demo"}</span>`;
  $("#pnl-card").innerHTML = accounts.map(one).join(`<hr class="pnl-sep"/>`);
}

async function refreshPortfolio() {
  const summary = await api("/api/broker/summary").catch(() => null);
  if (summary?.accounts?.length) {
    renderAccountCard(summary.accounts);
    if (state.view === "portfolio") {
      state.portfolio = await api("/api/portfolio").catch(() => null);
      if (state.portfolio) renderPortfolio();
    }
    return;
  }
  state.portfolio = await api("/api/portfolio").catch(() => null);
  const p = state.portfolio;
  if (!p) return;
  $("#pnl-card").innerHTML = `
    <small>Portafoglio</small><b>€ ${fmt(p.total)}</b>
    <small class="${p.pnlPct >= 0 ? "up" : "down"}">${p.pnlPct >= 0 ? "+" : ""}${fmt(p.pnlPct)}% · ${p.positions.length} posizioni</small><br/>
    <span class="tag">simulato</span>`;
  if (state.view === "portfolio") renderPortfolio();
}

// ---------- navigazione ----------

function showView(view) {
  // "Parla con Orion" e "Altro" sono sezioni solo del telefono: su computer la chat è sempre a destra.
  if (!phoneMQ.matches && (view === "chat" || view === "more")) view = "office";
  // Sul telefono, uscendo dalla chat si annulla la registrazione: non deve continuare senza che si veda.
  if (voice.rec && phoneMQ.matches && view !== "chat") {
    voice.rec.cancel();
    voice.rec = null;
    renderVoice();
    chatNote("Registrazione annullata: sei uscito dalla chat.");
  }
  state.view = view;
  $(".app").dataset.view = view;
  document.querySelectorAll(".nav[data-view]").forEach((x) =>
    x.classList.toggle("active", x.dataset.view === view || (x.dataset.view === "more" && MORE_VIEWS.includes(view))),
  );
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.id !== `view-${view}`));
  renderView();
  syncOffice3d();
  if (view === "broker") {
    loadBrokerAccounts();
    loadBrokerHistory();
    loadBacktests();
  }
  if (view === "costs") loadCosts().then(() => state.view === "costs" && renderCosts(), () => {});
  if (view === "reports") loadReports().then(() => state.view === "reports" && renderReports(), () => {});
  if (view === "social") loadSocial().then(() => state.view === "social" && renderSocial(), () => {});
  if (view === "chat") $("#chat-body").scrollTop = $("#chat-body").scrollHeight;
  else if (phoneMQ.matches && document.activeElement?.closest(".chat-form")) document.activeElement.blur(); // chiude la tastiera
}
document.querySelectorAll(".nav[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
// Righe della sezione "Altro" e pulsanti "‹ Altro" in cima alle sue sezioni.
document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.go)));
$("#more-settings").onclick = () => openSettings();
$("#more-new-agent").onclick = () => openEditor(null);
$("#more-install").onclick = () => openInstall();
$("#more-update").onclick = () => openSettings();
$("#more-logout").onclick = () => confirm("Uscire? Per rientrare servirà la password.") && logout();
$("#logout-btn").onclick = () => logout();

/** Il palazzo 3D si disegna solo quando si vede (risparmia batteria su telefono e computer). */
function syncOffice3d() {
  office3d?.setActive(state.view === "office" && !document.hidden);
}

// Finestra allargata (es. telefono girato o finestra del computer ingrandita): niente sezioni solo-telefono.
phoneMQ.addEventListener("change", () => {
  if (!phoneMQ.matches && (state.view === "chat" || state.view === "more")) showView("office");
  syncRoster();
});

function renderView() {
  if (state.view === "building") renderBuilding();
  else if (state.view === "approvals") renderApprovals();
  else if (state.view === "notes") renderNotes();
  else if (state.view === "log") renderLog();
  else if (state.view === "portfolio") {
    renderHoldings();
    loadHoldings();
    if (state.portfolio) renderPortfolio();
    else api("/api/portfolio").then((p) => { state.portfolio = p; renderPortfolio(); }, () => {});
  } else if (state.view === "broker") renderBroker();
  else if (state.view === "social") renderSocial();
  else if (state.view === "costs") renderCosts();
  else if (state.view === "reports") renderReports();
}

// ---------- ufficio ----------

function renderRoster() {
  const p = state.palace ? palaceById(state.palace) : null;
  const inPalace = p ? palaceStats(p.id).roomIds : null;
  const agents = state.office.agents.filter((a) => !inPalace || inPalace.has(a.room));
  $("#roster-sum").textContent = p
    ? agents.length === 1 ? `L'agente di ${p.name}` : `Elenco dei ${agents.length} agenti di ${p.name}`
    : `Elenco completo dei ${agents.length} agenti`;
  const room = (id) => `${roomById(id)?.name ?? id} · ${p ? floorById(floorOfRoom(id))?.name ?? "" : floorLabel(floorById(floorOfRoom(id)))}`;
  $("#roster-list").innerHTML = agents
    .map((a) => `<div class="roster-row" data-id="${esc(a.id)}">
      <span>${esc(a.avatar)}</span>
      <span><b>${esc(a.name)}</b> <small>· ${esc(room(a.room))} · ${a.mode === "llm" ? "LLM" : esc(a.strategy)}</small></span>
      <span><small>${a.runDays?.length ? `${a.runDays.map((d) => ["dom", "lun", "mar", "mer", "gio", "ven", "sab"][d]).join(" ")} ${esc(a.runAt || "18:00")}` : a.everyMinutes ? `ogni ${a.everyMinutes}′` : "manuale"}</small> <i class="dot ${state.status[a.id]?.status ?? ""}"></i></span>
    </div>`)
    .join("");
  $("#roster-list").querySelectorAll(".roster-row").forEach((r) =>
    r.addEventListener("click", () => openEditor(agents.find((a) => a.id === r.dataset.id))),
  );
}

$("#reset-view").onclick = () => office3d?.resetView();
$("#reset-view-phone").onclick = () => office3d?.resetView();

/** Sul telefono l'elenco degli agenti sta sotto il palco ed è sempre aperto (è il modo più comodo per trovarli). */
function syncRoster() {
  $("#roster").open = phoneMQ.matches;
}
$("#roster-sum").addEventListener("click", (e) => phoneMQ.matches && e.preventDefault());

/** Pulsantiera "ascensore": tutto il palazzo + un pulsante per piano (dal più alto). */
function renderElevator() {
  const el = $("#elevator");
  if (state.palace == null) {
    // Universo: un pulsante per palazzo.
    el.innerHTML =
      palaces()
        .map((p) => {
          const st = palaceStats(p.id);
          return `<button class="lift" data-palace="${esc(p.id)}" title="${esc(p.description || p.name)}"><span class="lift-dot" style="--c:${esc(p.color)}"></span><span class="lift-name">${esc(p.name)}</span><small>${count(st.floors, "piano", "piani")} · ${count(st.agents, "agente", "agenti")}</small></button>`;
        })
        .join("") + `<button class="lift add" id="lift-add" title="Crea un nuovo palazzo">+ Palazzo</button>`;
    el.querySelectorAll(".lift[data-palace]").forEach((b) => (b.onclick = () => selectPalace(b.dataset.palace)));
    $("#lift-add").onclick = () => openPalaceEditor(null);
    return;
  }
  const floors = floorsOf(state.palace).slice().reverse();
  const btn = (id, html, title) =>
    `<button class="lift ${state.floorFocus === id ? "active" : ""}" data-floor="${id ?? ""}" title="${esc(title)}">${html}</button>`;
  el.innerHTML =
    btn(null, `<span class="lift-ico">🏢</span><span class="lift-name">Tutto il palazzo</span>`, palaceById(state.palace)?.name ?? "") +
    floors
      .map((f) => {
        const n = state.office.agents.filter((a) => floorOfRoom(a.room) === f.id).length;
        const linked = B().floors.some((o) => o.id !== f.id && (flowsInto(o.id, f.id) || flowsInto(f.id, o.id)));
        return btn(
          f.id,
          `<span class="lift-dot" style="--c:${esc(f.color)}"></span><span class="lift-name">${esc(f.name)}</span>` +
            `<small>${esc(f.sector || "")}${f.sector ? " · " : ""}${count(n, "agente", "agenti")}${linked ? " · 🔗" : ""}</small>`,
          f.description || f.name,
        );
      })
      .join("") +
    `<button class="lift add" id="lift-add" title="Aggiungi un piano">+ Piano</button>`;
  el.querySelectorAll(".lift[data-floor]").forEach((b) => (b.onclick = () => office3d.focusFloor(b.dataset.floor || null)));
  $("#lift-add").onclick = () => openFloorEditor(null, state.palace);
}

// ---------- palazzo: piani, stanze, collegamenti ----------

function renderBuilding() {
  const b = B();
  $("#building-title").textContent = `🌌 ${b.name}`;
  const agentsIn = (roomId) => state.office.agents.filter((a) => a.room === roomId);
  const floorCard = (f) => {
      const rooms = b.rooms.filter((r) => r.floor === f.id);
      const conns = b.floors
        .filter((o) => o.id !== f.id)
        .map((o) => ({ o, recv: flowsInto(o.id, f.id), send: flowsInto(f.id, o.id) }))
        .filter((c) => c.recv || c.send)
        .map((c) => `<span class="conn">${c.recv && c.send ? "↔" : c.recv ? "← riceve da" : "→ invia a"} ${esc(c.o.palace === f.palace ? c.o.name : floorLabel(c.o))}</span>`)
        .concat(
          b.links
            .filter((l) => !l.active && (l.from === f.id || l.to === f.id))
            .map((l) => `<span class="conn none">⏸ collegamento spento con ${esc(floorLabel(floorById(l.from === f.id ? l.to : l.from)))}</span>`),
        )
        .join("");
      return `<article class="card floor-card" style="--c:${esc(f.color)}">
        <header>
          <span class="floor-dot"></span>
          <div class="floor-head"><h3>${esc(f.name)}</h3><small>livello ${f.level}${f.sector ? ` · ${esc(f.sector)}` : ""}${f.description ? ` · ${esc(f.description)}` : ""}</small></div>
          <button class="btn small" data-edit-floor="${esc(f.id)}">✏️ Modifica</button>
          <button class="btn small" data-show-floor="${esc(f.id)}">👁 Vedi</button>
        </header>
        <div class="rooms-row">
          ${rooms
            .map(
              (r) => `<button class="room-chip" style="--c:${esc(r.color)}" data-edit-room="${esc(r.id)}" title="${esc(r.description)}">
                <b>${esc(r.name)}</b><small>${agentsIn(r.id).map((a) => esc(a.avatar)).join(" ") || "vuota"}</small></button>`,
            )
            .join("")}
          <button class="room-chip add" data-new-room="${esc(f.id)}">+ Stanza</button>
        </div>
        <div class="conns">${conns || '<span class="conn none">Nessun collegamento: questo piano lavora da solo</span>'}</div>
      </article>`;
  };
  $("#floors-list").innerHTML = palaces()
    .map((p) => {
      const st = palaceStats(p.id);
      const floors = floorsOf(p.id).slice().reverse();
      return `<section class="palace-block">
        <header class="palace-head" style="--c:${esc(p.color)}">
          <span class="palace-dot"></span>
          <div class="palace-title"><h2>${esc(p.name)}</h2><small>${esc(p.description || "")}${p.description ? " · " : ""}${count(st.floors, "piano", "piani")} · ${count(st.rooms, "stanza", "stanze")} · ${count(st.agents, "agente", "agenti")}</small></div>
          <button class="btn small" data-edit-palace="${esc(p.id)}">✏️ Modifica</button>
          <button class="btn small" data-show-palace="${esc(p.id)}">👁 Vedi</button>
          <button class="btn small primary" data-new-floor="${esc(p.id)}">+ Piano</button>
        </header>
        ${floors.map(floorCard).join("") || `<p class="empty">Nessun piano in questo palazzo. Crea il primo con «+ Piano», oppure chiedi a Orion di prepararli.</p>`}
      </section>`;
    })
    .join("");
  $("#floors-list").querySelectorAll("[data-edit-palace]").forEach((x) => (x.onclick = () => openPalaceEditor(palaceById(x.dataset.editPalace))));
  $("#floors-list").querySelectorAll("[data-show-palace]").forEach((x) => (x.onclick = () => showPalaceInOffice(x.dataset.showPalace)));
  $("#floors-list").querySelectorAll("[data-new-floor]").forEach((x) => (x.onclick = () => openFloorEditor(null, x.dataset.newFloor)));

  $("#floors-list").querySelectorAll("[data-edit-floor]").forEach((x) => (x.onclick = () => openFloorEditor(floorById(x.dataset.editFloor))));
  $("#floors-list").querySelectorAll("[data-show-floor]").forEach((x) => (x.onclick = () => showFloorInOffice(x.dataset.showFloor)));
  $("#floors-list").querySelectorAll("[data-edit-room]").forEach((x) => (x.onclick = () => openRoomEditor(roomById(x.dataset.editRoom))));
  $("#floors-list").querySelectorAll("[data-new-room]").forEach((x) => (x.onclick = () => openRoomEditor(null, x.dataset.newRoom)));

  const name = (id) => esc(floorLabel(floorById(id)) || id);
  $("#links-list").innerHTML =
    b.links
      .map(
        (l) => `<div class="card link-row ${l.active ? "" : "off"}">
          <span class="link-desc">${name(l.from)} <b>${l.direction === "both" ? "↔" : "→"}</b> ${name(l.to)}</span>
          <small>${l.direction === "both" ? "si leggono a vicenda" : `${name(l.to)} legge ${name(l.from)}`}</small>
          <label class="switch" title="${l.active ? "Collegamento attivo" : "Collegamento spento"}">
            <input type="checkbox" data-toggle-link="${esc(l.from)}|${esc(l.to)}" ${l.active ? "checked" : ""} />
            <span>${l.active ? "Attivo" : "Spento"}</span>
          </label>
          <button class="btn small" data-flip-link="${esc(l.from)}|${esc(l.to)}">${l.direction === "both" ? "Rendi →" : "Rendi ↔"}</button>
          <button class="btn small danger" data-del-link="${esc(l.from)}|${esc(l.to)}">Elimina</button>
        </div>`,
      )
      .join("") || `<p class="empty">Nessun collegamento: ogni piano lavora da solo.</p>`;
  const linkOf = (key) => b.links.find((l) => `${l.from}|${l.to}` === key);
  const saveLink = async (l) => {
    try {
      await api("/api/links", { method: "PUT", body: JSON.stringify(l) });
    } catch (err) {
      alert(err.message);
    }
  };
  $("#links-list").querySelectorAll("[data-toggle-link]").forEach((x) => (x.onchange = () => saveLink({ ...linkOf(x.dataset.toggleLink), active: x.checked })));
  $("#links-list").querySelectorAll("[data-flip-link]").forEach((x) => {
    x.onclick = () => {
      const l = linkOf(x.dataset.flipLink);
      saveLink({ ...l, direction: l.direction === "both" ? "one-way" : "both" });
    };
  });
  $("#links-list").querySelectorAll("[data-del-link]").forEach((x) => {
    x.onclick = async () => {
      const [from, to] = x.dataset.delLink.split("|");
      if (!confirm("Eliminare questo collegamento?")) return;
      await api(`/api/links?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method: "DELETE" }).catch((e) => alert(e.message));
    };
  });

  const lf = $("#link-form");
  const opts = floorOptions();
  const keep = { from: lf.from.value, to: lf.to.value };
  lf.from.innerHTML = opts;
  lf.to.innerHTML = opts;
  // Mantiene la scelta solo se è ancora valida, e mai lo stesso piano da entrambi i lati.
  const ids = b.floors.map((f) => f.id);
  lf.from.value = ids.includes(keep.from) ? keep.from : ids[0] ?? "";
  lf.to.value = ids.includes(keep.to) && keep.to !== lf.from.value ? keep.to : ids.find((id) => id !== lf.from.value) ?? "";
  lf.classList.toggle("hidden", b.floors.length < 2);
}

$("#link-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  $("#link-errors").textContent = "";
  try {
    await api("/api/links", { method: "PUT", body: JSON.stringify({ from: f.from.value, to: f.to.value, direction: f.direction.value, active: true }) });
  } catch (err) {
    $("#link-errors").textContent = err.message;
  }
});

function showFloorInOffice(floorId) {
  document.querySelector('.nav[data-view="office"]').click();
  const palace = floorById(floorId)?.palace;
  if (palace && palace !== state.palace) selectPalace(palace);
  requestAnimationFrame(() => office3d.focusFloor(floorId));
}

function showPalaceInOffice(palaceId) {
  document.querySelector('.nav[data-view="office"]').click();
  selectPalace(palaceId);
}

$("#new-floor").onclick = () => openFloorEditor(null, state.palace ?? palaces()[0]?.id);
$("#new-palace").onclick = () => openPalaceEditor(null);
$("#rename-building").onclick = async () => {
  const name = prompt("Nome dell'universo:", B().name);
  if (name == null) return;
  await api("/api/building", { method: "PUT", body: JSON.stringify({ name }) }).catch((e) => alert(e.message));
};

// Finestra piano
const floorDlg = $("#floor-dialog");
const floorForm = $("#floor-form");
/** Livello proposto per un piano nuovo: sopra l'ultimo piano del suo palazzo. */
const nextLevel = (palaceId) => Math.max(-1, ...floorsOf(palaceId).map((f) => f.level)) + 1;

function openFloorEditor(floor, palaceId) {
  state.editingFloor = floor?.id ?? null;
  $("#floor-title").textContent = floor ? `Modifica: ${floor.name}` : "Nuovo piano";
  floorForm.palace.innerHTML = palaces().map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  floorForm.palace.value = floor?.palace ?? palaceId ?? state.palace ?? palaces()[0]?.id;
  floorForm.palace.closest("label").classList.toggle("hidden", palaces().length < 2 && !!floor);
  floorForm.name.value = floor?.name ?? "";
  floorForm.sector.value = floor?.sector ?? "";
  floorForm.description.value = floor?.description ?? "";
  floorForm.level.value = floor?.level ?? nextLevel(floorForm.palace.value);
  floorForm.color.value = floor?.color ?? ["#2fb7c4", "#f06292", "#8bc34a", "#ff8a3d", "#7986cb"][B().floors.length % 5];
  $("#floor-delete").classList.toggle("hidden", !floor);
  $("#floor-errors").textContent = "";
  floorDlg.showModal();
}
// Cambiando palazzo si propone il livello giusto per quel palazzo (in cima); tornando al suo, il livello di prima.
floorForm.palace.addEventListener("change", () => {
  const floor = floorById(state.editingFloor);
  floorForm.level.value = floor && floor.palace === floorForm.palace.value ? floor.level : nextLevel(floorForm.palace.value);
});
floorForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    palace: floorForm.palace.value,
    name: floorForm.name.value,
    sector: floorForm.sector.value,
    description: floorForm.description.value,
    level: Number(floorForm.level.value),
    color: floorForm.color.value,
  };
  try {
    const id = state.editingFloor;
    await api(id ? `/api/floors/${encodeURIComponent(id)}` : "/api/floors", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
    floorDlg.close();
  } catch (err) {
    $("#floor-errors").textContent = err.message;
  }
});
$("#floor-delete").onclick = async () => {
  if (!confirm("Eliminare questo piano? (Deve essere vuoto: niente stanze.)")) return;
  try {
    await api(`/api/floors/${encodeURIComponent(state.editingFloor)}`, { method: "DELETE" });
    floorDlg.close();
  } catch (err) {
    $("#floor-errors").textContent = err.message;
  }
};
floorDlg.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => floorDlg.close()));

// Finestra palazzo
const palaceDlg = $("#palace-dialog");
const palaceForm = $("#palace-form");
function openPalaceEditor(palace) {
  state.editingPalace = palace?.id ?? null;
  $("#palace-title").textContent = palace ? `Modifica: ${palace.name}` : "Nuovo palazzo";
  palaceForm.name.value = palace?.name ?? "";
  palaceForm.description.value = palace?.description ?? "";
  palaceForm.hours.value = palace?.hours ?? "lavoro";
  palaceForm.color.value = palace?.color ?? ["#f06292", "#2fb7c4", "#ffb84d", "#8bc34a", "#a371f7", "#ff8a3d"][palaces().length % 6];
  $("#palace-delete").classList.toggle("hidden", !palace || palaces().length < 2);
  $("#palace-errors").textContent = "";
  palaceDlg.showModal();
}
palaceForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { name: palaceForm.name.value, description: palaceForm.description.value, color: palaceForm.color.value, hours: palaceForm.hours.value };
  try {
    const id = state.editingPalace;
    const res = await api(id ? `/api/palaces/${encodeURIComponent(id)}` : "/api/palaces", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
    palaceDlg.close();
    if (!id && res?.id) {
      // Palazzo nuovo: lo si apre subito, vuoto, pronto per i piani.
      await loadOffice();
      selectPalace(res.id);
    }
  } catch (err) {
    $("#palace-errors").textContent = err.message;
  }
});
$("#palace-delete").onclick = async () => {
  if (!confirm("Eliminare questo palazzo? (Deve essere vuoto: niente piani.)")) return;
  try {
    await api(`/api/palaces/${encodeURIComponent(state.editingPalace)}`, { method: "DELETE" });
    palaceDlg.close();
  } catch (err) {
    $("#palace-errors").textContent = err.message;
  }
};
palaceDlg.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => palaceDlg.close()));

// Finestra stanza
const roomDlg = $("#room-dialog");
const roomForm = $("#room-form");
function openRoomEditor(room, floorId) {
  state.editingRoom = room?.id ?? null;
  $("#room-title").textContent = room ? `Modifica: ${room.name}` : "Nuova stanza";
  roomForm.floor.innerHTML = floorOptions();
  roomForm.name.value = room?.name ?? "";
  roomForm.floor.value = room?.floor ?? floorId ?? B().floors[0]?.id;
  roomForm.description.value = room?.description ?? "";
  roomForm.color.value = room?.color ?? ["#4f8cff", "#22b07d", "#e5534b", "#d29922", "#a371f7", "#2fb7c4"][B().rooms.length % 6];
  $("#room-delete").classList.toggle("hidden", !room);
  $("#room-errors").textContent = "";
  roomDlg.showModal();
}
roomForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { name: roomForm.name.value, floor: roomForm.floor.value, description: roomForm.description.value, color: roomForm.color.value };
  try {
    const id = state.editingRoom;
    await api(id ? `/api/rooms/${encodeURIComponent(id)}` : "/api/rooms", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
    roomDlg.close();
  } catch (err) {
    $("#room-errors").textContent = err.message;
  }
});
$("#room-delete").onclick = async () => {
  if (!confirm("Eliminare questa stanza? (Deve essere vuota: niente agenti.)")) return;
  try {
    await api(`/api/rooms/${encodeURIComponent(state.editingRoom)}`, { method: "DELETE" });
    roomDlg.close();
  } catch (err) {
    $("#room-errors").textContent = err.message;
  }
};
roomDlg.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => roomDlg.close()));

// ---------- approvazioni ----------

// ---------- domande degli agenti ----------
// Note con l'etichetta RICHIESTA: in cima ad Approvazioni, con la risposta (e un allegato) che torna nella stanza.

const requestDrafts = new Map(); // id → testo scritto e non ancora mandato (le schede si ridisegnano spesso)
let requestFileFor = null;

function renderRequests() {
  const el = $("#requests-list");
  // Scheda «Da approvare»: le domande ancora aperte; scheda «Approvate»: le ultime già chiuse.
  const done = state.approvalsTab === "done";
  const open = done ? [] : state.requests.filter((r) => r.status === "open");
  const closed = done ? state.requests.filter((r) => r.status !== "open").slice(0, 10) : [];
  const roomName = (id) => state.office?.rooms.find((r) => r.id === id)?.name ?? id;
  el.innerHTML = open.length || closed.length
    ? `<h2 class="section-title">📩 ${done ? "Domande chiuse" : "Domande degli agenti"}${open.length ? ` (${open.length})` : ""}</h2>` +
      open.map((r) => `<article class="card request-card">
        <div class="kicker"><span>📩 Domanda</span><span class="meta">· ${esc(r.agentName)} · ${esc(roomName(r.roomId))} · ${when(r.at)}</span></div>
        <p class="post-text">${esc(r.text)}</p>
        <textarea rows="3" data-req-text="${esc(r.id)}" placeholder="Scrivi la risposta (se serve una foto, un logo o un video, allegalo)…">${esc(requestDrafts.get(r.id) ?? "")}</textarea>
        <div class="actions">
          <button class="btn good" data-req-answer="${esc(r.id)}">Invia risposta</button>
          <button class="btn ghost" data-req-file="${esc(r.id)}">📎 Allega foto o video</button>
          <button class="btn ghost" data-req-dismiss="${esc(r.id)}">Non serve</button>
        </div>
      </article>`).join("") +
      closed.map((r) => `<article class="card decided request-card"><div class="kicker"><span>📩 ${r.status === "answered" ? "Risposta inviata" : "Domanda chiusa"}</span><span class="meta">· ${esc(r.agentName)} · ${when(r.closedAt ?? r.at)}</span></div>
        <p class="post-text">${esc(r.text.slice(0, 200))}${r.text.length > 200 ? "…" : ""}</p>${r.answer ? `<p class="meta">Tu: ${esc(r.answer.slice(0, 200))}${r.answer.length > 200 ? "…" : ""}</p>` : ""}</article>`).join("")
    : "";
  el.querySelectorAll("[data-req-text]").forEach((t) => t.addEventListener("input", () => requestDrafts.set(t.dataset.reqText, t.value)));
  el.querySelectorAll("[data-req-answer],[data-req-dismiss]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.reqAnswer ?? b.dataset.reqDismiss;
      b.disabled = true;
      try {
        const r = b.dataset.reqAnswer
          ? await api(`/api/requests/${id}/answer`, { method: "POST", body: JSON.stringify({ text: requestDrafts.get(id) ?? "" }) })
          : await api(`/api/requests/${id}/dismiss`, { method: "POST" });
        requestDrafts.delete(id);
        upsertRequest(r);
      } catch (err) {
        alert(err.message);
        b.disabled = false;
      }
    }),
  );
  el.querySelectorAll("[data-req-file]").forEach((b) =>
    b.addEventListener("click", () => {
      requestFileFor = b.dataset.reqFile;
      $("#request-file").click();
    }),
  );
}

function upsertRequest(r) {
  const i = state.requests.findIndex((x) => x.id === r.id);
  if (i >= 0) state.requests[i] = r;
  else state.requests.unshift(r);
  if (state.view === "approvals") renderApprovals(); // anche i numeri delle schede
  refreshStatsSoon();
}

/** Allegato alla risposta: va nell'archivio (📣 Social → Foto e video) e nella risposta si scrive il suo id. */
$("#request-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  const id = requestFileFor;
  if (!file || !id) return;
  const btn = $(`[data-req-file="${CSS.escape(id)}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Carico…";
  }
  try {
    const res = await fetch("/api/media", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) }, body: file });
    const m = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(m.error ?? `errore ${res.status}`);
    const line = `[Allegato: ${m.kind === "video" ? "video" : "foto"} «${m.title}», id ${m.id} nell'archivio]`;
    requestDrafts.set(id, `${requestDrafts.get(id) ?? ""}${requestDrafts.get(id) ? "\n" : ""}${line}`);
    renderRequests();
  } catch (err) {
    alert(`Caricamento non riuscito: ${err.message}`);
    renderRequests();
  }
});

function renderApprovals() {
  // Due schede: «Da approvare» (proposte in attesa e domande aperte) e «Approvate» (già decise; le scartate solo a richiesta).
  const tab = state.approvalsTab === "done" ? "done" : "pending";
  // I post con un'ora di pubblicazione compaiono un'ora prima (showAt): prima restano nascosti.
  const now = Date.now();
  const allPending = state.approvals.filter((a) => a.status === "pending");
  const pendingList = allPending.filter((a) => !a.showAt || Date.parse(a.showAt) <= now);
  const later = allPending.length - pendingList.length;
  const decided = state.approvals.filter((a) => a.status !== "pending");
  const rejected = decided.filter((a) => a.status === "rejected").length;
  const openRequests = state.requests.filter((r) => r.status === "open").length;
  $("#approvals-count-pending").textContent = pendingList.length + openRequests ? String(pendingList.length + openRequests) : "";
  $("#approvals-count-done").textContent = decided.length - rejected ? String(decided.length - rejected) : "";
  document.querySelectorAll("#approvals-tabs [data-approvals-tab]").forEach((b) => {
    const on = b.dataset.approvalsTab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  renderRequests();
  const list = tab === "pending" ? pendingList : decided.filter((a) => state.showRejected || a.status !== "rejected");
  const laterNote = tab === "pending" && later ? `<p class="meta appr-filter">🕒 ${later === 1 ? "1 post arriva" : `${later} post arrivano`} più tardi, un'ora prima dell'ora di pubblicazione.</p>` : "";
  const toggle = tab === "pending" ? laterNote : tab === "done" && rejected
    ? `<label class="inline appr-filter"><input type="checkbox" id="approvals-show-rejected" ${state.showRejected ? "checked" : ""} /> Mostra anche le scartate (${rejected})</label>`
    : "";
  if (!list.length) {
    $("#approvals-list").innerHTML = toggle + (tab === "pending"
      ? `<p class="empty">Niente da approvare. Quando un agente vuole comprare, vendere o pubblicare un post, la trovi qui (in alto, le sue eventuali domande per te).</p>`
      : `<p class="empty">Ancora nessuna proposta decisa.</p>`);
    bindRejectedToggle();
    return;
  }
  const label = { pending: "", executed: "✔ Eseguito", rejected: "Scartato", failed: "✖ Non eseguito", executing: "In esecuzione…", uncertain: "⚠️ Esito incerto", scheduled: "🕒 Programmato" };
  // Moduli dei segnali aperti (quantità e prezzo che stai scrivendo): restano aperti quando arriva un'altra proposta.
  const openForms = new Map([...document.querySelectorAll("#approvals-list [data-signal-form]:not(.hidden)")].map((f) => [f.dataset.signalForm, Object.fromEntries(new FormData(f))]));
  $("#approvals-list").innerHTML = toggle + list
    .map((a) => {
      if (a.kind === "post") return renderPostApproval(a, label);
      if (a.kind === "signal") return renderSignalApproval(a, label);
      const o = a.order;
      const pending = a.status === "pending";
      const t = a.target;
      const where = t?.mode === "ctrader"
        ? `<span class="acct ${t.isLive ? "live" : "demo"}">${t.isLive ? "CONTO REALE" : "demo"}</span> <span class="meta">${esc(t.label)}</span>`
        : `<span class="acct paper">simulato</span>`;
      const title = o.action === "close"
        ? `Chiudi ${o.side === "sell" ? "la vendita" : "l'acquisto"} di ${esc(o.lots ?? o.positionLots ?? "")} lotti ${esc(o.symbol)}` +
          `${o.lots && o.positionLots && o.lots < o.positionLots ? ` (su ${esc(o.positionLots)})` : ""}${o.pnl != null ? ` · P&L attuale ${fmt(o.pnl)}` : ""}`
        : `${o.side === "buy" ? "Compra" : "Vendi"} ${o.lots != null ? `${esc(o.lots)} lotti` : esc(o.qty)} ${esc(o.symbol)}`;
      const extra = [o.stop_loss_pct ? `stop loss ${fmt(o.stop_loss_pct, 1)}%` : "", o.take_profit_pct ? `take profit ${fmt(o.take_profit_pct, 1)}%` : ""].filter(Boolean).join(" · ");
      return `<article class="card ${pending ? "" : "decided"} ${t?.isLive ? "live-card" : ""}">
        <div class="kicker"><span class="${o.action === "close" ? "" : esc(o.side)}">${o.action === "close" ? "Chiusura" : o.side === "buy" ? "Acquisto" : "Vendita"}</span><span class="meta">· ${esc(a.agentName)} · ${when(a.at)}</span></div>
        <h3>${title}</h3>
        <div class="where">${where}${extra ? ` <span class="meta">· ${extra}</span>` : ""}</div>
        <p>${esc(o.reason) || "Nessuna motivazione"}</p>
        <div class="actions">
          ${pending
            ? `<button class="btn good" data-approve="${a.id}">Fallo per me</button><button class="btn ghost" data-reject="${a.id}">Scarta</button>`
            : `<span class="meta">${approvalOutcome(a, label)}</span>`}
        </div>
      </article>`;
    })
    .join("");
  $("#approvals-list").querySelectorAll("[data-approve],[data-reject]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api(`/api/approvals/${b.dataset.approve ?? b.dataset.reject}`, {
          method: "POST", body: JSON.stringify({ approve: Boolean(b.dataset.approve) }),
        });
      } catch (err) {
        alert(err.message);
      }
    }),
  );
  bindRejectedToggle();
  bindShareButtons($("#approvals-list"), list);
  bindSignalForms($("#approvals-list"));
  for (const [id, values] of openForms) {
    const f = $("#approvals-list").querySelector(`[data-signal-form="${id}"]`);
    if (!f) continue;
    f.classList.remove("hidden");
    $("#approvals-list").querySelector(`[data-signal-open="${id}"]`)?.classList.add("hidden");
    for (const [k, v] of Object.entries(values)) if (f.elements[k]) f.elements[k].value = v;
  }
}

function bindRejectedToggle() {
  $("#approvals-show-rejected")?.addEventListener("change", (e) => {
    state.showRejected = e.target.checked;
    renderApprovals();
  });
}
document.querySelectorAll("#approvals-tabs [data-approvals-tab]").forEach((b) =>
  b.addEventListener("click", () => {
    state.approvalsTab = b.dataset.approvalsTab;
    renderApprovals();
  }),
);

// ---------- segnali sulle azioni dell'utente ----------

const curSign = (c) => ({ EUR: "€", USD: "$", GBP: "£", GBp: "p", CHF: "CHF" })[c] ?? (c || "");
const px = (n, c) => (n == null ? "—" : `${fmt(n, n >= 1000 ? 2 : n >= 1 ? 2 : 4)} ${esc(curSign(c))}`.trim());
const plus = (n, d = 2) => (n == null ? "—" : `${n > 0 ? "+" : ""}${fmt(n, d)}`);
const horizonText = { breve: "settimane", medio: "mesi", lungo: "anni" };
/** Numero da proporre in un campo (virgola italiana, 2 decimali; 4 sotto 1). */
const inputNum = (n) => (n == null || !Number.isFinite(Number(n)) ? "" : String(Number(Number(n).toFixed(Math.abs(n) >= 1 ? 2 : 4))).replace(".", ","));

/** Segnale di un agente: comprare o vendere un'azione. «Approva» apre il modulo per scrivere quante azioni e a che prezzo. */
function renderSignalApproval(a, label) {
  const s = a.signal;
  const buy = s.side === "buy";
  const pending = a.status === "pending";
  const c = s.currency;
  const facts = buy
    ? [
        `prezzo al segnale ${px(s.priceAtSignal, c)}`,
        s.entryMin || s.entryMax ? `fascia d'ingresso ${px(s.entryMin, c)} – ${px(s.entryMax, c)}` : "",
        `stop loss ${px(s.stopLoss, c)}`,
        s.target ? `obiettivo ${px(s.target, c)}` : "",
        s.horizon ? `orizzonte: ${horizonText[s.horizon]}` : "",
      ]
    : [`prezzo ${px(s.priceAtSignal, c)}`, `hai ${fmt(s.heldQty, 0)} azioni a ${px(s.avgPrice, c)} (${plus(s.pnlPct)}%)`, s.sellPct < 100 ? `vendere il ${fmt(s.sellPct, 0)}%` : "vendere tutto"];
  const size = buy && s.suggestedPct
    ? `<p class="signal-size">Suggerito: ${fmt(s.suggestedPct, 0)}% del capitale${s.suggestedEur ? ` ≈ € ${fmt(s.suggestedEur, 0)}` : ""}${s.suggestedQty ? ` (circa ${s.suggestedQty} azioni)` : ""}${s.alreadyHeld ? ` · ne hai già ${fmt(s.alreadyHeld.qty, 0)}` : ""}${s.maxWeight ? ` · limite per una sola azione: ${fmt(s.maxWeight, 0)}%` : ""}</p>`
    : "";
  let outcome = "";
  if (!pending) {
    const f = a.fill;
    outcome = a.status === "executed" && f
      ? buy ? `✔ Comprate ${esc(f.qty)} azioni a ${px(f.price, c)}` : `✔ Vendute ${esc(f.qty)} azioni a ${px(f.price, c)} · risultato ${plus(f.pnl)} ${esc(curSign(c))} (${plus(f.pnlPct)}%)`
      : a.status === "rejected" ? "Scartato" : (label[a.status] ?? esc(a.status));
  }
  return `<article class="card signal-card ${pending ? "" : "decided"}" data-signal="${a.id}">
    <div class="kicker"><span class="${buy ? "buy" : "sell"}">${buy ? "📈 Segnale d'acquisto" : "📉 Segnale di vendita"}</span><span class="meta">· ${esc(a.agentName)} · ${when(a.at)}</span></div>
    <h3>${buy ? "Compra" : "Vendi"} ${esc(s.symbol)}${s.name ? ` <span class="meta">${esc(s.name)}</span>` : ""}</h3>
    <div class="where"><span class="meta">${facts.filter(Boolean).join(" · ")}</span></div>
    ${size}
    <p>${esc(s.reason)}</p>
    ${s.risks ? `<p class="signal-risks"><b>⚠️ Perché potrei sbagliarmi:</b> ${esc(s.risks)}</p>` : ""}
    ${s.sources?.length ? `<p class="signal-sources"><b>Fonti:</b> ${s.sources.map(esc).join(" · ")}</p>` : buy && !s.sources?.length ? `<p class="signal-sources">Fonti: nessuna indicata, verifica i numeri prima di comprare.</p>` : ""}
    <div class="actions">
      ${pending
        ? `<button class="btn good" data-signal-open="${a.id}">Approva</button><button class="btn ghost" data-signal-reject="${a.id}">Scarta</button>`
        : `<span class="meta">${outcome}</span>`}
    </div>
    ${pending ? `<form class="signal-form hidden" data-signal-form="${a.id}">
      <p class="hint">${buy ? "Hai comprato? Scrivi quante azioni e il prezzo medio pagato: gli agenti seguiranno il titolo e ti diranno quando vendere." : "Hai venduto? Scrivi quante azioni e il prezzo incassato."}</p>
      <div class="grid3">
        <label>Quante azioni<input name="qty" inputmode="decimal" autocomplete="off" required value="${esc(inputNum(s.suggestedQty))}"></label>
        <label>Prezzo per azione (${esc(c || "valuta del titolo")})<input name="price" inputmode="decimal" autocomplete="off" required value="${esc(inputNum(s.priceAtSignal))}"></label>
        <label>Commissioni (facoltative)<input name="fees" inputmode="decimal" autocomplete="off" placeholder="0"></label>
      </div>
      <div class="row wrap"><button class="btn good" type="submit">${buy ? "Conferma acquisto" : "Conferma vendita"}</button><button class="btn ghost" type="button" data-signal-cancel="${a.id}">Annulla</button><span class="errors"></span></div>
    </form>` : ""}
  </article>`;
}

function bindSignalForms(root) {
  root.querySelectorAll("[data-signal-open]").forEach((b) =>
    b.addEventListener("click", () => {
      const f = root.querySelector(`[data-signal-form="${b.dataset.signalOpen}"]`);
      f.classList.remove("hidden");
      b.classList.add("hidden");
      f.querySelector("input[name=qty]").focus();
    }));
  root.querySelectorAll("[data-signal-cancel]").forEach((b) =>
    b.addEventListener("click", () => {
      root.querySelector(`[data-signal-form="${b.dataset.signalCancel}"]`).classList.add("hidden");
      root.querySelector(`[data-signal-open="${b.dataset.signalCancel}"]`)?.classList.remove("hidden");
    }));
  root.querySelectorAll("[data-signal-reject]").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api(`/api/approvals/${b.dataset.signalReject}`, { method: "POST", body: JSON.stringify({ approve: false }) });
      } catch (err) {
        b.disabled = false;
        alert(err.message);
      }
    }));
  root.querySelectorAll("[data-signal-form]").forEach((f) =>
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      const v = Object.fromEntries(new FormData(f));
      try {
        await api(`/api/approvals/${f.dataset.signalForm}`, { method: "POST", body: JSON.stringify({ approve: true, ...v }) });
        loadHoldings();
      } catch (err) {
        f.querySelector(".errors").textContent = err.message;
        btn.disabled = false;
      }
    }));
}

/** Esito di una proposta già decisa (sui conti cTrader il prezzo resta con tutti i decimali). */
function approvalOutcome(a, label) {
  if (a.error) return `${label[a.status] ?? esc(a.status)} — ${esc(a.error)}`;
  if (a.status !== "executed" || !a.trade) return label[a.status] ?? esc(a.status);
  if (a.trade.status === "accepted") return "Inviato a cTrader, esecuzione non ancora confermata: controlla Broker → Posizioni aperte";
  const price = a.target?.mode === "ctrader" ? (a.trade.price ?? "—") : fmt(a.trade.price);
  return `${label.executed}${a.trade.price != null ? ` a ${esc(price)}` : ""}${a.trade.lots != null ? ` · ${esc(a.trade.lots)} lotti` : ""}`;
}

// ---------- bacheca ----------

const roomColor = (id) => state.office.rooms.find((r) => r.id === id)?.color;

function renderFilter() {
  const el = $("#room-filter");
  el.innerHTML = "";
  const mk = (id, label) => {
    const b = document.createElement("button");
    b.className = `chip ${state.room === id ? "active" : ""}`;
    b.textContent = label;
    b.onclick = () => {
      state.room = id;
      renderFilter();
      renderNotes();
    };
    el.append(b);
  };
  mk(null, "Tutte");
  for (const r of state.office.rooms) mk(r.id, r.name);
}

function renderNotes() {
  const all = Object.entries(state.notes)
    .filter(([room]) => !state.room || room === state.room)
    .flatMap(([room, list]) => list.map((n) => ({ ...n, roomId: room })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 100);
  $("#notes-list").innerHTML = all.length
    ? all.map((n) => `
      <div class="note" style="--room:${roomColor(n.roomId)}">
        <div class="h"><b>${esc(n.agentName)}</b><span>${when(n.at)}</span></div>
        <div class="t">${esc(n.text)}</div>
        ${n.tags?.length ? `<div class="tags">${n.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
      </div>`).join("")
    : `<p class="empty">Nessuna nota. Clicca un agente nell'ufficio e premi ▶ Esegui.</p>`;
}

// ---------- attività ----------

function renderLog() {
  $("#log-list").innerHTML =
    state.log.slice(-300).reverse()
      .map((l) => `<div class="logline ${l.level}">${time(l.at)} [${esc(l.agentId)}] ${esc(l.message)}</div>`)
      .join("") || `<p class="empty">Nessuna attività.</p>`;
}

// ---------- portafoglio ----------

function renderPortfolio() {
  const p = state.portfolio;
  if (!p) return;
  $("#portfolio-body").innerHTML = `
    <div class="kpis">
      <div class="kpi"><small>Valore totale</small><b>€ ${fmt(p.total)}</b></div>
      <div class="kpi"><small>P&L</small><b class="${p.pnlPct >= 0 ? "up" : "down"}">${p.pnlPct >= 0 ? "+" : ""}${fmt(p.pnlPct)}%</b></div>
      <div class="kpi"><small>Liquidità</small><b>€ ${fmt(p.cash)}</b></div>
      <div class="kpi"><small>Investito</small><b>€ ${fmt(p.invested)}</b></div>
    </div>
    <h4>Posizioni</h4>
    ${p.positions.length ? `<table class="stack"><tr><th>Titolo</th><th>Q.tà</th><th>Medio</th><th>Prezzo</th><th>Valore</th><th>P&L</th></tr>
      ${p.positions.map((x) => `<tr><td data-label="Titolo">${esc(x.symbol)}${x.source === "demo" ? " *" : ""}</td><td data-label="Quantità">${x.qty}</td><td data-label="Prezzo medio">${fmt(x.avgPrice)}</td><td data-label="Prezzo">${fmt(x.price)}</td><td data-label="Valore">${fmt(x.value)}</td>
      <td data-label="P&L" class="${x.pnlPct >= 0 ? "up" : "down"}">${fmt(x.pnlPct)}%</td></tr>`).join("")}</table>` : `<p class="empty">Nessuna posizione aperta.</p>`}
    <h4>Ultimi ordini</h4>
    ${p.trades.length ? `<table class="stack"><tr><th>Quando</th><th>Titolo</th><th>Lato</th><th>Q.tà</th><th>Prezzo</th><th>Agente</th></tr>
      ${p.trades.slice().reverse().map((t) => `<tr title="${esc(t.reason)}"><td data-label="Quando">${when(t.at)}</td><td data-label="Titolo">${esc(t.symbol)}</td><td data-label="Lato" class="${t.side === "buy" ? "up" : "down"}">${t.side}</td><td data-label="Quantità">${t.qty}</td><td data-label="Prezzo">${fmt(t.price)}</td><td data-label="Agente">${esc(t.agentId)}</td></tr>`).join("")}</table>` : `<p class="empty">Nessun ordine.</p>`}
    <p class="hint">* prezzo da dati demo (mercato non raggiungibile)</p>`;
}

// ---------- il mio portafoglio (azioni vere dell'utente) ----------

let holdingsLoading = null;
function loadHoldings() {
  holdingsLoading ??= Promise.all([api("/api/holdings"), api("/api/holdings/sources").catch(() => null)])
    .then(([h, sources]) => {
      state.holdings = h;
      state.priceSources = sources;
      if (state.view === "portfolio") renderHoldings();
    }, (err) => {
      if (!state.holdings) $("#holdings-body").innerHTML = `<p class="errors">Portafoglio non disponibile: ${esc(err.message)}</p>`;
    })
    .finally(() => (holdingsLoading = null));
  return holdingsLoading;
}

const holdingForm = { mode: null, id: null }; // modulo aperto: "add" | "sell" | "edit" | "profile" | "sources"
const SOURCE_NAMES = { yahoo: "Yahoo Finance", twelvedata: "Twelve Data", fmp: "Financial Modeling Prep", finnhub: "Finnhub", sec: "SEC (bilanci ufficiali USA)" };

function renderHoldings() {
  const h = state.holdings;
  if (!h) return;
  // Non si ridisegna mentre stai scrivendo in un modulo (arrivano aggiornamenti dei prezzi).
  if (document.activeElement?.closest?.("#holdings-body form")) return;
  const t = h.totals;
  const pr = h.profile;
  const realized = Object.entries(t.realizedByCurrency ?? {}).map(([c, v]) => `<span class="${v >= 0 ? "up" : "down"}">${plus(v)} ${esc(curSign(c))}</span>`).join(" · ") || "—";
  const rows = h.positions.map((p) => `
    <tr>
      <td data-label="Azione"><b>${esc(p.symbol)}</b>${p.name ? `<small class="hint">${esc(p.name)}</small>` : ""}${p.agentName ? `<small class="hint">segnalata da ${esc(p.agentName)}</small>` : ""}</td>
      <td data-label="Quantità">${fmt(p.qty, p.qty % 1 ? 3 : 0)}</td>
      <td data-label="Prezzo medio">${px(p.avgPrice, p.currency)}</td>
      <td data-label="Prezzo oggi">${px(p.price, p.currency)}${p.changePct != null ? ` <small class="${p.changePct >= 0 ? "up" : "down"}">${plus(p.changePct)}%</small>` : ""}${p.priceSource && p.priceSource !== "yahoo" ? `<small class="hint">da ${esc(SOURCE_NAMES[p.priceSource] ?? p.priceSource)}</small>` : ""}</td>
      <td data-label="Valore">${p.valueEur != null ? `€ ${fmt(p.valueEur)}` : "—"}</td>
      <td data-label="Risultato" class="${(p.pnl ?? 0) >= 0 ? "up" : "down"}">${p.pnl != null ? `${plus(p.pnl)} ${esc(curSign(p.currency))} · ${plus(p.pnlPct)}%` : "—"}</td>
      <td data-label="Peso">${p.weightPct != null ? `${fmt(p.weightPct, 1)}%` : "—"}</td>
      <td data-label="Stop / obiettivo">${px(p.stopLoss, p.currency)} / ${px(p.target, p.currency)}</td>
      <td data-label=""><div class="row-actions"><button class="btn ghost small" data-h-sell="${p.id}">Ho venduto</button><button class="btn ghost small" data-h-edit="${p.id}">Modifica</button></div></td>
    </tr>`).join("");
  const closed = h.closed.map((c) => `
    <tr>
      <td data-label="Azione"><b>${esc(c.symbol)}</b>${c.agentName ? `<small class="hint">${esc(c.agentName)}</small>` : ""}</td>
      <td data-label="Quantità">${fmt(c.qty, c.qty % 1 ? 3 : 0)}</td>
      <td data-label="Comprata a">${px(c.avgPrice, c.currency)}</td>
      <td data-label="Venduta a">${px(c.sellPrice, c.currency)}</td>
      <td data-label="Risultato" class="${c.pnl >= 0 ? "up" : "down"}">${plus(c.pnl)} ${esc(curSign(c.currency))} · ${plus(c.pnlPct)}%</td>
      <td data-label="Chiusa il">${when(c.closedAt)}</td>
    </tr>`).join("");
  $("#holdings-body").innerHTML = `
    <div class="kpis">
      <div class="kpi"><small>Valore delle azioni</small><b>€ ${fmt(t.value)}</b></div>
      <div class="kpi"><small>Guadagno o perdita</small><b class="${(t.pnl ?? 0) >= 0 ? "up" : "down"}">${t.cost ? `${plus(t.pnl)} € · ${plus(t.pnlPct)}%` : "—"}</b></div>
      <div class="kpi"><small>Azioni in portafoglio</small><b>${t.count}</b></div>
      <div class="kpi"><small>Vendite chiuse (vinte / perse)</small><b>${t.wins} / ${t.losses}</b></div>
    </div>
    ${h.missing?.length ? `<p class="hint">⚠️ Prezzi mancanti (non contano nel totale): ${esc(h.missing.join(" · "))}</p>` : ""}
    <div class="row wrap"><button class="btn primary" data-h-add>+ Aggiungi un'azione che hai già</button><button class="btn ghost" data-h-profile>🎯 Il mio profilo d'investimento</button><button class="btn ghost" data-h-sources>🔌 Fonti dei dati${sourcesBadge()}</button><span class="hint">Valori in euro al cambio di oggi; prezzi da Yahoo Finance (e dalle fonti di riserva se Yahoo non risponde).</span></div>
    <div id="holding-form-box">${holdingFormHtml(h)}</div>
    <h4>Le mie azioni</h4>
    ${rows ? `<div class="table-box"><table class="stack holdings-table"><tr><th>Azione</th><th>Quantità</th><th>Prezzo medio</th><th>Prezzo oggi</th><th>Valore</th><th>Risultato</th><th>Peso</th><th>Stop / obiettivo</th><th></th></tr>${rows}</table></div>`
      : `<p class="empty">Nessuna azione per ora. Quando approvi un segnale d'acquisto in ✅ Approvazioni (scrivendo quante azioni hai comprato) compare qui. Se hai già delle azioni, aggiungile con il pulsante qui sopra.</p>`}
    <h4>Vendite chiuse · risultato realizzato: ${realized}</h4>
    ${closed ? `<div class="table-box"><table class="stack holdings-table"><tr><th>Azione</th><th>Quantità</th><th>Comprata a</th><th>Venduta a</th><th>Risultato</th><th>Chiusa il</th></tr>${closed}</table></div>` : `<p class="empty">Nessuna vendita ancora.</p>`}
    <p class="hint">Profilo: ${pr.capital ? `capitale € ${fmt(pr.capital, 0)}` : "capitale non indicato"} · rischio ${esc(pr.risk)} · orizzonte ${esc(horizonText[pr.horizon] ?? pr.horizon)}${pr.markets ? ` · mercati: ${esc(pr.markets)}` : ""}${pr.sectors ? ` · settori: ${esc(pr.sectors)}` : ""}. Gli agenti lo usano per scegliere le azioni e quanto suggerirti di comprare. I segnali sono analisi automatiche, non consulenza: decidi tu.</p>`;
  bindHoldings();
}

function sourcesBadge() {
  const s = state.priceSources;
  if (!s) return "";
  const n = Object.values(s).filter((x) => x.configured).length;
  return n ? ` <small>· ${n} attive</small>` : "";
}

function holdingFormHtml(h) {
  const m = holdingForm.mode;
  if (!m) return "";
  const p = h.positions.find((x) => x.id === holdingForm.id);
  const num = inputNum;
  const field = (name, label, value = "", extra = "") => `<label>${label}<input name="${name}" inputmode="decimal" autocomplete="off" value="${esc(value)}" ${extra}></label>`;
  const foot = (ok) => `<div class="row wrap"><button class="btn good" type="submit">${ok}</button><button class="btn ghost" type="button" data-h-close>Annulla</button><span class="errors"></span></div>`;
  if (m === "add") return `<form class="card holding-form" data-h-form="add">
    <h3>Aggiungi un'azione che hai già</h3>
    <div class="grid3">
      <label>Simbolo (come su Yahoo Finance)<input name="symbol" autocomplete="off" autocapitalize="characters" placeholder="es. AAPL, ENI.MI, ISP.MI" required></label>
      ${field("qty", "Quante azioni", "", "required")}
      ${field("price", "Prezzo medio pagato (valuta del titolo)", "", "required")}
      ${field("fees", "Commissioni (facoltative)")}
      ${field("stopLoss", "Stop loss (facoltativo)")}
      ${field("target", "Obiettivo (facoltativo)")}
      <label>Data d'acquisto<input name="date" type="date"></label>
    </div>${foot("Aggiungi")}</form>`;
  if (m === "sell" && p) return `<form class="card holding-form" data-h-form="sell">
    <h3>Ho venduto ${esc(p.symbol)} <span class="meta">ne hai ${fmt(p.qty, p.qty % 1 ? 3 : 0)}</span></h3>
    <div class="grid3">${field("qty", "Quante azioni hai venduto", num(p.qty), "required")}${field("price", `Prezzo incassato per azione (${esc(p.currency || "")})`, num(p.price), "required")}${field("fees", "Commissioni (facoltative)")}</div>
    ${foot("Conferma vendita")}</form>`;
  if (m === "edit" && p) return `<form class="card holding-form" data-h-form="edit">
    <h3>Modifica ${esc(p.symbol)}</h3>
    <div class="grid3">${field("qty", "Quantità", num(p.qty))}${field("avgPrice", "Prezzo medio", num(p.avgPrice))}${field("stopLoss", "Stop loss (vuoto = nessuno)", num(p.stopLoss))}${field("target", "Obiettivo (vuoto = nessuno)", num(p.target))}</div>
    <label>Note<input name="notes" value="${esc(p.notes ?? "")}" autocomplete="off"></label>
    <div class="row wrap"><button class="btn good" type="submit">Salva</button><button class="btn ghost" type="button" data-h-close>Annulla</button><span class="spacer"></span><button class="btn danger" type="button" data-h-remove="${p.id}">Togli (inserita per sbaglio)</button><span class="errors"></span></div></form>`;
  if (m === "sources") {
    const s = state.priceSources ?? {};
    const row = (id, site, help) => {
      const x = s[id] ?? {};
      return `<fieldset><legend>${esc(SOURCE_NAMES[id])} ${x.configured ? `<span class="up">· attiva (${esc(x.hint)})</span>` : "· non impostata"}</legend>
        <p class="hint">${help}</p>
        <div class="row wrap"><input name="${id}" type="password" autocomplete="off" placeholder="${x.configured ? "Incolla una chiave nuova per cambiarla" : "Incolla qui la chiave gratuita"}">
        ${x.configured ? `<button class="btn ghost small" type="button" data-h-src-remove="${id}">Togli</button>` : ""}</div>
        <span class="hint">Sito: ${esc(site)}</span></fieldset>`;
    };
    const sec = s.sec ?? {};
    return `<form class="card holding-form" data-h-form="sources">
    <h3>🔌 Fonti dei dati</h3>
    <p class="hint">Prezzi: il programma usa Yahoo Finance e, se non risponde, queste fonti di riserva (gratis, con una chiave tua). Finnhub dà anche calendario delle IPO, dei risultati e notizie; la SEC i bilanci ufficiali delle società USA e i portafogli dei grandi fondi. Gli agenti li usano invece di cercare sul web: meno errori e meno spesa.</p>
    ${row("twelvedata", "twelvedata.com", "Crea un account gratuito, poi nel tuo pannello apri «API Keys» e copia la chiave. Piano gratuito: circa 800 prezzi al giorno.")}
    ${row("fmp", "financialmodelingprep.com", "Crea un account gratuito, poi in «Dashboard» copia la «API Key». Piano gratuito: circa 250 prezzi al giorno, soprattutto azioni USA.")}
    ${row("finnhub", "finnhub.io", "Crea un account gratuito: la chiave («API key») è nella pagina principale del tuo pannello. Serve per IPO, risultati trimestrali e notizie.")}
    <fieldset><legend>${esc(SOURCE_NAMES.sec)} ${sec.configured ? `<span class="up">· attiva</span>` : "· non impostata"}</legend>
      <p class="hint">Gratis e senza chiave: la SEC chiede solo nome ed email di chi scarica i dati (es. «Mario Rossi mario@esempio.it»). Non è una password.</p>
      <div class="row wrap"><input name="sec" autocomplete="off" value="${esc(sec.contact ?? "")}" placeholder="Nome Cognome tua@email.it">
      ${sec.configured ? `<button class="btn ghost small" type="button" data-h-src-remove="sec">Togli</button>` : ""}</div></fieldset>
    ${foot("Salva e prova")}</form>`;
  }
  if (m === "profile") {
    const pr = h.profile;
    const opt = (list, cur, names) => list.map((v) => `<option value="${v}" ${v === cur ? "selected" : ""}>${names[v]}</option>`).join("");
    return `<form class="card holding-form" data-h-form="profile">
    <h3>🎯 Il mio profilo d'investimento</h3>
    <p class="hint">Lo leggono gli agenti delle azioni per scegliere i titoli adatti a te e dirti quanto comprare.</p>
    <div class="grid3">
      ${field("capital", "Capitale da investire in azioni (€)", pr.capital ?? "")}
      <label>Rischio che accetti<select name="risk">${opt(["basso", "medio", "alto"], pr.risk, { basso: "Basso: prima di tutto non perdere", medio: "Medio", alto: "Alto: cerco crescita, accetto oscillazioni forti" })}</select></label>
      <label>Orizzonte<select name="horizon">${opt(["breve", "medio", "lungo"], pr.horizon, { breve: "Breve (settimane)", medio: "Medio (mesi)", lungo: "Lungo (anni)" })}</select></label>
    </div>
    <label>Mercati preferiti<input name="markets" value="${esc(pr.markets)}" placeholder="es. Italia, USA, Europa" autocomplete="off"></label>
    <label>Settori preferiti (o da evitare)<input name="sectors" value="${esc(pr.sectors)}" placeholder="es. tecnologia, energia; niente armi" autocomplete="off"></label>
    <label>Altre indicazioni<input name="notes" value="${esc(pr.notes)}" placeholder="es. voglio dividendi, massimo 10 titoli" autocomplete="off"></label>
    ${foot("Salva profilo")}</form>`;
  }
  return "";
}

function openHoldingForm(mode, id = null) {
  holdingForm.mode = mode;
  holdingForm.id = id;
  $("#holding-form-box").innerHTML = holdingFormHtml(state.holdings);
  bindHoldingForm();
  $("#holding-form-box input")?.focus();
  $("#holding-form-box").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function bindHoldings() {
  const box = $("#holdings-body");
  box.querySelector("[data-h-add]").onclick = () => openHoldingForm("add");
  box.querySelector("[data-h-profile]").onclick = () => openHoldingForm("profile");
  box.querySelector("[data-h-sources]").onclick = () => openHoldingForm("sources");
  box.querySelectorAll("[data-h-sell]").forEach((b) => (b.onclick = () => openHoldingForm("sell", b.dataset.hSell)));
  box.querySelectorAll("[data-h-edit]").forEach((b) => (b.onclick = () => openHoldingForm("edit", b.dataset.hEdit)));
  bindHoldingForm();
}

function bindHoldingForm() {
  const f = $("#holding-form-box form");
  if (!f) return;
  const close = () => {
    holdingForm.mode = null;
    $("#holding-form-box").innerHTML = "";
  };
  f.querySelector("[data-h-close]").onclick = close;
  f.querySelectorAll("[data-h-src-remove]").forEach((b) => (b.onclick = async () => {
    if (!confirm(`Togliere la chiave di ${SOURCE_NAMES[b.dataset.hSrcRemove]}?`)) return;
    try {
      state.priceSources = await api("/api/holdings/sources", { method: "PUT", body: JSON.stringify({ [b.dataset.hSrcRemove]: "" }) });
      openHoldingForm("sources");
    } catch (err) {
      f.querySelector(".errors").textContent = err.message;
    }
  }));
  const remove = f.querySelector("[data-h-remove]");
  if (remove) remove.onclick = async () => {
    if (!confirm("Togliere questa azione dal portafoglio? Non conta come vendita (nessun risultato registrato).")) return;
    try {
      await api(`/api/holdings/${remove.dataset.hRemove}`, { method: "DELETE" });
      close();
      loadHoldings();
    } catch (err) {
      f.querySelector(".errors").textContent = err.message;
    }
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true;
    const v = Object.fromEntries(new FormData(f));
    const id = holdingForm.id;
    const call = {
      add: () => api("/api/holdings", { method: "POST", body: JSON.stringify(v) }),
      sell: () => api(`/api/holdings/${id}/sell`, { method: "POST", body: JSON.stringify(v) }),
      edit: () => api(`/api/holdings/${id}`, { method: "PUT", body: JSON.stringify(v) }),
      profile: () => api("/api/holdings/profile", { method: "PUT", body: JSON.stringify(v) }),
      sources: () => api("/api/holdings/sources", { method: "PUT", body: JSON.stringify(Object.fromEntries(Object.entries(v).filter(([, x]) => x.trim()))) }),
    }[f.dataset.hForm];
    if (f.dataset.hForm === "sources" && !Object.values(v).some((x) => x.trim())) {
      f.querySelector(".errors").textContent = "Incolla almeno una chiave.";
      btn.disabled = false;
      return;
    }
    try {
      const r = await call();
      if (f.dataset.hForm === "sources") {
        state.priceSources = r;
        openHoldingForm("sources");
        $("#holding-form-box .errors").innerHTML = `<span class="up">${esc((r.notes ?? []).join(" ") || "Salvato.")}</span>`;
        loadHoldings();
        return;
      }
      close();
      document.activeElement?.blur();
      loadHoldings();
    } catch (err) {
      f.querySelector(".errors").textContent = err.message;
      btn.disabled = false;
    }
  };
}

$("#reset-btn").onclick = async () => {
  if (!confirm("Azzerare portafoglio, bacheche, approvazioni e log?")) return;
  const body = {};
  if (state.session.auth) {
    body.password = await askPassword("Per azzerare tutto scrivi la password con cui entri nell'app.");
    if (body.password == null) return;
  }
  try {
    await api("/api/reset", { method: "POST", body: JSON.stringify(body) });
  } catch (err) {
    return alert(err.message);
  }
  loadAll();
};

// ---------- broker cTrader e sicurezza ----------

const accountById = (id) => state.broker?.accounts.find((a) => String(a.ctidTraderAccountId) === String(id));
const accountName = (a) => `${a.broker || "cTrader"} ${a.traderLogin ?? a.ctidTraderAccountId}`;
const acctBadge = (isLive) => `<span class="acct ${isLive ? "live" : "demo"}">${isLive ? "REALE" : "demo"}</span>`;

async function loadBroker() {
  state.broker = await api("/api/broker").catch(() => null);
  renderStopControls();
  if (state.view === "broker") renderBroker();
}

let accountsLoading = false;
async function loadBrokerAccounts() {
  if (accountsLoading || !state.broker?.linked) return;
  accountsLoading = true;
  if (!state.brokerAccounts) $("#broker-accounts").innerHTML = `<p class="hint">Carico i conti…</p>`;
  try {
    state.brokerAccounts = await api("/api/broker/accounts");
  } catch (err) {
    state.brokerAccounts = { error: err.message };
  } finally {
    accountsLoading = false;
  }
  if (state.view === "broker") renderBroker();
}

// ---------- storico delle operazioni chiuse ----------

let historyLoading = false;
async function loadBrokerHistory() {
  if (historyLoading || !state.broker?.linked) return;
  historyLoading = true;
  const days = state.historyDays ?? 30;
  try {
    state.brokerHistory = await api(`/api/broker/history?days=${days}`);
  } catch (err) {
    state.brokerHistory = { error: err.message, days };
  } finally {
    historyLoading = false;
  }
  if (state.view === "broker") renderBrokerHistory();
}

const price = (n) => (n == null ? "—" : Number(n).toLocaleString("it-IT", { maximumFractionDigits: 5 }));
const money = (n, cur) => `${n > 0 ? "+" : ""}${fmt(n)}${cur ? ` ${esc(cur)}` : ""}`;
function duration(from, to) {
  if (!from || !to) return "—";
  const min = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 1440) return `${Math.floor(min / 60)} h ${min % 60} min`;
  return `${Math.floor(min / 1440)} g ${Math.floor((min % 1440) / 60)} h`;
}

function renderBrokerHistory() {
  const el = $("#broker-history");
  if (!el) return;
  const days = state.historyDays ?? 30;
  document.querySelectorAll("[data-hist-days]").forEach((b) => b.classList.toggle("primary", Number(b.dataset.histDays) === days));
  const h = state.brokerHistory;
  if (!state.broker?.linked) {
    el.innerHTML = `<p class="empty">Collega cTrader per vedere le operazioni chiuse.</p>`;
    return;
  }
  if (!h || h.days !== days) {
    el.innerHTML = `<p class="hint">Carico le operazioni…</p>`;
    return;
  }
  if (h.error) {
    el.innerHTML = `<p class="errors">${esc(h.error)}</p>`;
    return;
  }
  const errors = (h.errors ?? []).length ? `<p class="errors">${h.errors.map(esc).join("<br/>")}</p>` : "";
  if (!h.trades.length) {
    el.innerHTML = `${errors}<p class="empty">Nessuna operazione chiusa negli ultimi ${days} giorni.</p>`;
    return;
  }
  const t = h.totals;
  const cur = t.currencies.length === 1 ? t.currencies[0] : "";
  const agentName = (id) => (id ? state.office.agents.find((a) => a.id === id)?.name ?? id : "a mano / fuori dall'app");
  el.innerHTML = `${errors}
    <div class="kpis hist-kpis">
      <div class="kpi"><small>Risultato netto (${days} giorni)</small><b class="${t.net >= 0 ? "up" : "down"}">${money(t.net, cur)}</b></div>
      <div class="kpi"><small>Operazioni</small><b>${t.count}</b><small>${t.wins} vinte · ${t.losses} perse · ${t.winRate}% vinte</small></div>
      <div class="kpi"><small>Vinto / perso</small><b><span class="up">${money(t.won, cur)}</span></b><small class="down">${money(t.lost, cur)}</small></div>
      <div class="kpi"><small>Migliore / peggiore</small><b class="up">${money(t.best.net, cur)}</b><small class="down">${money(t.worst.net, cur)} · ${esc(t.worst.symbol)}</small></div>
    </div>
    ${Object.keys(t.byAgent).length > 1 ? `<p class="hint">Per agente: ${Object.entries(t.byAgent).sort((a, b) => b[1].net - a[1].net).map(([id, a]) => `<b>${esc(agentName(id === "a mano" ? null : id))}</b> <span class="${a.net >= 0 ? "up" : "down"}">${money(a.net, cur)}</span> (${a.trades}, ${a.wins} vinte)`).join(" · ")}</p>` : ""}
    <table class="stack hist-table"><tr><th>Chiusa</th><th>Mercato</th><th>Operazione</th><th>Lotti</th><th>Entrata → uscita</th><th>Durata</th><th>Agente</th><th>Risultato</th></tr>
      ${h.trades.map((x) => `<tr>
        <td data-label="Chiusa">${when(x.closedAt)}${x.isLive ? ` ${acctBadge(true)}` : ""}</td>
        <td data-label="Mercato"><b>${esc(x.symbol)}</b></td>
        <td data-label="Operazione" class="${x.side === "buy" ? "up" : "down"}">${x.side === "buy" ? "acquisto" : "vendita"}</td>
        <td data-label="Lotti">${fmt(x.lots)}</td>
        <td data-label="Entrata → uscita">${price(x.entryPrice)} → ${price(x.closePrice)}</td>
        <td data-label="Durata">${duration(x.openedAt, x.closedAt)}</td>
        <td data-label="Agente">${esc(agentName(x.agentId))}${x.openReason ? `<small class="hint">${esc(x.openReason)}</small>` : ""}</td>
        <td data-label="Risultato" class="hist-result"><b class="${x.net >= 0 ? "up" : "down"}">${money(x.net, x.currency)}</b>
          <small class="hint">lordo ${money(x.gross)} · swap ${money(x.swap)} · commissioni ${money(x.commission)}${x.closeReason ? ` · chiusa: ${esc(x.closeReason)}` : ""}</small></td>
      </tr>`).join("")}
    </table>`;
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-hist-days]");
  if (!b) return;
  state.historyDays = Number(b.dataset.histDays);
  renderBrokerHistory();
  loadBrokerHistory();
});

// ---------- banco di prova dei sistemi ----------

async function loadBacktests() {
  try {
    state.backtests = await api("/api/backtests");
  } catch (err) {
    state.backtests = { error: err.message };
  }
  if (state.view === "broker") renderBacktests();
}

function renderBacktests() {
  const el = $("#backtests");
  if (!el) return;
  const b = state.backtests;
  if (!b) {
    el.innerHTML = `<p class="hint">Carico le prove…</p>`;
    return;
  }
  if (b.error) {
    el.innerHTML = `<p class="errors">${esc(b.error)}</p>`;
    return;
  }
  if (!b.length) {
    el.innerHTML = `<p class="empty">Nessuna prova ancora. Le fa l'agente di ricerca dei sistemi (strumento backtest) oppure Orion se glielo chiedi.</p>`;
    return;
  }
  const badge = (e) => `<b class="${e === "SUPERATO" ? "up" : e === "BOCCIATO" ? "down" : ""}">${esc(e ?? "—")}</b>`;
  const day = (d) => (d ? new Date(d).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "—");
  el.innerHTML = `<table class="stack bt-table"><tr><th>Quando</th><th>Sistema</th><th>Mercato</th><th>Dati</th><th>Operazioni</th><th>Guadagno medio</th><th>Perdita massima</th><th>Verdetto</th></tr>
    ${b.map((x) => `<tr>
      <td data-label="Quando">${when(x.at)}</td>
      <td data-label="Sistema"><b>${esc(x.label ?? x.system)}</b></td>
      <td data-label="Mercato">${esc(x.symbol)} · ${esc(x.period)}</td>
      <td data-label="Dati">${day(x.from)} → ${day(x.to)}</td>
      <td data-label="Operazioni">${x.trades ?? 0}${x.winRate != null ? ` · ${fmt(x.winRate, 0)}% vinte` : ""}</td>
      <td data-label="Guadagno medio">${x.expectancyR == null ? "—" : `<span class="${x.expectancyR > 0 ? "up" : "down"}">${fmt(x.expectancyR)} R</span>`}${x.yearlyPct != null ? `<small class="hint">${fmt(x.yearlyPct, 1)}% l'anno rischiando ${fmt(x.riskPct, 1)}%</small>` : ""}</td>
      <td data-label="Perdita massima">${x.maxDrawdownPct == null ? "—" : `${fmt(x.maxDrawdownPct, 1)}%`}</td>
      <td data-label="Verdetto">${badge(x.verdict?.esito)}<small class="hint">${esc(x.verdict?.motivo ?? "")}</small></td>
    </tr>`).join("")}</table>`;
}

/** Non riscrive un modulo mentre l'utente ci sta scrivendo. */
const editing = (el) => el.contains(document.activeElement) && document.activeElement !== el;

function renderBroker() {
  const b = state.broker;
  if (!b) {
    $("#app-status").innerHTML = `<p class="errors">Non riesco a leggere lo stato del broker.</p>`;
    return;
  }
  const ks = b.safety.killSwitch;

  // STOP
  $("#stop-banner").classList.toggle("hidden", !ks.active);
  $("#stop-banner").innerHTML = ks.active
    ? `<b>⛔ STOP attivo</b> dal ${when(ks.at)} — ${esc(ks.reason)}. Gli agenti non possono aprire né chiudere posizioni e non partono in automatico.
       <button class="btn good" id="resume-btn">Riattiva gli ordini</button>`
    : "";
  $("#stop-btn").textContent = ks.active ? "⛔ STOP attivo" : "⛔ STOP";
  $("#stop-btn").disabled = ks.active;
  $("#resume-btn")?.addEventListener("click", resumeOrders);

  // Passo 1: app (l'indirizzo di ritorno lo decide il server: localhost sul Mac, l'indirizzo https sul server online)
  $("#redirect-uri").textContent = b.redirectUri;
  $("#redirect-base").textContent = b.redirectUri;
  $("#code-form").input.placeholder = `${b.redirectUri}?code=…`;
  $("#app-status").innerHTML = b.configured
    ? `<p class="ok-line">✔ App salvata (Client ID ${esc(b.clientId)}). Per cambiarla incolla nuove credenziali qui sotto.</p>`
    : `<p class="hint">Serve una volta sola: cTrader ti dà un <b>Client ID</b> e un <b>Secret</b> per far parlare questo programma con il tuo conto.</p>`;
  if (state.brokerConfigured !== b.configured) $("#app-howto").open = !b.configured; // solo quando cambia
  state.brokerConfigured = b.configured;
  $("#step-app").classList.toggle("done", b.configured);

  // Passo 2: collegamento
  const nDemo = b.accounts.filter((a) => !a.isLive).length;
  const nLive = b.accounts.length - nDemo;
  $("#link-status").innerHTML = !b.configured
    ? `<p class="hint">Prima completa il passo 1.</p>`
    : b.linked
      ? `<p class="ok-line">✔ Collegato: ${b.accounts.length} conti (${nDemo} demo, ${nLive} reali).${b.scope === "SCOPE_VIEW" ? " ⚠️ Hai concesso solo la lettura: gli ordini non sono consentiti. Premi «Ricollega» e concedi il trading." : ""}</p>`
      : `<p class="hint">Premi il pulsante: si apre la pagina di cTrader, accedi e premi <b>Allow access</b>. Poi torni qui da solo.</p>`;
  if (b.lastError) $("#link-status").innerHTML += `<p class="hint warn-line">Ultimo errore: ${esc(b.lastError)}</p>`;
  $("#ctrader-connect").disabled = !b.configured;
  $("#ctrader-connect").textContent = b.linked ? "🔗 Ricollega" : "🔗 Collega cTrader";
  $("#ctrader-refresh").classList.toggle("hidden", !b.linked);
  $("#ctrader-unlink").classList.toggle("hidden", !b.linked);
  $("#step-link").classList.toggle("done", b.linked);

  // Conti
  const infos = Array.isArray(state.brokerAccounts) ? state.brokerAccounts : [];
  const infoOf = (id) => infos.find((x) => String(x.accountId) === String(id));
  $("#broker-accounts").innerHTML = !b.linked
    ? `<p class="empty">Nessun conto collegato.</p>`
    : `<table class="stack"><tr><th>Conto</th><th>Tipo</th><th>Saldo</th><th>Leva</th><th>Posizioni</th><th>Dati</th></tr>
      ${b.accounts.map((a) => {
        const x = infoOf(a.ctidTraderAccountId);
        const i = x?.info;
        return `<tr>
          <td data-label="Conto">${esc(accountName(a))}${i?.accountType && i.accountType !== "HEDGED" ? ` <small class="warn-line">(${esc(i.accountType)}: non adatto agli agenti)</small>` : ""}</td>
          <td data-label="Tipo">${acctBadge(a.isLive)}</td>
          <td data-label="Saldo">${x?.error ? `<span class="down" title="${esc(x.error)}">errore</span>` : i ? `${fmt(i.balance)} ${esc(i.currency)}` : "…"}</td>
          <td data-label="Leva">${i?.leverage ? `1:${fmt(i.leverage, 0)}` : "—"}</td>
          <td data-label="Posizioni">${x?.positions ? x.positions.length : "—"}</td>
          <td data-label="Prezzi e grafici da qui"><input type="radio" name="data-account" value="${a.ctidTraderAccountId}" ${String(b.dataAccountId) === String(a.ctidTraderAccountId) ? "checked" : ""} title="Usa questo conto per prezzi e grafici" /></td>
        </tr>`;
      }).join("")}</table>
      ${state.brokerAccounts?.error ? `<p class="errors">${esc(state.brokerAccounts.error)}</p>` : ""}
      <button class="btn small" id="reload-accounts">↻ Aggiorna saldi e posizioni</button>`;
  $("#broker-accounts").querySelectorAll('input[name="data-account"]').forEach((r) => {
    r.onchange = () => brokerCall("/api/broker/data-account", "PUT", { accountId: Number(r.value) });
  });
  $("#reload-accounts")?.addEventListener("click", loadBrokerAccounts);
  $("#symbol-search").classList.toggle("hidden", !b.linked);

  // Piani (non si ricostruisce mentre l'utente ha un menu aperto)
  const live = b.safety.liveEnabled;
  if (!editing($("#broker-floors"))) $("#broker-floors").innerHTML = b.floors.length
    ? `<table class="floors-trading"><tr><th>Piano</th><th>Dove opera</th></tr>
      ${b.floors.slice().reverse().map((f) => {
        const cur = f.trading?.mode === "ctrader" ? String(f.trading.accountId) : "paper";
        const missing = cur !== "paper" && !accountById(cur);
        return `<tr><td><span class="floor-dot inline" style="--c:${esc(f.color)}"></span>${esc(floorLabel(floorById(f.id) ?? f))}</td><td>
          <select data-floor-trading="${esc(f.id)}">
            <option value="paper" ${cur === "paper" ? "selected" : ""}>Portafoglio simulato</option>
            ${b.accounts.map((a) => `<option value="${a.ctidTraderAccountId}" ${cur === String(a.ctidTraderAccountId) ? "selected" : ""} ${a.isLive && !live ? "disabled" : ""}>
              ${a.isLive ? "⚠️ REALE" : "Demo"} · ${esc(accountName(a))}${a.isLive && !live ? " (bloccato)" : ""}</option>`).join("")}
            ${missing ? `<option value="${esc(cur)}" selected>Conto ${esc(cur)} (non più disponibile)</option>` : ""}
          </select></td></tr>`;
      }).join("")}</table>`
    : `<p class="empty">Nessun piano.</p>`;
  $("#broker-floors").querySelectorAll("[data-floor-trading]").forEach((sel) => {
    sel.onchange = async () => {
      sel.blur(); // così dopo l'operazione (o se annulli) la tabella mostra lo stato vero
      const acc = accountById(sel.value);
      if (acc?.isLive && !confirm(`Collegare il piano al CONTO REALE ${accountName(acc)}?\n\nGli agenti di questo piano potranno usare soldi veri (sempre entro i limiti di sicurezza e le approvazioni).`)) {
        return renderBroker();
      }
      await brokerCall(`/api/floors/${encodeURIComponent(sel.dataset.floorTrading)}/trading`, "PUT",
        sel.value === "paper" ? { mode: "paper" } : { mode: "ctrader", accountId: Number(sel.value) });
    };
  });

  // Posizioni
  const rows = infos.flatMap((x) => (x.positions ?? []).map((p) => ({ ...p, accountId: x.accountId, acc: accountById(x.accountId), currency: x.info?.currency ?? "" })));
  $("#broker-positions").innerHTML = !b.linked
    ? `<p class="empty">—</p>`
    : rows.length
      ? `<table class="stack"><tr><th>Strumento</th><th>Conto</th><th>Lato</th><th>Lotti</th><th>Apertura</th><th>Stop loss</th><th>Take profit</th><th>P&L</th><th>Aperta da</th><th></th></tr>
        ${rows.map((p) => `<tr>
          <td data-label="Strumento">${esc(p.symbol)}</td><td data-label="Conto">${p.acc ? acctBadge(p.acc.isLive) : ""} ${esc(p.acc?.traderLogin ?? p.accountId)}</td>
          <td data-label="Lato" class="${p.side === "buy" ? "up" : "down"}">${p.side === "buy" ? "acquisto" : "vendita"}</td>
          <td data-label="Lotti">${fmt(p.lots, 2)}</td><td data-label="Apertura">${p.price ?? "—"}</td><td data-label="Stop loss">${p.stopLoss ?? "—"}</td><td data-label="Take profit">${p.takeProfit ?? "—"}</td>
          <td data-label="P&L" class="${(p.pnl ?? 0) >= 0 ? "up" : "down"}">${p.pnl == null ? "—" : `${fmt(p.pnl)} ${esc(p.currency)}`}</td>
          <td data-label="Aperta da">${p.label.startsWith("agenti:") ? `🤖 ${esc(p.label.slice(7))}` : "te (manuale)"}</td>
          <td class="act"><button class="btn small danger" data-close-pos="${p.accountId}|${p.positionId}">Chiudi</button></td>
        </tr>`).join("")}</table>`
      : state.brokerAccounts ? `<p class="empty">Nessuna posizione aperta.</p>` : `<p class="hint">Carico…</p>`;
  $("#broker-positions").querySelectorAll("[data-close-pos]").forEach((btn) => {
    btn.onclick = async () => {
      const [acc, pos] = btn.dataset.closePos.split("|");
      if (!confirm("Chiudere questa posizione a mercato?")) return;
      btn.disabled = true;
      await brokerCall(`/api/broker/positions/${acc}/${pos}/close`, "POST", {});
      loadBrokerAccounts();
    };
  });

  // Sicurezza: limiti (non si riscrivono finché ci sono modifiche non salvate)
  const lf = $("#limits-form");
  if (!lf.dataset.dirty) {
    const L = b.safety.limits;
    for (const k of ["maxLotsPerOrder", "maxOpenPositions", "maxOrdersPerDay", "maxDailyLossPct", "defaultStopLossPct"]) lf[k].value = L[k];
    lf.requireStopLoss.checked = L.requireStopLoss;
    lf.closeOnStop.checked = L.closeOnStop;
  }

  // Oggi
  const day = b.safety.daily;
  const accDays = Object.entries(day.accounts ?? {});
  $("#today-box").innerHTML = `<h3>Oggi</h3>
    ${accDays.length
      ? `<table class="stack"><tr><th>Conto</th><th>Ordini</th><th>Inizio giornata</th><th>Adesso</th><th>Perdita</th></tr>
        ${accDays.map(([id, d]) => {
          const a = accountById(id);
          return `<tr class="${d.breached ? "breached" : ""}"><td data-label="Conto">${a ? `${acctBadge(a.isLive)} ${esc(a.traderLogin ?? id)}` : esc(id)}</td><td data-label="Ordini">${d.orders} / ${b.safety.limits.maxOrdersPerDay}</td>
            <td data-label="Inizio giornata">${d.startEquity == null ? "—" : fmt(d.startEquity)}</td><td data-label="Adesso">${d.equity == null ? "—" : fmt(d.equity)}</td>
            <td data-label="Perdita" class="${(d.lossPct ?? 0) > 0 ? "down" : "up"}">${d.startEquity == null ? "—" : `${fmt(d.lossPct ?? 0)}%`}${d.breached ? " ⛔" : ""}</td></tr>`;
        }).join("")}</table>
        ${accDays.some(([, d]) => d.breached) ? `<p class="hint warn-line">⛔ = limite di perdita superato: su quel conto gli agenti non possono aprire posizioni fino a domani (il giorno cambia alle 00:00 UTC), anche se riattivi gli ordini. Per sbloccarlo prima, alza la perdita massima.</p>` : ""}`
      : `<p class="hint">Ancora nessun ordine o controllo sul broker oggi.</p>`}
    <p class="hint">Il valore dei conti usati dai piani viene controllato ogni minuto (depositi e prelievi non contano).</p>`;

  // Conto reale
  const liveForm = $("#live-form");
  if (!editing(liveForm) && !liveForm.dataset.dirty) {
    liveForm.innerHTML = live
      ? `<h3>⚠️ Conto reale SBLOCCATO</h3>
         <p class="hint">Puoi collegare i piani ai conti reali. Gli agenti operano con soldi veri, entro i limiti qui accanto.</p>
         <div class="row"><button class="btn" type="submit">🔒 Blocca di nuovo</button></div>
         <p class="hint">Bloccandolo, i piani collegati a un conto reale tornano al portafoglio simulato.</p>`
      : `<h3>🔒 Conto reale bloccato</h3>
         <p class="hint">Finché è bloccato gli agenti possono usare solo conti <b>demo</b>. Sbloccalo solo dopo aver provato a lungo il sistema sul demo.</p>
         <label>Per sbloccarlo scrivi <b>${esc(b.liveConfirm)}</b> <input name="confirm" autocomplete="off" spellcheck="false" /></label>
         ${state.session.auth ? `<label>e la password con cui entri nell'app <input name="password" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" /></label>` : ""}
         <div class="row"><button class="btn danger" type="submit">Sblocca il conto reale</button></div>`;
  }

  // Ultimi ordini sul broker
  $("#broker-trades").innerHTML = b.trades.length
    ? `<table class="stack"><tr><th>Quando</th><th>Agente</th><th>Conto</th><th>Operazione</th><th>Strumento</th><th>Lotti</th><th>Prezzo</th></tr>
      ${b.trades.map((t) => `<tr title="${esc(t.reason)}"><td data-label="Quando">${when(t.at)}</td><td data-label="Agente">${esc(t.agentId)}</td><td data-label="Conto">${acctBadge(t.isLive)} ${esc(accountById(t.accountId)?.traderLogin ?? t.accountId)}</td>
        <td data-label="Operazione" class="${t.side === "buy" ? "up" : "down"}">${t.action === "close" ? "chiusura" : t.side === "buy" ? "acquisto" : "vendita"}</td>
        <td data-label="Strumento">${esc(t.symbol)}</td><td data-label="Lotti">${fmt(t.lots)}</td><td data-label="Prezzo">${t.status === "incerto" ? '<span class="warn-line" title="Connessione interrotta durante l\'invio">esito incerto</span>' : t.status === "accepted" ? `${esc(t.price ?? "—")} <small class="hint">(da confermare)</small>` : esc(t.price ?? "—")}</td></tr>`).join("")}</table>`
    : `<p class="empty">Nessun ordine degli agenti sul broker.</p>`;
  renderBrokerHistory();
  renderBacktests();
}

/** Chiamata al server per il broker: mostra l'errore e aggiorna lo stato. */
async function brokerCall(path, method, body, errorsEl = "#link-errors-broker") {
  $(errorsEl).textContent = "";
  try {
    const r = await api(path, { method, body: JSON.stringify(body ?? {}) });
    await loadBroker();
    return r;
  } catch (err) {
    $(errorsEl).textContent = err.message;
    if (errorsEl === "#link-errors-broker") alert(err.message);
    await loadBroker();
    return null;
  }
}

$("#copy-redirect").onclick = async () => {
  try {
    await navigator.clipboard.writeText(state.broker.redirectUri);
    $("#copy-redirect").textContent = "Copiato ✔";
  } catch {
    prompt("Copia questo indirizzo:", state.broker.redirectUri);
  }
};
$("#app-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const r = await brokerCall("/api/broker/credentials", "PUT", { clientId: f.clientId.value, clientSecret: f.clientSecret.value }, "#app-errors");
  if (r) f.reset();
});
$("#ctrader-connect").onclick = async () => {
  // La finestra si apre subito (altrimenti il browser la blocca), poi riceve l'indirizzo di cTrader.
  const win = window.open("about:blank", "_blank");
  try {
    const { url } = await api("/api/broker/auth", { method: "POST" });
    if (win) win.location.href = url;
    else location.href = url;
  } catch (err) {
    win?.close();
    alert(err.message);
  }
};
$("#code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await brokerCall("/api/broker/code", "POST", { input: e.target.input.value });
  if (r) {
    e.target.reset();
    state.brokerAccounts = null;
    loadBrokerAccounts();
  }
});
$("#ctrader-refresh").onclick = async () => {
  await brokerCall("/api/broker/refresh-accounts", "POST");
  loadBrokerAccounts();
};
$("#ctrader-unlink").onclick = async () => {
  if (!confirm("Scollegare cTrader? I piani collegati a un conto non potranno più fare ordini finché non lo ricolleghi.")) return;
  await brokerCall("/api/broker/unlink", "POST");
  state.brokerAccounts = null;
};
$("#symbol-search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (!q) return;
  $("#symbol-results").innerHTML = `<p class="hint">Cerco…</p>`;
  try {
    const list = await api(`/api/broker/search?q=${encodeURIComponent(q)}`);
    $("#symbol-results").innerHTML = list.length
      ? `<p class="hint">Clicca un nome per copiarlo (da usare nelle watchlist degli agenti).</p>` +
        list.map((x) => `<button class="chip" data-sym="${esc(x.symbol)}" title="${esc(x.description)}"><b>${esc(x.symbol)}</b> ${esc(x.description)}</button>`).join("")
      : `<p class="hint">Nessuno strumento trovato.</p>`;
    $("#symbol-results").querySelectorAll("[data-sym]").forEach((c) => {
      c.onclick = () => navigator.clipboard?.writeText(c.dataset.sym).then(() => (c.classList.add("active")));
    });
  } catch (err) {
    $("#symbol-results").innerHTML = `<p class="errors">${esc(err.message)}</p>`;
  }
});

async function pressStop() {
  if (!confirm("⛔ Fermare subito tutti gli ordini degli agenti?\n\nNessun agente potrà aprire o chiudere posizioni finché non riattivi gli ordini.")) return;
  const closePositions = state.broker?.linked && confirm("Vuoi anche CHIUDERE ADESSO tutte le posizioni aperte dagli agenti sui conti cTrader?\n\nOK = chiudi le posizioni · Annulla = lasciale aperte");
  const r = await brokerCall("/api/safety/stop", "POST", { closePositions });
  if (r && closePositions) {
    let msg = `Chiuse ${r.closed} posizioni aperte dagli agenti.`;
    if (r.unconfirmed) msg += `\n${r.unconfirmed} chiusure inviate ma non ancora confermate.`;
    if (r.failed?.length) {
      msg += `\n\n⚠️ NON CHIUSE (chiudile da «Posizioni aperte» o direttamente in cTrader):\n` +
        r.failed.map((f) => {
          const a = accountById(f.accountId);
          return `• ${f.symbol} (conto ${a ? `${a.isLive ? "REALE" : "demo"} ${a.traderLogin ?? f.accountId}` : f.accountId}): ${f.error}`;
        }).join("\n");
    }
    alert(msg);
  }
  refreshStats();
  loadBrokerAccounts();
}
async function resumeOrders() {
  if (!confirm("Riattivare gli ordini degli agenti?")) return;
  await brokerCall("/api/safety/resume", "POST");
  refreshStats();
}
$("#stop-btn").onclick = pressStop;
$("#stop-cta").onclick = () => (state.broker?.safety.killSwitch.active ? showView("broker") : pressStop());

const limitsForm = $("#limits-form");
for (const ev of ["input", "change"]) {
  limitsForm.addEventListener(ev, () => {
    limitsForm.dataset.dirty = "1";
    $("#limits-saved").textContent = "Modifiche non salvate";
  });
}
limitsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = Object.fromEntries(["maxLotsPerOrder", "maxOpenPositions", "maxOrdersPerDay", "maxDailyLossPct", "defaultStopLossPct"].map((k) => [k, f[k].value]));
  body.requireStopLoss = f.requireStopLoss.checked;
  body.closeOnStop = f.closeOnStop.checked;
  $("#limits-errors").textContent = "";
  try {
    await api("/api/safety/limits", { method: "PUT", body: JSON.stringify(body) });
    delete f.dataset.dirty;
    $("#limits-saved").textContent = "Limiti salvati ✔";
    await loadBroker();
  } catch (err) {
    $("#limits-errors").textContent = err.message; // i valori scritti restano nel modulo per correggerli
  }
});
$("#live-form").addEventListener("input", (e) => (e.currentTarget.dataset.dirty = "1"));
$("#live-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  delete e.currentTarget.dataset.dirty;
  const live = state.broker.safety.liveEnabled;
  if (!live && !confirm("Sbloccare il CONTO REALE?\n\nDa ora potrai collegare i piani a conti con soldi veri. Fallo solo dopo aver provato a lungo sul conto demo.")) return;
  const body = { enabled: !live, confirm: e.target.confirm?.value ?? "" };
  if (!live && state.session.auth) body.password = e.target.password?.value ?? ""; // conferma con la password (sul server online)
  document.activeElement?.blur();
  await brokerCall("/api/safety/live", "POST", body);
  loadOffice();
});

// ---------- chat ----------

const SUGGESTIONS = [
  "Cosa sta succedendo in ufficio?",
  "Fai lavorare tutti gli analisti e poi riassumi",
  "Crea un agente che segue le banche italiane",
  "Com'è messo il portafoglio?",
];

function renderChat() {
  const body = $("#chat-body");
  const t = state.chat.transcript;
  body.innerHTML = t.length
    ? t.map((m) => `<div class="msg ${m.role}" data-who="${esc(state.office.assistant.toUpperCase())}">${m.role === "tool" ? "⚙ " : ""}${m.voice ? '<span class="voice-tag" title="Messaggio vocale">🎤</span> ' : ""}${esc(m.text)}</div>`).join("")
    : `<div class="msg assistant" data-who="${esc(state.office.assistant.toUpperCase())}">Ciao! Sono ${esc(state.office.assistant)}, coordino gli agenti dell'ufficio. Chiedimi cosa stanno facendo, fai lavorare qualcuno o descrivimi un nuovo agente da creare.${state.office.llmReady ? "" : "\n\n🔑 Per parlarmi inserisci la chiave di Claude in ⚙️ Impostazioni."}</div>`;
  renderLive();
  $("#chat").classList.toggle("busy", state.chat.busy);
  $("#chat-reset").disabled = state.chat.busy; // non si può azzerare mentre Orion lavora
  renderChatState();
  $("#chat-chips").innerHTML = t.length ? "" : SUGGESTIONS.map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join("");
  $("#chat-chips").querySelectorAll(".chip").forEach((c) => (c.onclick = () => sendChat(c.textContent)));
}

/** Risposta di Orion mentre la scrive (eventi chat-delta): una bolla che si riempie, sostituita dal testo finale. */
let liveFrame = 0;
function renderLive() {
  const body = $("#chat-body");
  let el = $("#chat-live");
  const text = state.chat.busy ? state.chat.live : "";
  if (!text) {
    el?.remove();
  } else {
    if (!el) {
      el = document.createElement("div");
      el.id = "chat-live";
      el.className = "msg assistant live";
      el.dataset.who = state.office.assistant.toUpperCase();
      body.append(el);
    }
    el.textContent = text;
  }
  body.scrollTop = body.scrollHeight;
}
function liveDelta(ev) {
  if (ev.reset) state.chat.live = "";
  if (ev.delta) state.chat.live = (state.chat.live ?? "") + ev.delta;
  if (!liveFrame) liveFrame = requestAnimationFrame(() => ((liveFrame = 0), renderLive()));
}

async function sendChat(text) {
  text = text.trim();
  if (!text || state.chat.busy || voice.sending) return;
  speech.stop(); // messaggio scritto: la lettura della risposta precedente non serve più
  voice.speakTurn = false; // e la risposta a un messaggio scritto non si legge
  $("#chat-input").value = "";
  growChatInput();
  try {
    await api("/api/chat", { method: "POST", body: JSON.stringify({ message: text }) });
  } catch (err) {
    // L'errore compare già nella chat via SSE se il server l'ha registrato; altrimenti lo mostro qui.
    if (!state.chat.transcript.some((m) => m.text.includes(err.message))) {
      state.chat.transcript.push({ role: "system", text: err.message, at: new Date().toISOString() });
      renderChat();
    }
  }
}

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (voice.rec) return finishRecording(); // durante la registrazione ➤ manda il messaggio vocale
  sendChat($("#chat-input").value);
});
$("#chat-input").addEventListener("keydown", (e) => {
  // Sul telefono Invio va a capo (le tastiere touch non hanno Maiusc+Invio): si invia con ➤.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !touchMQ.matches) {
    e.preventDefault();
    sendChat(e.target.value);
  }
});
/** Il campo cresce con il testo (fino al massimo previsto dal foglio di stile, poi scorre). */
function growChatInput() {
  const el = $("#chat-input");
  el.style.height = "";
  if (el.value) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}
$("#chat-input").addEventListener("input", growChatInput);
// I pulsanti della chat non tolgono il cursore al campo: sul telefono la tastiera resta aperta e la pagina non
// si sposta sotto il dito (altrimenti il tocco su ➤ potrebbe finire altrove).
for (const el of [$("#chat-form"), $("#chat-chips")]) el.addEventListener("mousedown", (e) => e.target.closest("button") && e.preventDefault());
$("#chat-reset").onclick = () => api("/api/chat/reset", { method: "POST" }).catch((e) => alert(e.message));

// ---------- messaggi vocali e risposte a voce ----------
// 🎤 registra (tocca ➤ per mandare, ✕ per annullare); il server trascrive e passa il testo a Orion. Se le risposte a
// voce sono accese (🔊, scelta di ogni dispositivo), Orion legge ad alta voce la risposta ai messaggi vocali.

const VOICE_PREF = "agenti.risposteVoce";

function voiceRepliesOn() {
  try {
    return localStorage.getItem(VOICE_PREF) !== "0";
  } catch {
    return true;
  }
}

async function refreshVoiceStatus() {
  const next = await api("/api/voice").catch(() => null);
  if (next) applyVoiceStatus(next);
  else renderVoice();
}

/** Nuovo stato del riconoscimento (dalla diretta o riletto dopo un'interruzione): avvisa quando è pronto o fallito. */
function applyVoiceStatus(next) {
  const was = voice.status?.state;
  voice.status = next;
  const preparing = was === "downloading" || was === "extracting";
  if (next.state === "ready" && preparing) chatNote("✅ Messaggi vocali pronti: tocca 🎤, parla, poi tocca ➤.");
  if ((next.state === "error" || next.state === "unsupported") && was && was !== next.state) chatNote(`Messaggi vocali: ${next.error}`);
  renderVoice();
}

/** Nota nella chat visibile solo su questo dispositivo (non va a Orion). */
function chatNote(text) {
  const t = state.chat.transcript;
  if (t.at(-1)?.local && t.at(-1).text === text) t.pop(); // stessa nota di seguito: si rimette in fondo, si vede che è nuova
  t.push({ role: "system", text, at: new Date().toISOString(), local: true });
  renderChat();
}

function renderChatState() {
  const st = voice.status;
  const pct = Math.round((st?.progress ?? 0) * 100);
  $("#chat-state").textContent = voice.rec
    ? "🔴 Registro: ➤ manda, ✕ annulla"
    : voice.sending && !state.chat.busy
      ? "Trascrivo il messaggio vocale…"
      : state.chat.busy
        ? "Sto lavorando…"
        : st?.state === "downloading"
          ? `Preparo i messaggi vocali… ${pct}%`
          : st?.state === "extracting"
            ? "Preparo i messaggi vocali… ultimo passaggio (1–2 minuti)"
            : recordingSupported()
              ? "Ti ascolto — scrivi o tocca 🎤"
              : "Ti ascolto — scrivi pure";
}

function renderVoice() {
  const mic = $("#chat-mic");
  const st = voice.status?.state;
  const rec = Boolean(voice.rec);
  mic.hidden = !recordingSupported();
  mic.textContent = rec ? "✕" : st === "downloading" || st === "extracting" ? "⏳" : "🎤";
  mic.classList.toggle("on", rec);
  mic.disabled = voice.sending;
  const label = rec ? "Annulla il messaggio vocale" : "Messaggio vocale";
  mic.setAttribute("aria-label", label);
  mic.title = label;
  $("#chat-form").classList.toggle("recording", rec);
  $("#chat-input").hidden = rec;
  $("#rec-bar").hidden = !rec;
  const speak = $("#chat-voice");
  speak.hidden = !speech.speechSupported();
  const on = voiceRepliesOn();
  speak.textContent = on ? "🔊" : "🔇";
  speak.title = on ? "Orion risponde a voce ai messaggi vocali: tocca per spegnere" : "Risposte a voce spente: tocca per accenderle";
  speak.setAttribute("aria-pressed", String(on));
  renderChatState();
}

$("#chat-voice").onclick = () => {
  const on = !voiceRepliesOn();
  try {
    localStorage.setItem(VOICE_PREF, on ? "1" : "0");
  } catch {
    // memoria del browser non disponibile: vale fino alla chiusura
  }
  if (!on) {
    speech.stop();
    voice.speakTurn = false;
  } else speech.unlock();
  renderVoice();
};

$("#chat-mic").onclick = () => {
  if (voice.rec) {
    voice.rec.cancel();
    voice.rec = null;
    return renderVoice();
  }
  startRecording();
};

/** Parte dal tocco su 🎤: il microfono va acceso subito, dentro il tocco (sull'iPhone non funziona dopo). */
function startRecording() {
  if (voice.sending || state.chat.busy) return chatNote(`Aspetta che ${state.office.assistant} finisca di rispondere, poi riprova.`);
  if (!state.office.llmReady) return chatNote("🔑 Per parlare con me inserisci prima la chiave di Claude in ⚙️ Impostazioni.");
  const st = voice.status?.state;
  if (st !== "ready") return prepareVoice();
  speech.stop();
  // Dentro il tocco: sull'iPhone sblocca la voce anche se il messaggio parte da solo al limite dei 2 minuti.
  if (voiceRepliesOn()) speech.unlock();
  const rec = new VoiceRecorder({
    onTick: (sec) => {
      const left = MAX_SECONDS - sec;
      $("#rec-time").textContent = `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
      $("#rec-hint").textContent = left <= 15 ? `ancora ${Math.max(0, Math.ceil(left))} secondi` : "Parla pure…";
    },
    onLimit: () => voice.rec === rec && finishRecording(),
    onInterrupted: (why) => {
      if (voice.rec !== rec) return;
      voice.rec = null;
      renderVoice();
      chatNote(why);
    },
  });
  voice.rec = rec;
  $("#rec-time").textContent = "0:00";
  $("#rec-hint").textContent = "Parla pure…";
  renderVoice();
  rec.start().catch((err) => {
    if (voice.rec !== rec) return;
    voice.rec = null;
    renderVoice();
    chatNote(micErrorText(err));
  });
}

/** La prima volta: si scarica il riconoscimento della voce (con conferma). */
async function prepareVoice() {
  const st = voice.status;
  if (!st) {
    await refreshVoiceStatus();
    if (voice.status?.state === "ready") return chatNote("Messaggi vocali pronti: tocca di nuovo 🎤 e parla.");
    if (!voice.status) return chatNote("Non riesco a sapere se i messaggi vocali sono pronti: controlla la connessione e riprova.");
    return prepareVoice();
  }
  if (st.state === "downloading" || st.state === "extracting") {
    return chatNote("Sto ancora preparando i messaggi vocali: ti avviso qui quando sono pronti.");
  }
  if (st.state === "unsupported") return chatNote(`${st.error} Intanto puoi dettare con il microfono della tastiera.`);
  const where = state.session.cloud ? "sul server" : "su questo computer";
  const retry = st.state === "error" ? `L'ultima volta non è riuscita (${st.error}). ` : "";
  if (!confirm(`${retry}Per i messaggi vocali preparo il riconoscimento della voce ${where}: si scarica una volta sola (circa ${st.downloadMB ?? 560} MB, qualche minuto). Poi la voce resta sul tuo ${state.session.cloud ? "server" : "computer"}, senza servizi esterni. Procedo?`)) return;
  try {
    voice.status = await api("/api/voice/prepare", { method: "POST" });
    chatNote("Preparo i messaggi vocali: ci vuole qualche minuto. Intanto puoi continuare a scrivere, ti avviso qui quando sono pronti.");
  } catch (err) {
    chatNote(err.message);
  }
  renderVoice();
}

/** ➤ durante la registrazione (o il limite di 2 minuti): ferma, manda al server e aspetta la risposta. */
async function finishRecording() {
  const rec = voice.rec;
  if (!rec || voice.sending) return;
  voice.sending = true;
  const speakReply = voiceRepliesOn() && speech.speechSupported();
  if (speakReply) speech.unlock(); // dentro il tocco: sull'iPhone serve per poter leggere la risposta dopo
  let blob = null;
  try {
    blob = await rec.stop();
  } finally {
    voice.rec = null;
    renderVoice();
  }
  if (!blob || blob.size < 44 + 16000) {
    // meno di mezzo secondo
    voice.sending = false;
    renderVoice();
    return chatNote("Messaggio troppo corto: tocca 🎤, parla, poi tocca ➤.");
  }
  voice.speakTurn = speakReply;
  const from = state.chat.transcript.length;
  try {
    const res = await fetch("/api/chat/voice", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: blob });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && body.login) return goLogin();
    if (!res.ok) {
      voice.speakTurn = false;
      if (body.voice) voice.status = body.voice;
      const shown = body.error && state.chat.transcript.slice(from).some((m) => m.text.includes(body.error));
      if (!shown) chatNote(body.error ?? "Messaggio vocale non riuscito: riprova.");
      // Trascritto ma non arrivato a Orion: il testo torna nel campo, così si può rimandare scritto.
      if (body.text && !state.chat.transcript.some((m) => m.role === "user" && m.text === body.text) && !$("#chat-input").value.trim()) {
        $("#chat-input").value = body.text;
        growChatInput();
      }
    }
  } catch {
    voice.speakTurn = false;
    chatNote("Connessione interrotta: se il tuo messaggio non compare qui sopra, riprova.");
  } finally {
    voice.sending = false;
    renderVoice();
  }
}

speech.onSpeakingChange((on) => $("#chat").classList.toggle("speaking", on));

// ---------- impostazioni ----------

const settingsDlg = $("#settings-dialog");
const settingsForm = $("#settings-form");

async function openSettings() {
  settingsForm.key.value = "";
  $("#settings-errors").textContent = "";
  $("#data-errors").textContent = "";
  $("#data-status").textContent = "";
  checkForUpdate();
  renderSchedule();
  renderNotify();
  loadPlatform(); // brief, tasti e idee aggiornati (anche l'elenco dei palazzi)
  api("/api/orion").then((o) => ($("#orion-speed").value = o.speed), () => {});
  $("#speed-status").textContent = "";
  await renderKeyStatus();
  if (!state.office.llmReady) settingsForm.querySelector(".howto").open = true;
  settingsDlg.showModal();
}

$("#orion-speed").addEventListener("change", async (e) => {
  try {
    await api("/api/orion", { method: "PUT", body: JSON.stringify({ speed: e.target.value }) });
    $("#speed-status").textContent = "✔ Salvato";
  } catch (err) {
    $("#speed-status").textContent = err.message;
  }
});

async function renderKeyStatus() {
  const k = await api("/api/settings").catch(() => null);
  const el = $("#key-status");
  if (k?.ready) {
    el.className = "key-status ok";
    el.textContent = `✅ Claude è collegato (chiave ${k.hint ?? ""}${k.source === "env" ? ", dal terminale" : ""}).`;
  } else {
    el.className = "key-status missing";
    el.textContent = "🔑 Nessuna chiave inserita: per ora funzionano solo gli agenti a regole.";
  }
  $("#remove-key").classList.toggle("hidden", k?.source !== "app");
}

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (document.activeElement?.closest("#schedule-box")) return; // Invio nei campi dell'orario: non è il salvataggio della chiave
  const btn = $("#save-key");
  btn.disabled = true;
  btn.textContent = "Verifico…";
  $("#settings-errors").textContent = "";
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ anthropicApiKey: settingsForm.key.value }) });
    settingsForm.key.value = "";
    await renderKeyStatus();
  } catch (err) {
    $("#settings-errors").textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Salva e verifica";
  }
});

$("#remove-key").onclick = async () => {
  if (!confirm("Rimuovere la chiave di Claude da questo computer?")) return;
  await api("/api/settings", { method: "DELETE" });
  renderKeyStatus();
};

settingsDlg.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => settingsDlg.close()));
$("#open-settings").onclick = openSettings;

// ---------- orario di lavoro degli agenti ----------

const DAY_LABELS = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function scheduleText(s, withNow) {
  if (!s.enabled) return "Orario spento: gli agenti programmati lavorano a qualsiasi ora, anche di notte e nel weekend.";
  return s.working
    ? `✅ Adesso gli agenti programmati lavorano${withNow && s.now ? ` (${s.now})` : ""}.`
    : `⏸ Fuori orario: gli agenti programmati ripartono ${s.resume ?? "all'inizio del prossimo orario"}.${s.alsoOpen?.length ? ` Lavora comunque: ${s.alsoOpen.join(", ")}.` : ""}`;
}

async function renderSchedule() {
  const s = await api("/api/schedule").catch(() => null);
  if (!s) return;
  $("#sched-enabled").checked = s.enabled;
  $("#sched-days").innerHTML = DAY_ORDER.map(
    (d) => `<label class="inline"><input type="checkbox" value="${d}" ${s.days.includes(d) ? "checked" : ""} /> ${DAY_LABELS[d]}</label>`,
  ).join("");
  $("#sched-start").value = s.start;
  $("#sched-end").value = s.end;
  $("#sched-friday").checked = s.fridayClose.enabled;
  $("#sched-friday-time").value = s.fridayClose.time;
  $("#schedule-status").textContent = scheduleText(s, true);
  $("#sched-errors").textContent = "";
}

$("#sched-save").onclick = async () => {
  const btn = $("#sched-save");
  btn.disabled = true;
  $("#sched-errors").textContent = "";
  try {
    await api("/api/schedule", {
      method: "PUT",
      body: JSON.stringify({
        enabled: $("#sched-enabled").checked,
        days: [...$("#sched-days").querySelectorAll("input:checked")].map((i) => Number(i.value)),
        start: $("#sched-start").value,
        end: $("#sched-end").value,
        fridayClose: { enabled: $("#sched-friday").checked, time: $("#sched-friday-time").value },
      }),
    });
    await renderSchedule();
    $("#schedule-status").textContent = `Orario salvato. ${$("#schedule-status").textContent}`;
    refreshStats();
  } catch (err) {
    $("#sched-errors").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

// ---------- aggiornamenti ----------

async function checkForUpdate({ quiet } = {}) {
  const status = $("#update-status");
  if (!quiet) status.textContent = "Controllo in corso…";
  $("#update-errors").textContent = "";
  try {
    const u = await api("/api/update");
    state.update = u;
    // Sul server online gli aggiornamenti arrivano da soli (canUpdate false): si mostra solo il motivo.
    const latest = u.latest ? `${u.latest.message} (${u.latest.date ? when(u.latest.date) : u.latest.short})` : "";
    if (!u.canUpdate) status.textContent = u.reason ?? "Gli aggiornamenti dall'app non sono disponibili.";
    else if (!u.installed) status.textContent = `Non so quale versione hai (scaricata a mano). Ultima versione: ${latest}. Aggiorna per essere sicuro di avere l'ultima.`;
    else if (u.available) status.textContent = `È disponibile una nuova versione: ${latest}.`;
    else status.textContent = `Hai l'ultima versione ✅ (${latest}).`;
    const show = Boolean(u.canUpdate && u.available && state.session.updater);
    $("#update-apply").classList.toggle("hidden", !show);
    $("#update-cta").classList.toggle("hidden", !show);
    $("#more-update").classList.toggle("hidden", !show);
  } catch (err) {
    if (!quiet) status.textContent = "";
    $("#update-errors").textContent = quiet ? "" : err.message;
  }
}

$("#update-check").onclick = () => checkForUpdate();
$("#update-cta").onclick = () => openSettings();
$("#update-apply").onclick = async () => {
  if (!confirm("Scaricare e installare la nuova versione? Il programma si riavvierà da solo.")) return;
  const btn = $("#update-apply");
  btn.disabled = true;
  $("#update-status").textContent = "Scarico e installo la nuova versione… (può volerci qualche minuto)";
  try {
    const before = (await api("/api/version")).startedAt;
    const r = await api("/api/update", { method: "POST" });
    if (!r.restarting) {
      $("#update-status").textContent = "Aggiornamento installato ✅. Chiudi il programma e riaprilo con l'icona \"Avvia Agenti\" per usare la nuova versione.";
      return;
    }
    $("#update-status").textContent = "Aggiornamento installato ✅. Riavvio in corso…";
    // Aspetta che il server riparta con la nuova versione, poi ricarica la pagina.
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const v = await api("/api/version").catch(() => null);
      if (v && v.startedAt !== before) return location.reload();
    }
    $("#update-status").textContent = "Il programma non è ripartito: chiudilo e riaprilo con l'icona \"Avvia Agenti\".";
  } catch (err) {
    $("#update-errors").textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};
$("#key-cta").onclick = openSettings;

// ---------- dati: copia (esporta) e ripristino (importa) ----------

$("#import-data").onclick = () => $("#import-file").click();
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // così si può scegliere di nuovo lo stesso file
  if (!file) return;
  $("#data-errors").textContent = "";
  $("#data-status").textContent = "";
  if (!/\.zip$/i.test(file.name)) return ($("#data-errors").textContent = "Scegli il file .zip creato con «Esporta i dati».");
  if (file.size > 20 * 1024 * 1024) return ($("#data-errors").textContent = "Il file è troppo grande (massimo 20 MB).");
  if (!confirm(`Importare «${file.name}»?\n\nAgenti, palazzo, portafoglio e impostazioni di adesso verranno sostituiti da quelli del file (il programma ne salva prima una copia). Poi il programma si riavvia.`)) return;
  const headers = { "Content-Type": "application/zip" };
  if (state.session.auth) {
    const password = await askPassword("Per importare i dati scrivi la password con cui entri nell'app.");
    if (password == null) return;
    headers["X-Agenti-Password"] = encodeURIComponent(password); // le intestazioni non accettano € o emoji
  }
  $("#data-status").textContent = "Invio il file…";
  try {
    const before = (await api("/api/version").catch(() => ({}))).startedAt;
    const r = await api("/api/backup", { method: "POST", headers, body: file });
    if (!r.restarting) {
      $("#data-status").textContent = `Dati importati ✅. ${r.message ?? "Riavvia il programma"} per usarli.`;
      return;
    }
    waitForRestart(before);
  } catch (err) {
    $("#data-status").textContent = "";
    $("#data-errors").textContent = err.message;
  }
});

/** Dopo l'importazione il server si riavvia: si aspetta che risponda di nuovo, poi si ricarica la pagina. */
async function waitForRestart(before) {
  settingsDlg.close();
  $("#restart-dialog").showModal();
  let down = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const ok = await fetch("/healthz", { cache: "no-store" }).then((r) => r.ok, () => false);
    if (!ok) {
      down = true;
      continue;
    }
    const v = await fetch("/api/version", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {}), () => null);
    if (down || (v && v.startedAt !== before)) return location.reload();
  }
  $("#restart-title").textContent = "Il programma non è ripartito";
  $("#restart-reload").classList.remove("hidden"); // nell'app installata non c'è il pulsante del browser per ricaricare
  $("#restart-msg").textContent = "Aspetta ancora un minuto e ricarica la pagina. Sul Mac: chiudi il programma e riaprilo con l'icona «Avvia Agenti».";
}
$("#restart-dialog").addEventListener("cancel", (e) => e.preventDefault()); // non si chiude con Esc durante il riavvio
$("#restart-reload").onclick = () => location.reload();

// Esporta: la copia contiene la chiave di Claude e l'accesso a cTrader, quindi sul server chiede la password.
$("#export-data").onclick = async () => {
  $("#data-errors").textContent = "";
  const headers = {};
  if (state.session.auth) {
    const password = await askPassword("Per scaricare la copia dei dati scrivi la password con cui entri nell'app.");
    if (password == null) return;
    headers["X-Agenti-Password"] = encodeURIComponent(password);
  }
  $("#data-status").textContent = "Preparo il file…";
  try {
    const res = await fetch("/api/backup", { headers, cache: "no-store" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 && body.login) return goLogin();
      throw new Error(body.error ?? res.statusText);
    }
    const name = /filename=([^;]+)/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "agenti-dati.zip";
    const url = URL.createObjectURL(await res.blob());
    const link = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    $("#data-status").textContent = `File «${name}» scaricato ✅. Tienilo al sicuro: contiene la chiave di Claude e l'accesso a cTrader.`;
  } catch (err) {
    $("#data-status").textContent = "";
    $("#data-errors").textContent = err.message;
  }
};

// Mappa del progetto: niente chiavi né password, quindi niente password da chiedere.
$("#export-map").onclick = async () => {
  $("#data-errors").textContent = "";
  $("#data-status").textContent = "Preparo la mappa…";
  try {
    const res = await fetch("/api/project-map", { cache: "no-store" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 && body.login) return goLogin();
      throw new Error(body.error ?? res.statusText);
    }
    const name = /filename=([^;]+)/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "mappa-progetto.json";
    const blob = await res.blob();
    const file = new File([blob], name, { type: "application/json" });
    // Sull'iPhone il foglio di condivisione permette di mandarla subito (per esempio all'app di Claude).
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Mappa del progetto" });
        $("#data-status").textContent = "Mappa condivisa ✅";
        return;
      } catch (err) {
        if (err.name === "AbortError") return void ($("#data-status").textContent = "");
      }
    }
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    $("#data-status").textContent = `File «${name}» scaricato ✅ (senza chiavi né password).`;
  } catch (err) {
    $("#data-status").textContent = "";
    $("#data-errors").textContent = err.message;
  }
};

// ---------- password per le operazioni delicate ----------

const passDlg = $("#password-dialog");
const passForm = $("#password-form");
/** Chiede la password dell'app; restituisce il testo scritto, oppure null se si annulla. */
function askPassword(message) {
  return new Promise((resolve) => {
    $("#password-msg").textContent = message;
    $("#password-errors").textContent = "";
    passForm.password.value = "";
    passDlg.returnValue = "";
    passDlg.onclose = () => resolve(passDlg.returnValue === "ok" ? passForm.password.value : null);
    passDlg.showModal();
    passForm.password.focus();
  });
}
passForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!passForm.password.value) return ($("#password-errors").textContent = "Scrivi la password.");
  passDlg.close("ok");
});
passDlg.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => passDlg.close()));

// ---------- app sul telefono: installazione ----------

let installPrompt = null; // Android/Chrome: l'evento che permette di mostrare la finestra "Installa"
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("#more-install-state").textContent = "Pronta da installare: tocca qui";
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  $("#more-install-state").textContent = "Installata ✅";
  if ($("#install-dialog").open) renderInstall();
});

const isInstalled = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isSecure = () => window.isSecureContext;

function renderInstall() {
  const s = state.session;
  const where = s.publicUrl ? `<b>${esc(s.publicUrl)}</b>` : "l'indirizzo dell'app sul server";
  let html;
  if (isInstalled()) {
    html = `<p class="ok-line">✅ L'app è già installata: la trovi tra le app del telefono con il nome «Agenti».</p>`;
  } else if (installPrompt) {
    html = `<p>Premi <b>Installa</b>: l'icona «Agenti» comparirà nella schermata Home e l'app si aprirà a tutto schermo, senza la barra del browser.</p>`;
  } else if (isIOS()) {
    html = `<p>Su iPhone e iPad si installa da Safari, in pochi tocchi:</p>
      <ol>
        <li>tocca <b>Condividi</b> <span class="share">⬆︎</span> (il quadrato con la freccia). Se non lo vedi, tocca prima i tre puntini <b>•••</b> accanto all'indirizzo, poi <b>Condividi</b>;</li>
        <li>scorri e tocca <b>Aggiungi alla schermata Home</b>;</li>
        <li>lascia acceso <b>Apri come app web</b> (se c'è) e tocca <b>Aggiungi</b>.</li>
      </ol>
      <p class="hint">Non vedi «Aggiungi alla schermata Home»? Apri questa pagina con Safari.${s.auth ? " Nell'app installata ti verrà chiesta la password una volta." : ""}</p>`;
  } else if (!isSecure()) {
    html = `<p>Per installarla serve l'indirizzo sicuro dell'app (che inizia con <b>https://</b>): apri ${where} sul telefono.</p>`;
  } else if (touchMQ.matches) {
    html = `<p>Apri il menu del browser <b>⋮</b> (in alto a destra) e tocca <b>Installa app</b> oppure <b>Aggiungi a schermata Home</b>.</p>
      <p class="hint">Se la voce non c'è ancora, usa l'app per qualche secondo e riprova.</p>`;
  } else {
    html = `<p>Sul telefono: apri ${where} con Chrome (Android) o Safari (iPhone), entra e tocca <b>☰ Altro → 📲 Installa l'app sul telefono</b>.</p>
      <p class="hint">Su questo computer, con Chrome o Edge, puoi installarla dall'icona ⊕ nella barra degli indirizzi.</p>`;
  }
  $("#install-body").innerHTML = html;
  $("#install-btn").classList.toggle("hidden", !installPrompt || isInstalled());
}

function openInstall() {
  renderInstall();
  $("#install-dialog").showModal();
}
$("#install-btn").onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice.catch(() => ({}));
  installPrompt = null;
  if (outcome === "accepted") $("#install-body").innerHTML = `<p class="ok-line">✅ Fatto: trovi «Agenti» nella schermata Home.</p>`;
  $("#install-btn").classList.add("hidden");
};
$("#install-dialog").querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => $("#install-dialog").close()));
$("#phone-install").onclick = () => openInstall();

// ---------- editor agente ----------

const dlg = $("#agent-dialog");
const form = $("#agent-form");

function checkboxes(container, name, items, selected) {
  container.querySelectorAll("label").forEach((l) => l.remove());
  for (const [value, label] of items) {
    const l = document.createElement("label");
    l.className = "inline";
    l.innerHTML = `<input type="checkbox" name="${name}" value="${esc(value)}" ${selected.includes(value) ? "checked" : ""}/> ${esc(label)}`;
    container.append(l);
  }
}

function syncMode() {
  const mode = form.mode.value;
  form.querySelector(".only-llm").classList.toggle("hidden", mode !== "llm");
  form.querySelector(".only-rule").classList.toggle("hidden", mode !== "rule");
}
form.mode.addEventListener("change", syncMode);

function openEditor(agent) {
  const isNew = !agent;
  agent ??= {
    id: "", name: "", avatar: "🤖", mode: "llm", enabled: true, everyMinutes: 0,
    room:
      B().rooms.find((r) => r.floor === state.floorFocus)?.id ??
      (state.palace ? B().rooms.find((r) => floorById(r.floor)?.palace === state.palace)?.id : null) ??
      B().rooms[0]?.id,
    watchlist: [], readsFrom: [], tools: ["get_quote", "get_indicators", "read_notes", "post_note"], canTrade: false,
    limits: { maxOrderPct: 10, maxPositionPct: 20, onlyWatchlist: true, requireApproval: true },
    model: "claude-haiku-5-5", effort: "low", onlyOnNews: false, instructions: "", strategy: state.office.strategies[0], params: {},
  };
  state.editing = isNew ? null : agent.id;
  $("#dlg-title").textContent = isNew ? "Nuovo agente" : `${agent.avatar} ${agent.name}`;
  // Stanze raggruppate per piano (dal più alto).
  form.room.innerHTML = B()
    .floors.slice()
    .reverse()
    .map((f) => {
      const rooms = B().rooms.filter((r) => r.floor === f.id);
      if (!rooms.length) return "";
      return `<optgroup label="${esc(floorLabel(f))}">${rooms.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}</optgroup>`;
    })
    .join("");
  form.strategy.innerHTML = state.office.strategies.map((s) => `<option>${esc(s)}</option>`).join("");

  form.id.value = agent.id;
  form.querySelector(".id-field").classList.toggle("hidden", isNew); // per i nuovi agenti il codice lo crea il programma
  form.name.value = agent.name;
  form.avatar.value = agent.avatar;
  form.room.value = agent.room;
  form.mode.value = agent.mode;
  form.everyMinutes.value = agent.everyMinutes;
  for (const box of form.querySelectorAll('input[name="runDays"]')) box.checked = (agent.runDays ?? []).includes(Number(box.value));
  form.runAt.value = agent.runAt || "18:00";
  form.watchlist.value = agent.watchlist.join(", ");
  form.instructions.value = agent.instructions ?? "";
  form.model.value = agent.model;
  form.effort.value = agent.effort;
  form.strategy.value = agent.strategy ?? "";
  form.params.value = JSON.stringify(agent.params ?? {}, null, 2);
  form.canTrade.checked = agent.canTrade;
  form.requireApproval.checked = agent.limits.requireApproval !== false;
  form.enabled.checked = agent.enabled;
  form.onlyOnNews.checked = Boolean(agent.onlyOnNews);
  form.maxOrderPct.value = agent.limits.maxOrderPct;
  form.maxPositionPct.value = agent.limits.maxPositionPct;
  form.onlyWatchlist.checked = agent.limits.onlyWatchlist !== false;
  checkboxes($("#tools-checks"), "tools", state.office.tools.map((t) => [t, t]), agent.tools);
  renderReadsFrom(agent.room, agent.readsFrom);
  renderTradeTarget(agent.room);
  $("#delete-btn").classList.toggle("hidden", isNew);
  $("#run-btn").disabled = isNew;
  $("#form-errors").textContent = "";
  $("#run-task").value = "";
  syncMode();
  dlg.showModal();
}

/** Stanze leggibili: quelle del proprio piano si scelgono; quelle dei piani collegati sono automatiche. */
function renderReadsFrom(roomId, selected) {
  const myFloor = floorOfRoom(roomId);
  const sameFloor = B().rooms.filter((r) => r.floor === myFloor && r.id !== roomId);
  checkboxes($("#reads-checks"), "readsFrom", sameFloor.map((r) => [r.id, r.name]), selected);
  const others = B().floors.filter((f) => f.id !== myFloor);
  const receives = others.filter((f) => flowsInto(f.id, myFloor)).map((f) => esc(floorLabel(f)));
  const sends = others.filter((f) => flowsInto(myFloor, f.id)).map((f) => esc(floorLabel(f)));
  $("#reads-linked").innerHTML =
    (receives.length
      ? `🔗 Legge in automatico anche le bacheche dei piani collegati: <b>${receives.join(", ")}</b>.`
      : "Non riceve informazioni da altri piani: legge solo il proprio.") +
    (sends.length ? ` Le sue note arrivano a: <b>${sends.join(", ")}</b>.` : "") +
    " I collegamenti si gestiscono in 🌌 Universo.";
}
form.room.addEventListener("change", () => {
  const selected = [...form.querySelectorAll('input[name="readsFrom"]:checked')].map((i) => i.value);
  renderReadsFrom(form.room.value, selected);
  renderTradeTarget(form.room.value);
});

/** Dove finiscono gli ordini di un agente: dipende dal piano della sua stanza. */
function renderTradeTarget(roomId) {
  const floor = floorById(floorOfRoom(roomId));
  const t = floor?.trading;
  const acc = t?.mode === "ctrader" ? accountById(t.accountId) : null;
  $("#trade-target").innerHTML =
    t?.mode === "ctrader"
      ? `Gli ordini vanno sul conto cTrader <b>${esc(acc ? accountName(acc) : t.accountId)}</b>${acc?.isLive ? ' <span class="acct live">CONTO REALE</span>' : ""}: quantità in lotti, con stop loss (se l'agente non lo indica si usa quello predefinito di Broker → Sicurezza). Si cambia in 🔌 Broker.`
      : "Gli ordini vanno sul <b>portafoglio simulato</b>. Per farlo operare su un conto cTrader, collega il suo piano in 🔌 Broker.";
}

function readForm() {
  let params;
  try {
    params = JSON.parse(form.params.value || "{}");
  } catch {
    throw new Error("Parametri: JSON non valido");
  }
  const checked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  return {
    id: form.id.value.trim(),
    name: form.name.value.trim(),
    avatar: form.avatar.value.trim() || "🤖",
    room: form.room.value,
    mode: form.mode.value,
    enabled: form.enabled.checked,
    onlyOnNews: form.onlyOnNews.checked,
    everyMinutes: Number(form.everyMinutes.value) || 0,
    runDays: checked("runDays").map(Number),
    runAt: form.runAt.value || "18:00",
    watchlist: form.watchlist.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    readsFrom: checked("readsFrom"),
    tools: checked("tools"),
    canTrade: form.canTrade.checked,
    limits: {
      maxOrderPct: Number(form.maxOrderPct.value),
      maxPositionPct: Number(form.maxPositionPct.value),
      onlyWatchlist: form.onlyWatchlist.checked,
      requireApproval: form.requireApproval.checked,
    },
    model: form.model.value.trim(),
    effort: form.effort.value,
    instructions: form.instructions.value,
    strategy: form.strategy.value,
    params,
  };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const agent = readForm();
    if (state.editing) await api(`/api/agents/${encodeURIComponent(state.editing)}`, { method: "PUT", body: JSON.stringify(agent) });
    else await api("/api/agents", { method: "POST", body: JSON.stringify({ ...agent, id: undefined }) });
    dlg.close();
  } catch (err) {
    $("#form-errors").textContent = err.body?.errors?.join("\n") ?? err.message;
  }
});

$("#delete-btn").onclick = async () => {
  if (!state.editing || !confirm("Eliminare questo agente?")) return;
  await api(`/api/agents/${encodeURIComponent(state.editing)}`, { method: "DELETE" });
  dlg.close();
};

$("#run-btn").onclick = async () => {
  try {
    await api(`/api/agents/${encodeURIComponent(state.editing)}/run`, {
      method: "POST",
      body: JSON.stringify({ task: $("#run-task").value.trim() || undefined }),
    });
    dlg.close();
  } catch (err) {
    $("#form-errors").textContent = err.message;
  }
};

dlg.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => dlg.close()));
$("#new-agent").onclick = () => openEditor(null);

// ---------- tempo reale ----------

// Il server non ripete gli eventi persi: quando il collegamento riparte si ricarica tutto (approvazioni comprese).
// Sui telefoni il collegamento può morire in silenzio quando l'app va in sottofondo: lo si rifà quando la pagina
// torna visibile, quando torna la rete e quando per 60 secondi non arriva niente (il server manda un "ping" ogni 25).
let events = null;
let lastEventAt = Date.now();
let everOpened = false;
let retryTimer = null;

function connectEvents() {
  clearTimeout(retryTimer);
  events?.close();
  lastEventAt = Date.now();
  const es = (events = new EventSource("/api/events"));
  es.onopen = () => {
    lastEventAt = Date.now();
    if (everOpened) resync(); // riconnessi: si recupera quello che è successo nel frattempo
    everOpened = true;
  };
  es.onmessage = (msg) => {
    lastEventAt = Date.now();
    handleEvent(JSON.parse(msg.data));
  };
  es.onerror = async () => {
    if (es !== events) return;
    // Sessione scaduta? Allora si torna all'accesso invece di riprovare all'infinito.
    const s = await loadSession();
    if (es !== events) return; // nel frattempo è partito un collegamento nuovo: questo non serve più
    if (s?.auth && !s.loggedIn) return goLogin();
    if (s) applySession();
    // Il browser riprova da solo, tranne quando il server ha risposto con un errore: allora si riprova noi.
    if (es.readyState === EventSource.CLOSED) retryTimer = setTimeout(connectEvents, 5000);
  };
}

let resyncing = null;
/** Riallinea la pagina con il server (dopo una riconnessione); mai due volte insieme. */
function resync() {
  resyncing ??= loadAll()
    .catch(() => {})
    .finally(() => (resyncing = null));
  return resyncing;
}

/** La pagina torna in primo piano o torna la rete: collegamento nuovo e dati aggiornati (all'apertura). */
function wakeUp() {
  if (document.hidden) return;
  connectEvents();
}
document.addEventListener("visibilitychange", () => {
  syncOffice3d();
  wakeUp();
});
window.addEventListener("pageshow", (e) => e.persisted && wakeUp()); // pagina ripresa dalla cache del browser
window.addEventListener("online", wakeUp);
setInterval(() => {
  if (!document.hidden && Date.now() - lastEventAt > 60_000) connectEvents();
}, 10_000);

function handleEvent(ev) {
  switch (ev.type) {
    case "status":
      state.status[ev.agentId] = { status: ev.status, detail: ev.detail };
      office3d?.setStatus(ev.agentId, ev.status, ev.detail);
      renderRoster();
      refreshStatsSoon();
      break;
    case "note":
      (state.notes[ev.note.roomId] ??= []).push(ev.note);
      office3d?.speak(ev.note.agentId, ev.note.text);
      if (state.view === "notes") renderNotes();
      refreshStatsSoon();
      break;
    case "log":
      state.log.push(ev.entry);
      if (state.view === "log") renderLog();
      break;
    case "request":
      upsertRequest(ev.request);
      break;
    case "report-pdf":
      if (state.view === "reports") loadReports().then(() => state.view === "reports" && renderReports(), () => {});
      break;
    case "report":
      if (state.view === "costs") loadCosts().then(() => state.view === "costs" && renderCosts(), () => {});
      break;
    case "platform":
      onPlatformEvent();
      break;
    case "holdings":
      if (state.view === "portfolio") loadHoldings();
      break;
    case "approval": {
      const i = state.approvals.findIndex((a) => a.id === ev.approval.id);
      if (i >= 0) state.approvals[i] = ev.approval;
      else state.approvals.unshift(ev.approval);
      if (state.view === "approvals") renderApprovals();
      refreshStatsSoon();
      break;
    }
    case "trade":
      refreshPortfolio();
      refreshStatsSoon();
      if (ev.trade?.accountId) {
        loadBroker();
        if (state.view === "broker") loadBrokerAccounts();
        if (state.view === "broker" && ev.trade.action === "close") setTimeout(loadBrokerHistory, 1500);
      }
      break;
    case "social":
      if (state.view === "social") loadSocial().then(() => state.view === "social" && renderSocial(), () => {});
      refreshSocialBadge();
      break;
    case "broker":
    case "safety":
      loadBroker();
      refreshStatsSoon();
      break;
    case "stats":
      refreshStatsSoon();
      if (state.view === "costs") loadCosts().then(() => state.view === "costs" && renderCosts(), () => {});
      break;
    case "chat-delta":
      liveDelta(ev);
      break;
    case "chat":
      if (ev.entry.role === "assistant") state.chat.live = ""; // il testo finale prende il posto di quello in diretta
      state.chat.transcript.push(ev.entry);
      renderChat();
      if (ev.entry.role === "assistant" && voice.speakTurn) speech.say(ev.entry.text);
      break;
    case "chat-status":
      state.chat.busy = ev.busy;
      if (!ev.busy) state.chat.live = "";
      if (!ev.busy) voice.speakTurn = false; // risposta finita: i messaggi seguenti non si leggono
      renderChat();
      break;
    case "voice":
      applyVoiceStatus(ev.status);
      break;
    case "chat-reset":
      state.chat.transcript = [];
      renderChat();
      break;
    case "config":
      loadOffice().then(() => {
        refreshStats();
        renderChat();
        loadBroker();
      });
      break;
    case "reset":
      loadAll();
      break;
  }
};

// ---------- telefono: tastiera dell'iPhone ----------
// Sull'iPhone la tastiera copre la pagina senza accorciarla: l'altezza dell'app segue la parte visibile.
if (window.visualViewport && touchMQ.matches) {
  const vv = window.visualViewport;
  const fit = () => {
    const keyboard = Math.abs(vv.scale - 1) < 0.01 && innerHeight - vv.height > 80;
    $(".app").classList.toggle("kb", keyboard);
    if (!keyboard) return;
    document.documentElement.style.setProperty("--app-h", `${vv.height}px`);
    window.scrollTo(0, 0);
    if (state.view === "chat") $("#chat-body").scrollTop = $("#chat-body").scrollHeight;
  };
  vv.addEventListener("resize", fit);
}

// ---------- app installabile: service worker (solo su https o sul computer stesso) ----------
// Sul Mac (http://localhost) niente service worker: con il programma chiuso il browser deve dire semplicemente che
// la pagina non si apre, non mostrare la pagina «controlla la connessione» pensata per il telefono.
/** Sezione indicata nell'indirizzo (#approvals, #social, #broker): ritorno da un social o tocco su una notifica. */
function openFromHash(hash) {
  const view = String(hash ?? "").slice(1);
  if (["broker", "social", "approvals", "costs", "reports"].includes(view)) {
    if (view === "approvals") state.approvalsTab = "pending"; // da una notifica: le cose da decidere
    showView(view);
    history.replaceState(null, "", location.pathname);
  }
}
// Tocco su una notifica con l'app già aperta: il service worker dice quale sezione mostrare.
navigator.serviceWorker?.addEventListener("message", (e) => e.data?.type === "open" && openFromHash(e.data.hash));
if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// ---------- avvio ----------

async function start() {
  // Se il server non risponde (es. si sta aggiornando) si riprova: senza sapere se serve la password l'app
  // non chiederebbe la conferma per le operazioni delicate.
  for (let i = 0; !(await loadSession()); i++) await new Promise((r) => setTimeout(r, Math.min(2000 * (i + 1), 10_000)));
  if (state.session.auth && !state.session.loggedIn) return goLogin();
  applySession();
  syncRoster();
  connectEvents();
  await loadAll();
  loadPlatform();
  openFromHash(location.hash);
  refreshSocialBadge();
}
initSocial(api);
initNotify(api);
initPlatform(api, {
  chat: (text) => {
    if (phoneMQ.matches) showView("chat");
    sendChat(text);
  },
  showView,
  agentName: (id) => state.office.agents.find((a) => a.id === id)?.name ?? id,
  palaces: () => B().palaces,
});
initReports(api);
initCosts(api, { palaceName: (id) => B().palaces.find((p) => p.id === id)?.name ?? id, openAgent: (id) => openEditor(state.office.agents.find((a) => a.id === id)) });
/** Avviso "!" su 📣 Social quando un accesso è scaduto o sta per scadere. */
let socialBadgeTimer = null;
function refreshSocialBadge() {
  clearTimeout(socialBadgeTimer);
  socialBadgeTimer = setTimeout(async () => {
    try {
      const st = await loadSocial();
      const bad = st.networks.filter((n) => n.account && (n.account.expired || n.account.expiresSoon || n.account.problem));
      $("#badge-social").classList.toggle("hidden", !bad.length);
      $("#more-social-badge").classList.toggle("hidden", !bad.length);
      const linked = st.networks.filter((n) => n.account).map((n) => n.label);
      $("#more-social-state").textContent = bad.length
        ? `Da ricollegare: ${bad.map((n) => n.label).join(", ")}`
        : linked.length ? `Collegati: ${linked.join(", ")}` : "Instagram, Threads, LinkedIn, X, YouTube · foto e video";
    } catch {
      // nessuna risposta: si riprova al prossimo evento
    }
  }, 300);
}
start();
setInterval(refreshPortfolio, 60_000);
setInterval(refreshStats, 5 * 60_000); // così l'avviso "fuori orario" resta giusto anche a pagina ferma
setInterval(() => state.view === "broker" && loadBrokerAccounts(), 30_000);
setInterval(() => state.view === "broker" && loadBrokerHistory(), 120_000);
setTimeout(() => checkForUpdate({ quiet: true }), 3000); // un controllo silenzioso all'apertura
