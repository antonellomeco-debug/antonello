// Interfaccia: pianta dell'ufficio, bacheca, portafoglio, log ed editor degli agenti.
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, d = 2) => (n == null ? "—" : Number(n).toLocaleString("it-IT", { minimumFractionDigits: d, maximumFractionDigits: d }));
const time = (iso) => new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

const state = { office: null, notes: {}, log: [], portfolio: null, status: {}, room: null, tab: "notes", editing: null };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? res.statusText), { body });
  return body;
}

async function loadAll() {
  [state.office, state.notes, state.log] = await Promise.all([api("/api/office"), api("/api/notes"), api("/api/log")]);
  for (const a of state.office.agents) if (a.running) state.status[a.id] = { status: "working" };
  renderFloor();
  renderFilter();
  renderPanel();
  renderLLM();
  refreshPortfolio();
}

async function refreshPortfolio() {
  try {
    state.portfolio = await api("/api/portfolio");
  } catch {
    return;
  }
  const p = state.portfolio;
  const cls = p.pnlPct >= 0 ? "up" : "down";
  $("#kpis").innerHTML = `
    <div class="kpi"><div class="l">Valore</div><div class="v">€ ${fmt(p.total)}</div></div>
    <div class="kpi"><div class="l">P&L</div><div class="v ${cls}">${p.pnlPct >= 0 ? "+" : ""}${fmt(p.pnlPct)}%</div></div>
    <div class="kpi"><div class="l">Liquidità</div><div class="v">€ ${fmt(p.cash)}</div></div>
    <div class="kpi"><div class="l">Posizioni</div><div class="v">${p.positions.length}</div></div>`;
  if (state.tab === "portfolio") renderPanel();
}

function renderLLM() {
  const el = $("#llm-status");
  el.textContent = state.office.llmReady ? "● Claude collegato" : "○ Claude non configurato";
  el.className = `pill ${state.office.llmReady ? "ok" : ""}`;
  el.title = state.office.llmReady ? "" : "Imposta ANTHROPIC_API_KEY per gli agenti LLM. Gli agenti a regole funzionano comunque.";
}

// ---------- pianta ----------

function renderFloor() {
  const floor = $("#floor");
  floor.innerHTML = "";
  for (const room of state.office.rooms) {
    const el = document.createElement("div");
    el.className = `room ${state.room === room.id ? "selected" : ""}`;
    el.style.setProperty("--room", room.color);
    el.style.gridColumn = `${room.x + 1} / span ${room.w}`;
    el.style.gridRow = `${room.y + 1} / span ${room.h}`;
    el.innerHTML = `<h3>${esc(room.name)}</h3><p class="desc">${esc(room.description)}</p><div class="desks"></div><span class="door"></span>`;
    el.addEventListener("click", () => {
      state.room = state.room === room.id ? null : room.id;
      renderFloor();
      renderFilter();
      renderPanel();
    });
    const desks = $(".desks", el);
    for (const agent of state.office.agents.filter((a) => a.room === room.id)) desks.append(agentEl(agent));
    floor.append(el);
  }
}

function agentEl(agent) {
  const st = state.status[agent.id]?.status ?? "idle";
  const el = document.createElement("div");
  el.className = `agent ${st} ${agent.enabled ? "" : "disabled"}`;
  el.dataset.id = agent.id;
  const detail = state.status[agent.id]?.detail;
  el.title = `${agent.name} — ${agent.mode === "llm" ? "LLM" : `regola: ${agent.strategy}`}${detail ? `\n${detail}` : ""}`;
  el.innerHTML = `
    <div class="avatar">${esc(agent.avatar)}<span class="dot"></span></div>
    <div class="desk"></div>
    <div class="name">${esc(agent.name)}</div>
    <div class="meta">${agent.mode === "llm" ? "LLM" : esc(agent.strategy)} · ${agent.everyMinutes ? `ogni ${agent.everyMinutes}′` : "manuale"}</div>`;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    openEditor(agent);
  });
  return el;
}

function speak(agentId, text) {
  const el = document.querySelector(`.agent[data-id="${CSS.escape(agentId)}"]`);
  if (!el) return;
  el.querySelector(".bubble")?.remove();
  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  el.append(b);
  setTimeout(() => b.remove(), 6000);
}

// ---------- pannello laterale ----------

function renderFilter() {
  const el = $("#room-filter");
  el.innerHTML = "";
  const mk = (id, label) => {
    const b = document.createElement("button");
    b.className = `chip ${state.room === id ? "active" : ""}`;
    b.textContent = label;
    b.onclick = () => {
      state.room = id;
      renderFloor();
      renderFilter();
      renderPanel();
    };
    el.append(b);
  };
  mk(null, "Tutte");
  for (const r of state.office.rooms) mk(r.id, r.name);
}

const roomColor = (id) => state.office.rooms.find((r) => r.id === id)?.color;

function renderPanel() {
  for (const t of ["notes", "portfolio", "log"]) $(`#panel-${t}`).classList.toggle("hidden", t !== state.tab);
  $("#room-filter").classList.toggle("hidden", state.tab === "portfolio");
  if (state.tab === "notes") {
    const all = Object.entries(state.notes)
      .filter(([room]) => !state.room || room === state.room)
      .flatMap(([room, list]) => list.map((n) => ({ ...n, roomId: room })))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 80);
    $("#panel-notes").innerHTML = all.length
      ? all.map((n) => `
        <div class="note" style="--room:${roomColor(n.roomId)}">
          <div class="h"><b>${esc(n.agentName)}</b><span>${time(n.at)}</span></div>
          <div class="t">${esc(n.text)}</div>
          ${n.tags?.length ? `<div class="tags">${n.tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
        </div>`).join("")
      : `<p class="empty">Nessuna nota. Clicca un agente e premi ▶ Esegui.</p>`;
  } else if (state.tab === "log") {
    const ids = state.room ? state.office.agents.filter((a) => a.room === state.room).map((a) => a.id) : null;
    $("#panel-log").innerHTML = state.log
      .filter((l) => !ids || ids.includes(l.agentId))
      .slice(-150).reverse()
      .map((l) => `<div class="logline ${l.level}">${time(l.at)} [${esc(l.agentId)}] ${esc(l.message)}</div>`)
      .join("") || `<p class="empty">Nessuna attività.</p>`;
  } else {
    const p = state.portfolio;
    if (!p) return;
    $("#panel-portfolio").innerHTML = `
      <h4>Posizioni</h4>
      ${p.positions.length ? `<table><tr><th>Titolo</th><th>Q.tà</th><th>Medio</th><th>Prezzo</th><th>P&L</th></tr>
        ${p.positions.map((x) => `<tr><td>${esc(x.symbol)}${x.source === "demo" ? " *" : ""}</td><td>${x.qty}</td><td>${fmt(x.avgPrice)}</td><td>${fmt(x.price)}</td>
        <td class="${x.pnlPct >= 0 ? "up" : "down"}">${fmt(x.pnlPct)}%</td></tr>`).join("")}</table>` : `<p class="empty">Nessuna posizione aperta.</p>`}
      <h4>Ultimi ordini (simulati)</h4>
      ${p.trades.length ? `<table><tr><th>Titolo</th><th>Lato</th><th>Q.tà</th><th>Prezzo</th><th>Agente</th></tr>
        ${p.trades.slice().reverse().map((t) => `<tr title="${esc(t.reason)}"><td>${esc(t.symbol)}</td><td class="${t.side === "buy" ? "up" : "down"}">${t.side}</td><td>${t.qty}</td><td>${fmt(t.price)}</td><td>${esc(t.agentId)}</td></tr>`).join("")}</table>` : `<p class="empty">Nessun ordine.</p>`}
      <p class="hint">* prezzo da dati demo (mercato non raggiungibile)</p>
      <button class="btn danger" id="reset-btn" style="margin-top:12px">Azzera portafoglio e bacheche</button>`;
    $("#reset-btn").onclick = async () => {
      if (!confirm("Azzerare portafoglio, note e log?")) return;
      await api("/api/reset", { method: "POST" });
      loadAll();
    };
  }
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    state.tab = t.dataset.tab;
    renderPanel();
  }),
);

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
  const room = state.room ?? state.office.rooms[0].id;
  agent ??= {
    id: "", name: "", avatar: "🤖", room, mode: "llm", enabled: true, everyMinutes: 0, watchlist: [], readsFrom: [],
    tools: ["get_quote", "get_indicators", "read_notes", "post_note"], canTrade: false,
    limits: { maxOrderPct: 10, maxPositionPct: 20, onlyWatchlist: true },
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
    loadAll();
  } catch (err) {
    $("#form-errors").textContent = err.body?.errors?.join("\n") ?? err.message;
  }
});

$("#delete-btn").onclick = async () => {
  if (!state.editing || !confirm("Eliminare questo agente?")) return;
  await api(`/api/agents/${encodeURIComponent(state.editing)}`, { method: "DELETE" });
  dlg.close();
  loadAll();
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
  if (ev.type === "status") {
    state.status[ev.agentId] = { status: ev.status, detail: ev.detail };
    renderFloor();
  } else if (ev.type === "note") {
    (state.notes[ev.note.roomId] ??= []).push(ev.note);
    if (state.tab === "notes") renderPanel();
    speak(ev.note.agentId, ev.note.text);
  } else if (ev.type === "log") {
    state.log.push(ev.entry);
    if (state.tab === "log") renderPanel();
  } else if (ev.type === "trade") {
    refreshPortfolio();
  } else if (ev.type === "config" || ev.type === "reset") {
    loadAll();
  }
};

loadAll();
setInterval(refreshPortfolio, 60_000);
