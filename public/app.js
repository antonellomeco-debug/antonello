// Interfaccia: palazzo 3D, gestione di piani/stanze/collegamenti, approvazioni, bacheca, portafoglio,
// attività, chat con il regista ed editor degli agenti.
import { Office3D } from "./office3d.js";

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 2) => (n == null ? "—" : Number(n).toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d }));
const time = (iso) => new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
const when = (iso) => new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

const state = {
  office: null, notes: {}, log: [], approvals: [], portfolio: null, stats: null,
  chat: { name: "", busy: false, transcript: [] }, status: {}, view: "office", room: null, editing: null,
  floorFocus: null, broker: null, brokerAccounts: null,
};

// ---------- utilità sul palazzo ----------
const B = () => state.office.building;
const floorById = (id) => B().floors.find((f) => f.id === id);
const roomById = (id) => B().rooms.find((r) => r.id === id);
const floorOfRoom = (roomId) => roomById(roomId)?.floor;
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
  if (!res.ok) throw Object.assign(new Error(body.error ?? res.statusText), { body });
  return body;
}

// ---------- caricamento ----------

async function loadOffice() {
  state.office = await api("/api/office");
  for (const a of state.office.agents) state.status[a.id] ??= { status: a.running ? "working" : "idle" };
  const { building, agents, assistant } = state.office;
  $("#office-sub").textContent =
    `${building.name}: ${agents.length} agenti in ${building.rooms.length} stanze su ${building.floors.length} piani, coordinati da ${assistant}. ` +
    "Scegli un piano nell'ascensore, trascina per girare, clicca una scrivania per aprire la scheda.";
  $("#chat-title").textContent = `Parla con ${assistant}`;
  $("#key-cta").classList.toggle("hidden", state.office.llmReady);
  $("#badge-settings").classList.toggle("hidden", state.office.llmReady);
  if (!office3d) {
    office3d = new Office3D($("#scene"), {
      assistantName: assistant,
      onAgentClick: (id) => openEditor(state.office.agents.find((a) => a.id === id)),
      onFloorFocus: (id) => {
        state.floorFocus = id;
        renderElevator();
      },
    });
  }
  office3d.setBuilding(building, agents);
  state.floorFocus = office3d.focused;
  for (const [id, s] of Object.entries(state.status)) office3d.setStatus(id, s.status, s.detail);
  renderElevator();
  renderRoster();
  renderFilter();
  if (state.view === "building") renderBuilding();
}

async function loadAll() {
  await loadOffice();
  [state.notes, state.log, state.approvals, state.chat] = await Promise.all([
    api("/api/notes"), api("/api/log"), api("/api/approvals"), api("/api/chat"),
  ]);
  await loadBroker();
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
  const cells = [
    [s.working, "al lavoro ora"], [s.agents, "agenti"], [s.floors, "piani"], [s.rooms, "stanze"], [s.notes, "note in bacheca"],
    [s.trades + (s.brokerTrades ?? 0), "ordini eseguiti"], [s.pending, "da approvare"], [`$${fmt(s.costUsd)}`, "spesa API (stima)"],
    [state.office.llmReady ? "sì" : "no", "Claude collegato"], [s.scheduled, "programmati"],
  ];
  $("#stats").innerHTML = cells
    .map(([v, l]) => `<div class="stat ${l === "Claude collegato" ? "clickable" : ""}"><b>${esc(v)}</b><small>${esc(l)}</small></div>`)
    .join("");
  $("#stats .clickable")?.addEventListener("click", openSettings);
  const badge = $("#badge-approvals");
  badge.textContent = s.pending;
  badge.classList.toggle("hidden", !s.pending);
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
}

async function refreshPortfolio() {
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
  state.view = view;
  document.querySelectorAll(".nav[data-view]").forEach((x) => x.classList.toggle("active", x.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.id !== `view-${view}`));
  renderView();
  if (view === "broker") loadBrokerAccounts();
}
document.querySelectorAll(".nav[data-view]").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.view === "chat") return $("#chat").classList.add("open");
    showView(b.dataset.view);
  }),
);
$("#chat-close").onclick = () => $("#chat").classList.remove("open");

function renderView() {
  if (state.view === "building") renderBuilding();
  else if (state.view === "approvals") renderApprovals();
  else if (state.view === "notes") renderNotes();
  else if (state.view === "log") renderLog();
  else if (state.view === "portfolio") renderPortfolio();
  else if (state.view === "broker") renderBroker();
}

// ---------- ufficio ----------

function renderRoster() {
  const agents = state.office.agents;
  $("#roster-sum").textContent = `▸ Elenco completo dei ${agents.length} agenti`;
  const room = (id) => `${roomById(id)?.name ?? id} · ${floorById(floorOfRoom(id))?.name ?? ""}`;
  $("#roster-list").innerHTML = agents
    .map((a) => `<div class="roster-row" data-id="${esc(a.id)}">
      <span>${esc(a.avatar)}</span>
      <span><b>${esc(a.name)}</b> <small>· ${esc(room(a.room))} · ${a.mode === "llm" ? "LLM" : esc(a.strategy)}</small></span>
      <span><small>${a.everyMinutes ? `ogni ${a.everyMinutes}′` : "manuale"}</small> <i class="dot ${state.status[a.id]?.status ?? ""}"></i></span>
    </div>`)
    .join("");
  $("#roster-list").querySelectorAll(".roster-row").forEach((r) =>
    r.addEventListener("click", () => openEditor(agents.find((a) => a.id === r.dataset.id))),
  );
}

$("#reset-view").onclick = () => office3d?.resetView();

/** Pulsantiera "ascensore": tutto il palazzo + un pulsante per piano (dal più alto). */
function renderElevator() {
  const el = $("#elevator");
  const floors = B().floors.slice().reverse();
  const btn = (id, html, title) =>
    `<button class="lift ${state.floorFocus === id ? "active" : ""}" data-floor="${id ?? ""}" title="${esc(title)}">${html}</button>`;
  el.innerHTML =
    btn(null, `<span class="lift-ico">🏢</span><span class="lift-name">Tutto il palazzo</span>`, B().name) +
    floors
      .map((f) => {
        const n = state.office.agents.filter((a) => floorOfRoom(a.room) === f.id).length;
        const linked = B().floors.some((o) => o.id !== f.id && (flowsInto(o.id, f.id) || flowsInto(f.id, o.id)));
        return btn(
          f.id,
          `<span class="lift-dot" style="--c:${esc(f.color)}"></span><span class="lift-name">${esc(f.name)}</span>` +
            `<small>${esc(f.sector || "")}${f.sector ? " · " : ""}${n} agenti${linked ? " · 🔗" : ""}</small>`,
          f.description || f.name,
        );
      })
      .join("") +
    `<button class="lift add" id="lift-add" title="Aggiungi un piano">+ Piano</button>`;
  el.querySelectorAll(".lift[data-floor]").forEach((b) => (b.onclick = () => office3d.focusFloor(b.dataset.floor || null)));
  $("#lift-add").onclick = () => openFloorEditor(null);
}

// ---------- palazzo: piani, stanze, collegamenti ----------

function renderBuilding() {
  const b = B();
  $("#building-title").textContent = `🏗️ ${b.name}`;
  const agentsIn = (roomId) => state.office.agents.filter((a) => a.room === roomId);
  $("#floors-list").innerHTML = b.floors
    .slice()
    .reverse()
    .map((f) => {
      const rooms = b.rooms.filter((r) => r.floor === f.id);
      const conns = b.floors
        .filter((o) => o.id !== f.id)
        .map((o) => ({ o, recv: flowsInto(o.id, f.id), send: flowsInto(f.id, o.id) }))
        .filter((c) => c.recv || c.send)
        .map((c) => `<span class="conn">${c.recv && c.send ? "↔" : c.recv ? "← riceve da" : "→ invia a"} ${esc(c.o.name)}</span>`)
        .concat(
          b.links
            .filter((l) => !l.active && (l.from === f.id || l.to === f.id))
            .map((l) => `<span class="conn none">⏸ collegamento spento con ${esc(floorById(l.from === f.id ? l.to : l.from)?.name ?? "")}</span>`),
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
    })
    .join("") || `<p class="empty">Nessun piano. Crea il primo con "+ Nuovo piano".</p>`;

  $("#floors-list").querySelectorAll("[data-edit-floor]").forEach((x) => (x.onclick = () => openFloorEditor(floorById(x.dataset.editFloor))));
  $("#floors-list").querySelectorAll("[data-show-floor]").forEach((x) => (x.onclick = () => showFloorInOffice(x.dataset.showFloor)));
  $("#floors-list").querySelectorAll("[data-edit-room]").forEach((x) => (x.onclick = () => openRoomEditor(roomById(x.dataset.editRoom))));
  $("#floors-list").querySelectorAll("[data-new-room]").forEach((x) => (x.onclick = () => openRoomEditor(null, x.dataset.newRoom)));

  const name = (id) => esc(floorById(id)?.name ?? id);
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
  const opts = b.floors.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
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
  requestAnimationFrame(() => office3d.focusFloor(floorId));
}

$("#new-floor").onclick = () => openFloorEditor(null);
$("#rename-building").onclick = async () => {
  const name = prompt("Nome del palazzo:", B().name);
  if (name == null) return;
  await api("/api/building", { method: "PUT", body: JSON.stringify({ name }) }).catch((e) => alert(e.message));
};

// Finestra piano
const floorDlg = $("#floor-dialog");
const floorForm = $("#floor-form");
function openFloorEditor(floor) {
  state.editingFloor = floor?.id ?? null;
  $("#floor-title").textContent = floor ? `Modifica: ${floor.name}` : "Nuovo piano";
  floorForm.name.value = floor?.name ?? "";
  floorForm.sector.value = floor?.sector ?? "";
  floorForm.description.value = floor?.description ?? "";
  floorForm.level.value = floor?.level ?? Math.max(-1, ...B().floors.map((f) => f.level)) + 1;
  floorForm.color.value = floor?.color ?? ["#2fb7c4", "#f06292", "#8bc34a", "#ff8a3d", "#7986cb"][B().floors.length % 5];
  $("#floor-delete").classList.toggle("hidden", !floor);
  $("#floor-errors").textContent = "";
  floorDlg.showModal();
}
floorForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
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

// Finestra stanza
const roomDlg = $("#room-dialog");
const roomForm = $("#room-form");
function openRoomEditor(room, floorId) {
  state.editingRoom = room?.id ?? null;
  $("#room-title").textContent = room ? `Modifica: ${room.name}` : "Nuova stanza";
  roomForm.floor.innerHTML = B().floors.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
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

function renderApprovals() {
  const list = state.approvals;
  if (!list.length) {
    $("#approvals-list").innerHTML = `<p class="empty">Nessuna proposta. Quando un agente vuole comprare o vendere, la trovi qui.</p>`;
    return;
  }
  const label = { pending: "", executed: "✔ Eseguito", rejected: "Scartato", failed: "✖ Non eseguito", executing: "In esecuzione…", uncertain: "⚠️ Esito incerto" };
  $("#approvals-list").innerHTML = list
    .map((a) => {
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
    ${p.positions.length ? `<table><tr><th>Titolo</th><th>Q.tà</th><th>Medio</th><th>Prezzo</th><th>Valore</th><th>P&L</th></tr>
      ${p.positions.map((x) => `<tr><td>${esc(x.symbol)}${x.source === "demo" ? " *" : ""}</td><td>${x.qty}</td><td>${fmt(x.avgPrice)}</td><td>${fmt(x.price)}</td><td>${fmt(x.value)}</td>
      <td class="${x.pnlPct >= 0 ? "up" : "down"}">${fmt(x.pnlPct)}%</td></tr>`).join("")}</table>` : `<p class="empty">Nessuna posizione aperta.</p>`}
    <h4>Ultimi ordini</h4>
    ${p.trades.length ? `<table><tr><th>Quando</th><th>Titolo</th><th>Lato</th><th>Q.tà</th><th>Prezzo</th><th>Agente</th></tr>
      ${p.trades.slice().reverse().map((t) => `<tr title="${esc(t.reason)}"><td>${when(t.at)}</td><td>${esc(t.symbol)}</td><td class="${t.side === "buy" ? "up" : "down"}">${t.side}</td><td>${t.qty}</td><td>${fmt(t.price)}</td><td>${esc(t.agentId)}</td></tr>`).join("")}</table>` : `<p class="empty">Nessun ordine.</p>`}
    <p class="hint">* prezzo da dati demo (mercato non raggiungibile)</p>`;
}

$("#reset-btn").onclick = async () => {
  if (!confirm("Azzerare portafoglio, bacheche, approvazioni e log?")) return;
  await api("/api/reset", { method: "POST" });
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

  // Passo 1: app
  $("#redirect-uri").textContent = b.redirectUri;
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
    : `<table><tr><th>Conto</th><th>Tipo</th><th>Saldo</th><th>Leva</th><th>Posizioni</th><th>Dati</th></tr>
      ${b.accounts.map((a) => {
        const x = infoOf(a.ctidTraderAccountId);
        const i = x?.info;
        return `<tr>
          <td>${esc(accountName(a))}${i?.accountType && i.accountType !== "HEDGED" ? ` <small class="warn-line">(${esc(i.accountType)}: non adatto agli agenti)</small>` : ""}</td>
          <td>${acctBadge(a.isLive)}</td>
          <td>${x?.error ? `<span class="down" title="${esc(x.error)}">errore</span>` : i ? `${fmt(i.balance)} ${esc(i.currency)}` : "…"}</td>
          <td>${i?.leverage ? `1:${fmt(i.leverage, 0)}` : "—"}</td>
          <td>${x?.positions ? x.positions.length : "—"}</td>
          <td><input type="radio" name="data-account" value="${a.ctidTraderAccountId}" ${String(b.dataAccountId) === String(a.ctidTraderAccountId) ? "checked" : ""} title="Usa questo conto per prezzi e grafici" /></td>
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
        return `<tr><td><span class="floor-dot inline" style="--c:${esc(f.color)}"></span>${esc(f.name)}</td><td>
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
      ? `<table><tr><th>Strumento</th><th>Conto</th><th>Lato</th><th>Lotti</th><th>Apertura</th><th>Stop loss</th><th>Take profit</th><th>P&L</th><th>Aperta da</th><th></th></tr>
        ${rows.map((p) => `<tr>
          <td>${esc(p.symbol)}</td><td>${p.acc ? acctBadge(p.acc.isLive) : ""} ${esc(p.acc?.traderLogin ?? p.accountId)}</td>
          <td class="${p.side === "buy" ? "up" : "down"}">${p.side === "buy" ? "acquisto" : "vendita"}</td>
          <td>${fmt(p.lots, 2)}</td><td>${p.price ?? "—"}</td><td>${p.stopLoss ?? "—"}</td><td>${p.takeProfit ?? "—"}</td>
          <td class="${(p.pnl ?? 0) >= 0 ? "up" : "down"}">${p.pnl == null ? "—" : `${fmt(p.pnl)} ${esc(p.currency)}`}</td>
          <td>${p.label.startsWith("agenti:") ? `🤖 ${esc(p.label.slice(7))}` : "te (manuale)"}</td>
          <td><button class="btn small danger" data-close-pos="${p.accountId}|${p.positionId}">Chiudi</button></td>
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
      ? `<table><tr><th>Conto</th><th>Ordini</th><th>Inizio giornata</th><th>Adesso</th><th>Perdita</th></tr>
        ${accDays.map(([id, d]) => {
          const a = accountById(id);
          return `<tr class="${d.breached ? "breached" : ""}"><td>${a ? `${acctBadge(a.isLive)} ${esc(a.traderLogin ?? id)}` : esc(id)}</td><td>${d.orders} / ${b.safety.limits.maxOrdersPerDay}</td>
            <td>${d.startEquity == null ? "—" : fmt(d.startEquity)}</td><td>${d.equity == null ? "—" : fmt(d.equity)}</td>
            <td class="${(d.lossPct ?? 0) > 0 ? "down" : "up"}">${d.startEquity == null ? "—" : `${fmt(d.lossPct ?? 0)}%`}${d.breached ? " ⛔" : ""}</td></tr>`;
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
         <div class="row"><button class="btn danger" type="submit">Sblocca il conto reale</button></div>`;
  }

  // Ultimi ordini sul broker
  $("#broker-trades").innerHTML = b.trades.length
    ? `<table><tr><th>Quando</th><th>Agente</th><th>Conto</th><th>Operazione</th><th>Strumento</th><th>Lotti</th><th>Prezzo</th></tr>
      ${b.trades.map((t) => `<tr title="${esc(t.reason)}"><td>${when(t.at)}</td><td>${esc(t.agentId)}</td><td>${acctBadge(t.isLive)} ${esc(accountById(t.accountId)?.traderLogin ?? t.accountId)}</td>
        <td class="${t.side === "buy" ? "up" : "down"}">${t.action === "close" ? "chiusura" : t.side === "buy" ? "acquisto" : "vendita"}</td>
        <td>${esc(t.symbol)}</td><td>${fmt(t.lots)}</td><td>${t.status === "incerto" ? '<span class="warn-line" title="Connessione interrotta durante l\'invio">esito incerto</span>' : t.status === "accepted" ? `${esc(t.price ?? "—")} <small class="hint">(da confermare)</small>` : esc(t.price ?? "—")}</td></tr>`).join("")}</table>`
    : `<p class="empty">Nessun ordine degli agenti sul broker.</p>`;
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
  const confirmText = e.target.confirm?.value ?? "";
  document.activeElement?.blur();
  await brokerCall("/api/safety/live", "POST", { enabled: !live, confirm: confirmText });
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
    ? t.map((m) => `<div class="msg ${m.role}" data-who="${esc(state.office.assistant.toUpperCase())}">${m.role === "tool" ? "⚙ " : ""}${esc(m.text)}</div>`).join("")
    : `<div class="msg assistant" data-who="${esc(state.office.assistant.toUpperCase())}">Ciao! Sono ${esc(state.office.assistant)}, coordino gli agenti dell'ufficio. Chiedimi cosa stanno facendo, fai lavorare qualcuno o descrivimi un nuovo agente da creare.${state.office.llmReady ? "" : "\n\n🔑 Per parlarmi inserisci la chiave di Claude in ⚙️ Impostazioni."}</div>`;
  body.scrollTop = body.scrollHeight;
  $("#chat").classList.toggle("busy", state.chat.busy);
  $("#chat-reset").disabled = state.chat.busy; // non si può azzerare mentre Orion lavora
  $("#chat-state").textContent = state.chat.busy ? "Sto lavorando…" : "Ti ascolto — scrivi pure";
  $("#chat-chips").innerHTML = t.length ? "" : SUGGESTIONS.map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join("");
  $("#chat-chips").querySelectorAll(".chip").forEach((c) => (c.onclick = () => sendChat(c.textContent)));
}

async function sendChat(text) {
  text = text.trim();
  if (!text || state.chat.busy) return;
  $("#chat-input").value = "";
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
  sendChat($("#chat-input").value);
});
$("#chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat(e.target.value);
  }
});
$("#chat-reset").onclick = () => api("/api/chat/reset", { method: "POST" }).catch((e) => alert(e.message));

// ---------- impostazioni ----------

const settingsDlg = $("#settings-dialog");
const settingsForm = $("#settings-form");

async function openSettings() {
  settingsForm.key.value = "";
  $("#settings-errors").textContent = "";
  checkForUpdate();
  await renderKeyStatus();
  if (!state.office.llmReady) settingsForm.querySelector(".howto").open = true;
  settingsDlg.showModal();
}

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

// ---------- aggiornamenti ----------

async function checkForUpdate({ quiet } = {}) {
  const status = $("#update-status");
  if (!quiet) status.textContent = "Controllo in corso…";
  $("#update-errors").textContent = "";
  try {
    const u = await api("/api/update");
    state.update = u;
    const latest = `${u.latest.message} (${u.latest.date ? when(u.latest.date) : u.latest.short})`;
    if (!u.canUpdate) status.textContent = u.reason;
    else if (!u.installed) status.textContent = `Non so quale versione hai (scaricata a mano). Ultima versione: ${latest}. Aggiorna per essere sicuro di avere l'ultima.`;
    else if (u.available) status.textContent = `È disponibile una nuova versione: ${latest}.`;
    else status.textContent = `Hai l'ultima versione ✅ (${latest}).`;
    const show = u.canUpdate && u.available;
    $("#update-apply").classList.toggle("hidden", !show);
    $("#update-cta").classList.toggle("hidden", !show);
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
    room: B().rooms.find((r) => r.floor === state.floorFocus)?.id ?? B().rooms[0]?.id,
    watchlist: [], readsFrom: [], tools: ["get_quote", "get_indicators", "read_notes", "post_note"], canTrade: false,
    limits: { maxOrderPct: 10, maxPositionPct: 20, onlyWatchlist: true, requireApproval: true },
    model: "claude-opus-5-5", effort: "medium", instructions: "", strategy: state.office.strategies[0], params: {},
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
      return `<optgroup label="${esc(f.name)}">${rooms.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}</optgroup>`;
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
  form.watchlist.value = agent.watchlist.join(", ");
  form.instructions.value = agent.instructions ?? "";
  form.model.value = agent.model;
  form.effort.value = agent.effort;
  form.strategy.value = agent.strategy ?? "";
  form.params.value = JSON.stringify(agent.params ?? {}, null, 2);
  form.canTrade.checked = agent.canTrade;
  form.requireApproval.checked = agent.limits.requireApproval !== false;
  form.enabled.checked = agent.enabled;
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
  const receives = others.filter((f) => flowsInto(f.id, myFloor)).map((f) => esc(f.name));
  const sends = others.filter((f) => flowsInto(myFloor, f.id)).map((f) => esc(f.name));
  $("#reads-linked").innerHTML =
    (receives.length
      ? `🔗 Legge in automatico anche le bacheche dei piani collegati: <b>${receives.join(", ")}</b>.`
      : "Non riceve informazioni da altri piani: legge solo il proprio.") +
    (sends.length ? ` Le sue note arrivano a: <b>${sends.join(", ")}</b>.` : "") +
    " I collegamenti si gestiscono in 🏗️ Palazzo.";
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
    everyMinutes: Number(form.everyMinutes.value) || 0,
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

const events = new EventSource("/api/events");
events.onmessage = (msg) => {
  const ev = JSON.parse(msg.data);
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
      }
      break;
    case "broker":
    case "safety":
      loadBroker();
      refreshStatsSoon();
      break;
    case "stats":
      refreshStatsSoon();
      break;
    case "chat":
      state.chat.transcript.push(ev.entry);
      renderChat();
      break;
    case "chat-status":
      state.chat.busy = ev.busy;
      renderChat();
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

loadAll().then(() => {
  if (location.hash === "#broker") {
    showView("broker");
    history.replaceState(null, "", location.pathname);
  }
});
setInterval(refreshPortfolio, 60_000);
setInterval(() => state.view === "broker" && loadBrokerAccounts(), 30_000);
setTimeout(() => checkForUpdate({ quiet: true }), 3000); // un controllo silenzioso all'apertura
