// Interfaccia: ufficio 3D, approvazioni, bacheca, portafoglio, attività, chat con il regista ed editor agenti.
import { Office3D } from "./office3d.js";

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 2) => (n == null ? "—" : Number(n).toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d }));
const time = (iso) => new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
const when = (iso) => new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

const state = {
  office: null, notes: {}, log: [], approvals: [], portfolio: null, stats: null,
  chat: { name: "", busy: false, transcript: [] }, status: {}, view: "office", room: null, editing: null,
};
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
  const { rooms, agents, assistant } = state.office;
  $("#office-sub").textContent =
    `${agents.length} agenti in ${rooms.length} reparti, coordinati da ${assistant}. ` +
    "Trascina per girare attorno all'ufficio, clicca una scrivania per aprire la scheda.";
  $("#chat-title").textContent = `Parla con ${assistant}`;
  if (!office3d) {
    office3d = new Office3D($("#scene"), {
      assistantName: assistant,
      onAgentClick: (id) => openEditor(state.office.agents.find((a) => a.id === id)),
      onRoomClick: (id) => office3d.focusRoom(id),
    });
  }
  office3d.setOffice(rooms, agents);
  for (const [id, s] of Object.entries(state.status)) office3d.setStatus(id, s.status, s.detail);
  renderRoster();
  renderFilter();
}

async function loadAll() {
  await loadOffice();
  [state.notes, state.log, state.approvals, state.chat] = await Promise.all([
    api("/api/notes"), api("/api/log"), api("/api/approvals"), api("/api/chat"),
  ]);
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
    [s.working, "al lavoro ora"], [s.agents, "agenti"], [s.rooms, "reparti"], [s.scheduled, "programmati"],
    [s.notes, "note in bacheca"], [s.trades, "ordini eseguiti"], [s.pending, "da approvare"],
    [`$${fmt(s.costUsd)}`, "spesa API (stima)"], [fmt(s.tokens / 1000, 1) + "k", "token usati"],
    [state.office.llmReady ? "sì" : "no", "Claude collegato"],
  ];
  $("#stats").innerHTML = cells.map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><small>${esc(l)}</small></div>`).join("");
  const badge = $("#badge-approvals");
  badge.textContent = s.pending;
  badge.classList.toggle("hidden", !s.pending);
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

document.querySelectorAll(".nav").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.view === "chat") return $("#chat").classList.add("open");
    state.view = b.dataset.view;
    document.querySelectorAll(".nav").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.id !== `view-${state.view}`));
    renderView();
  }),
);
$("#chat-close").onclick = () => $("#chat").classList.remove("open");

function renderView() {
  if (state.view === "approvals") renderApprovals();
  else if (state.view === "notes") renderNotes();
  else if (state.view === "log") renderLog();
  else if (state.view === "portfolio") renderPortfolio();
}

// ---------- ufficio ----------

function renderRoster() {
  const agents = state.office.agents;
  $("#roster-sum").textContent = `▸ Elenco completo dei ${agents.length} agenti`;
  const room = (id) => state.office.rooms.find((r) => r.id === id)?.name ?? id;
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

// ---------- approvazioni ----------

function renderApprovals() {
  const list = state.approvals;
  if (!list.length) {
    $("#approvals-list").innerHTML = `<p class="empty">Nessuna proposta. Quando un agente vuole comprare o vendere, la trovi qui.</p>`;
    return;
  }
  const label = { pending: "", executed: "✔ Eseguito", rejected: "Scartato", failed: "✖ Non eseguito", executing: "In esecuzione…" };
  $("#approvals-list").innerHTML = list
    .map((a) => {
      const o = a.order;
      const pending = a.status === "pending";
      return `<article class="card ${pending ? "" : "decided"}">
        <div class="kicker"><span class="${o.side}">${o.side === "buy" ? "Acquisto" : "Vendita"}</span><span class="meta">· ${esc(a.agentName)} · ${when(a.at)}</span></div>
        <h3>${o.side === "buy" ? "Compra" : "Vendi"} ${o.qty} ${esc(o.symbol)}</h3>
        <p>${esc(o.reason) || "Nessuna motivazione"}</p>
        <div class="actions">
          ${pending
            ? `<button class="btn good" data-approve="${a.id}">Fallo per me</button><button class="btn ghost" data-reject="${a.id}">Scarta</button>`
            : `<span class="meta">${label[a.status] ?? a.status}${a.trade ? ` a ${fmt(a.trade.price)}` : ""}${a.error ? ` — ${esc(a.error)}` : ""}</span>`}
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
    : `<div class="msg assistant" data-who="${esc(state.office.assistant.toUpperCase())}">Ciao! Sono ${esc(state.office.assistant)}, coordino gli agenti dell'ufficio. Chiedimi cosa stanno facendo, fai lavorare qualcuno o descrivimi un nuovo agente da creare.${state.office.llmReady ? "" : "\n\n⚠️ Per parlarmi serve ANTHROPIC_API_KEY sul server."}</div>`;
  body.scrollTop = body.scrollHeight;
  $("#chat").classList.toggle("busy", state.chat.busy);
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
$("#chat-reset").onclick = () => api("/api/chat/reset", { method: "POST" });

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
    id: "", name: "", avatar: "🤖", room: state.office.rooms[0].id, mode: "llm", enabled: true, everyMinutes: 0,
    watchlist: [], readsFrom: [], tools: ["get_quote", "get_indicators", "read_notes", "post_note"], canTrade: false,
    limits: { maxOrderPct: 10, maxPositionPct: 20, onlyWatchlist: true, requireApproval: true },
    model: "claude-opus-5-5", effort: "medium", instructions: "", strategy: state.office.strategies[0], params: {},
  };
  state.editing = isNew ? null : agent.id;
  $("#dlg-title").textContent = isNew ? "Nuovo agente" : `${agent.avatar} ${agent.name}`;
  form.room.innerHTML = state.office.rooms.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  form.strategy.innerHTML = state.office.strategies.map((s) => `<option>${esc(s)}</option>`).join("");

  form.id.value = agent.id;
  form.id.readOnly = !isNew;
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
  checkboxes($("#reads-checks"), "readsFrom", state.office.rooms.filter((r) => r.id !== agent.room).map((r) => [r.id, r.name]), agent.readsFrom);
  $("#delete-btn").classList.toggle("hidden", isNew);
  $("#run-btn").disabled = isNew;
  $("#form-errors").textContent = "";
  $("#run-task").value = "";
  syncMode();
  dlg.showModal();
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
    await api(`/api/agents/${encodeURIComponent(agent.id)}`, { method: "PUT", body: JSON.stringify(agent) });
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
      loadOffice().then(refreshStats);
      break;
    case "reset":
      loadAll();
      break;
  }
};

loadAll();
setInterval(refreshPortfolio, 60_000);
