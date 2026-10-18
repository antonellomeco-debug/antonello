// Sezione 💰 Spesa: quanto costano questo mese Orion, i palazzi e gli agenti; budget del mese (generale e per
// palazzo) e ritmo di ogni palazzo (normale, risparmio, minimo, pausa); gli agenti più costosi con i consigli; i report
// delle spese scritti dagli agenti (etichetta REPORT SPESE) e gli abbonamenti pagati fuori dalla piattaforma.

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (n) => `${(Number(n) || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const usd3 = (n) => `${(Number(n) || 0).toLocaleString("it-IT", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} $`;
const MODEL = { "claude-haiku-5-5": "Haiku", "claude-sonnet-5-5": "Sonnet", "claude-opus-5-5": "Opus", "claude-fable-5-1": "Fable", regole: "regole" };
const OTHER = { orion: "Orion (chat)", social: "Post programmati sui social", altro: "Altro" };

let api = null;
let helpers = {};
let report = null;
let showAll = false;
const money = (n, cur) => `${(Number(n) || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur === "USD" ? "$" : "€"}`;
const when = (iso) => new Date(iso).toLocaleString("it-IT", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export async function loadCosts() {
  report = await api("/api/costs");
  return report;
}

const every = (m) => (!m ? "a mano" : m % 1440 === 0 ? `ogni ${m / 1440 === 1 ? "giorno" : `${m / 1440} giorni`}` : m % 60 === 0 ? `ogni ${m / 60 === 1 ? "ora" : `${m / 60} ore`}` : `ogni ${m}′`);

function bar(value, max) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return `<span class="cost-bar ${pct >= 100 ? "over" : pct >= 80 ? "near" : ""}"><i style="width:${pct.toFixed(1)}%"></i></span>`;
}

export function renderCosts() {
  const el = $("#costs-body");
  if (!report) {
    el.innerHTML = `<p class="hint">Carico…</p>`;
    loadCosts().then(renderCosts, (err) => (el.innerHTML = `<p class="hint">${esc(err.message)}</p>`));
    return;
  }
  const r = report;
  const editing = el.contains(document.activeElement) && document.activeElement.matches("input");
  if (editing) return; // non si riscrive la pagina mentre si scrive un budget
  const paceOptions = (cur) => Object.entries(r.paces).map(([k, label]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(label)}</option>`).join("");
  const maxAgent = Math.max(...r.agents.map((a) => a.usdMonth), 0.0001);
  const agents = showAll ? r.agents : r.agents.slice(0, 12);
  const otherRows = Object.entries(r.other).filter(([, v]) => v > 0.005);
  el.innerHTML = `
    <div class="cost-kpis">
      <div class="cost-kpi"><small>Questo mese</small><b>${usd(r.total)}</b>${r.budget ? `${bar(r.total, r.budget)}<small>budget ${usd(r.budget)}</small>` : ""}</div>
      <div class="cost-kpi"><small>Oggi</small><b>${usd(r.today)}</b></div>
      <div class="cost-kpi"><small>Stima a fine mese</small><b>${usd(r.projection)}</b><small>con il ritmo di questi giorni</small></div>
    </div>
    ${r.budget && r.total >= r.budget ? `<p class="cost-alert">⛔ Budget del mese raggiunto: gli agenti programmati sono fermi. Orion e i lavori avviati a mano funzionano ancora.</p>` : r.budget && r.total >= r.budget * 0.8 ? `<p class="cost-alert warn">⚠️ Sei oltre l'80% del budget del mese.</p>` : ""}
    <form class="cost-budget" id="budget-form" autocomplete="off">
      <label for="budget-month">Budget del mese per tutto <span>oltre questa cifra gli agenti programmati si fermano fino al mese dopo (vuoto = nessun limite)</span></label>
      <div class="row"><input id="budget-month" name="monthly" type="number" min="0" step="1" inputmode="decimal" placeholder="es. 30" value="${r.budget ?? ""}" /> <span>$</span> <button class="btn small primary" type="submit">Salva</button></div>
    </form>

    ${reportsBlock(r)}

    <h2 class="section-title">Palazzi</h2>
    <div class="cost-palaces">
      ${r.palaces.map((p) => `
        <article class="card cost-palace" style="--c:${esc(p.color)}">
          <h3><i></i>${esc(p.name)}</h3>
          <p class="cost-big">${usd(p.usd)} <small>questo mese · ${p.agents} agenti</small></p>
          ${p.budget ? bar(p.usd, p.budget) : ""}
          <p class="meta">Stima per un mese intero: ${usd(p.monthlyEstimate)}${p.pace !== "normale" ? " (con il ritmo scelto)" : ""}</p>
          <label>Ritmo <select data-pace="${esc(p.id)}">${paceOptions(p.pace)}</select></label>
          <label>Budget del mese <span class="row"><input type="number" min="0" step="1" inputmode="decimal" placeholder="nessuno" value="${p.budget ?? ""}" data-budget="${esc(p.id)}" /> $</span></label>
        </article>`).join("")}
    </div>

    <h2 class="section-title">Agenti che spendono di più</h2>
    ${r.agents.length ? `<div class="table-wrap"><table class="cost-table">
      <thead><tr><th>Agente</th><th>Modello</th><th>Lavora</th><th class="num">Questo mese</th><th class="num">Per lavoro</th><th class="num">Stima al mese</th><th>Come risparmiare</th></tr></thead>
      <tbody>${agents.map((a) => `
        <tr class="${a.enabled ? "" : "off"}">
          <td><button class="link" data-agent="${esc(a.id)}">${esc(a.avatar ?? "🤖")} ${esc(a.name)}</button><small>${esc(helpers.palaceName?.(a.palace) ?? a.palace ?? "")}</small></td>
          <td>${esc(MODEL[a.model] ?? a.model)}${a.effort ? `<small>${esc(a.effort)}</small>` : ""}</td>
          <td>${a.enabled ? esc(every(a.everyMinutes)) : "spento"}${a.onlyOnNews ? "<small>solo con novità</small>" : ""}</td>
          <td class="num">${usd(a.usdMonth)}${bar(a.usdMonth, maxAgent)}<small>${a.runsMonth} lavori</small></td>
          <td class="num">${a.runsMonth ? usd3(a.perRun) : "—"}</td>
          <td class="num">${a.runsMonth && a.monthlyEstimate ? usd(a.monthlyEstimate) : "—"}</td>
          <td class="tips">${a.tips.map((t) => `<span>${esc(t)}</span>`).join("") || '<span class="ok">ok</span>'}</td>
        </tr>`).join("")}</tbody>
    </table></div>
    ${r.agents.length > 12 ? `<button class="btn small ghost" id="costs-all">${showAll ? "Mostra meno" : `Mostra tutti (${r.agents.length})`}</button>` : ""}` : `<p class="empty">Nessun agente.</p>`}

    ${subsBlock(r)}

    ${otherRows.length ? `<h2 class="section-title">Altre spese</h2><ul class="cost-other">${otherRows.map(([k, v]) => `<li><span>${esc(OTHER[k] ?? k)}</span><b>${usd(v)}</b></li>`).join("")}</ul>` : ""}

    <details class="howto cost-help"><summary>Come spendere meno</summary><ol>
      <li><b>Modello</b>: Haiku costa circa 40 volte meno di Opus e 20 meno di Sonnet. Per raccogliere dati, riassumere e pubblicare basta Haiku; Sonnet per scrivere testi e decidere strategie.</li>
      <li><b>Frequenza</b>: un agente ogni 15 minuti lavora 60 volte al giorno; ogni ora 15 volte; ogni giorno una volta. Chiediti quanto spesso serve davvero.</li>
      <li><b>Solo con novità</b> (nella scheda dell'agente): chi lavora solo su ciò che scrivono gli altri salta i giri in cui non c'è niente di nuovo, gratis.</li>
      <li><b>Ritmo del palazzo</b>: «Risparmio» dimezza i lavori di tutto il palazzo, «In pausa» lo ferma (per esempio i Social nel weekend o un palazzo che non usi).</li>
      <li><b>Budget</b>: un tetto per il mese, per tutto o per palazzo. Arrivati lì gli agenti programmati si fermano da soli.</li>
      <li>Puoi anche chiedere a Orion: «Guarda la spesa e proponimi come risparmiare senza perdere qualità».</li>
    </ol></details>`;
}

function reportsBlock(r) {
  const list = r.reports ?? [];
  if (!list.length) return "";
  return `<h2 class="section-title">📑 Report delle spese</h2>
    <div class="cost-reports">${list
      .map((x, i) => `<details class="card cost-report" ${i === 0 ? "open" : ""}>
        <summary><b>${esc(x.agentName)}</b><small>${esc(when(x.at))}</small></summary>
        <div class="cost-report-text">${esc(x.text)}</div>
      </details>`)
      .join("")}</div>`;
}

function subsBlock(r) {
  const subs = r.subscriptions ?? [];
  const palaceName = (id) => (id ? r.palaces.find((p) => p.id === id)?.name ?? id : "Generale");
  const monthly = Object.entries(r.subscriptionsMonthly ?? {}).filter(([, v]) => v > 0).map(([c, v]) => money(v, c)).join(" + ");
  const every = r.subEvery ?? { mese: "al mese", anno: "all'anno", "una tantum": "una volta" };
  return `<h2 class="section-title">Abbonamenti e servizi a pagamento</h2>
    <p class="hint">Quello che paghi fuori dalla piattaforma (Railway, ElevenLabs, ricariche dei crediti di Claude…): gli agenti delle spese lo leggono e lo mettono nei report. Segnarlo qui non paga e non attiva niente.</p>
    ${subs.length ? `<div class="table-wrap"><table class="cost-table cost-subs">
      <thead><tr><th>Servizio</th><th>Palazzo</th><th class="num">Importo</th><th>Rinnovo</th><th></th></tr></thead>
      <tbody>${subs.map((x) => `<tr>
        <td>${esc(x.name)}${x.note ? `<small>${esc(x.note)}</small>` : ""}</td>
        <td>${esc(palaceName(x.palace))}</td>
        <td class="num">${money(x.amount, x.currency)}<small>${esc(every[x.every] ?? x.every)}</small></td>
        <td>${x.every === "una tantum" ? esc(x.date ?? x.added ?? "") : x.renews ? `il ${x.renews} del mese` : "—"}</td>
        <td><button class="btn small ghost" data-sub-del="${esc(x.id)}" aria-label="Togli ${esc(x.name)}">✕</button></td>
      </tr>`).join("")}</tbody>
    </table></div>
    ${monthly ? `<p class="meta">Questo mese: <b>${monthly}</b> (gli annuali divisi per 12)</p>` : ""}` : ""}
    <details class="howto"><summary>➕ Aggiungi un abbonamento o una ricarica</summary>
      <form class="cost-sub-form" id="sub-form" autocomplete="off">
        <label for="sub-name">Servizio <input id="sub-name" name="name" required maxlength="80" placeholder="es. Railway Hobby" /></label>
        <label for="sub-amount">Importo <input id="sub-amount" name="amount" required inputmode="decimal" placeholder="es. 5" /></label>
        <label for="sub-currency">Valuta <select id="sub-currency" name="currency"><option value="EUR">€ euro</option><option value="USD">$ dollari</option></select></label>
        <label for="sub-every">Ogni <select id="sub-every" name="every">${Object.entries(every).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select></label>
        <label for="sub-palace">Palazzo <select id="sub-palace" name="palace"><option value="">Generale (tutta la piattaforma)</option>${r.palaces.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>
        <label for="sub-renews">Giorno del rinnovo <input id="sub-renews" name="renews" type="number" min="1" max="31" inputmode="numeric" placeholder="es. 14" /></label>
        <label for="sub-date">Data (per le ricariche) <input id="sub-date" name="date" type="date" /></label>
        <label for="sub-note">Note <input id="sub-note" name="note" maxlength="300" placeholder="es. 30.000 crediti al mese" /></label>
        <button class="btn primary" type="submit">Aggiungi</button>
      </form>
    </details>`;
}

export function initCosts(apiFn, h = {}) {
  api = apiFn;
  helpers = h;
  const el = $("#costs-body");
  const act = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (err) {
      alert(err.message);
    }
  };
  el.addEventListener("submit", act(async (e) => {
    e.preventDefault();
    if (e.target.id === "sub-form") {
      const f = Object.fromEntries(new FormData(e.target));
      report = await api("/api/costs/subscriptions", { method: "PUT", body: JSON.stringify(f) });
      document.activeElement?.blur();
      renderCosts();
      return;
    }
    if (e.target.id !== "budget-form") return;
    report = await api("/api/costs/budget", { method: "PUT", body: JSON.stringify({ monthlyUsd: e.target.monthly.value }) });
    document.activeElement?.blur();
    renderCosts();
  }));
  el.addEventListener("change", act(async (e) => {
    const t = e.target;
    if (t.dataset.pace) {
      if (t.value === "pausa" && !confirm("Mettere in pausa il palazzo? I suoi agenti programmati non lavoreranno finché non cambi il ritmo.")) {
        renderCosts();
        return;
      }
      report = await api("/api/costs/pace", { method: "PUT", body: JSON.stringify({ palace: t.dataset.pace, pace: t.value }) });
      t.blur();
      renderCosts();
    } else if (t.dataset.budget) {
      report = await api("/api/costs/budget", { method: "PUT", body: JSON.stringify({ palaces: { [t.dataset.budget]: t.value } }) });
      t.blur();
      renderCosts();
    }
  }));
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "costs-all") {
      showAll = !showAll;
      renderCosts();
    } else if (b.dataset.agent) helpers.openAgent?.(b.dataset.agent);
    else if (b.dataset.subDel) {
      act(async () => {
        if (!confirm("Togliere questo abbonamento dall'elenco? (Non lo disdice: per quello vai sul sito del servizio.)")) return;
        report = await api(`/api/costs/subscriptions/${encodeURIComponent(b.dataset.subDel)}`, { method: "DELETE" });
        renderCosts();
      })();
    }
  });
}
