// Sezione 📄 Report: i report settimanali in PDF scritti dagli agenti (strumento weekly_report), da aprire, scaricare
// o rimandare per email, e l'impostazione dell'email con Resend (chiave dell'utente, mai mostrata per intero).

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (iso) => new Date(iso).toLocaleString("it-IT", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const size = (n) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);

let api = null;
let data = null;
let notice = "";

export async function loadReports() {
  data = await api("/api/reports");
  return data;
}

function mailBox(m) {
  const state = m.configured
    ? `<p class="ok-line">✅ I report arrivano a <b>${esc(m.to)}</b>${m.customFrom ? ` (mittente ${esc(m.from)})` : ""}.</p>`
    : `<p class="warn-line">⚠️ Email non ancora impostata: i report restano solo qui sotto.</p>`;
  return `
    <section class="card report-mail">
      <h2>📧 Email dei report</h2>
      ${state}
      <details ${m.configured ? "" : "open"}>
        <summary>${m.configured ? "Cambia l'impostazione" : "Come si imposta (5 minuti, gratis)"}</summary>
        <ol class="steps">
          <li>Vai su <b>resend.com</b> e registrati con l'email dove vuoi ricevere i report (piano gratuito: 3.000 email al mese).</li>
          <li>Nel menu <b>API Keys</b> tocca <b>Create API Key</b>, permesso <b>Sending access</b>, e copia la chiave (inizia con <code>re_</code>).</li>
          <li>Incollala qui sotto, scrivi la stessa email della registrazione e tocca <b>Salva</b>, poi <b>Manda un'email di prova</b>.</li>
        </ol>
        <form id="mail-form" autocomplete="off">
          <label>Chiave di Resend <input name="key" type="password" placeholder="${m.hasKey ? `salvata (${esc(m.keyHint)}): lascia vuoto per tenerla` : "re_…"}" autocomplete="off" /></label>
          <label>Email a cui mandare i report <input name="to" type="email" value="${esc(m.to ?? "")}" placeholder="nome@gmail.com" /></label>
          <details class="adv"><summary>Mittente (solo con un tuo dominio verificato su Resend)</summary>
            <label>Mittente <input name="from" value="${m.customFrom ? esc(m.from) : ""}" placeholder="Venturo &lt;report@tuodominio.it&gt;" /></label>
            <p class="hint">Senza dominio verificato le email partono da onboarding@resend.dev e possono arrivare solo all'email della registrazione.</p>
          </details>
          <div class="row">
            <button class="btn primary" type="submit">Salva</button>
            ${m.hasKey ? `<button class="btn ghost" type="button" data-act="forget">Togli la chiave</button>` : ""}
          </div>
        </form>
      </details>
      ${m.configured ? `<div class="row"><button class="btn" type="button" data-act="test">✉️ Manda un'email di prova</button></div>` : ""}
      ${notice ? `<p class="hint" id="report-notice">${esc(notice)}</p>` : ""}
    </section>`;
}

function mailPill(e) {
  if (e?.status === "sent") return `<span class="rpill ok" title="${esc(when(e.at))}">📧 inviato</span>`;
  if (e?.status === "failed") return `<span class="rpill bad" title="${esc(e.error)}">📧 non partito</span>`;
  return `<span class="rpill">solo nell'app</span>`;
}

function reportCard(r) {
  const file = `/api/reports/${encodeURIComponent(r.id)}/file`;
  return `
    <article class="card report-card" data-id="${esc(r.id)}">
      <div class="report-head">
        <span class="report-ico">${r.type === "pdf" ? "📄" : "🌐"}</span>
        <div class="report-tit"><b>${esc(r.title)}</b><small>${esc(r.period)} · ${esc(r.palaceName ?? "tutti i palazzi")} · ${esc(r.agentName)} · ${esc(when(r.at))} · ${size(r.bytes)}</small></div>
        ${mailPill(r.email)}
      </div>
      ${r.summary ? `<p class="report-sum">${esc(r.summary)}</p>` : ""}
      ${r.email?.status === "failed" ? `<p class="hint">Email non partita: ${esc(r.email.error)}</p>` : ""}
      <div class="row">
        ${r.type === "pdf" ? `<a class="btn small primary" href="${file}" target="_blank" rel="noopener">Apri il PDF</a>` : ""}
        <a class="btn small" href="${file}?download=1" download>Scarica</a>
        <button class="btn small" type="button" data-act="mail">📧 Rimanda per email</button>
        <button class="btn small ghost" type="button" data-act="delete" title="Elimina">🗑</button>
      </div>
    </article>`;
}

export function renderReports() {
  const el = $("#reports-body");
  if (!data) {
    el.innerHTML = `<p class="hint">Carico…</p>`;
    loadReports().then(renderReports, (err) => (el.innerHTML = `<p class="hint">${esc(err.message)}</p>`));
    return;
  }
  if (el.contains(document.activeElement) && document.activeElement.matches("input")) return; // non si riscrive mentre si scrive
  const list = data.reports ?? [];
  el.innerHTML = `
    ${mailBox(data.mail)}
    <h2 class="section-title">Report ricevuti</h2>
    ${list.length ? list.map(reportCard).join("") : `<p class="hint">Ancora nessun report. Gli agenti con lo strumento «weekly_report» li scrivono (per esempio la domenica alle 18): chiedi a Orion di creare un «Reporter settimanale» in ogni palazzo.</p>`}`;
}

export function initReports(apiFn) {
  api = apiFn;
  const el = $("#reports-body");
  const act = (fn) => async (e) => {
    try {
      await fn(e);
    } catch (err) {
      alert(err.message);
    }
  };
  el.addEventListener("submit", act(async (e) => {
    if (e.target.id !== "mail-form") return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const body = { to: f.to, from: f.from ?? "" };
    if (f.key) body.key = f.key;
    data = await api("/api/reports/mail", { method: "PUT", body: JSON.stringify(body) });
    notice = data.mail.configured ? "Salvato. Ora prova con «Manda un'email di prova»." : "Salvato.";
    document.activeElement?.blur();
    renderReports();
  }));
  el.addEventListener("click", act(async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.closest("[data-id]")?.dataset.id;
    if (btn.dataset.act === "test") {
      btn.disabled = true;
      btn.textContent = "Invio…";
      try {
        await api("/api/reports/mail/test", { method: "POST" });
        notice = `Email di prova inviata a ${data.mail.to}: controlla la posta (anche lo spam).`;
      } catch (err) {
        notice = err.message;
      }
      renderReports();
    } else if (btn.dataset.act === "forget") {
      if (!confirm("Togliere la chiave di Resend? I report non arriveranno più per email.")) return;
      data = await api("/api/reports/mail", { method: "PUT", body: JSON.stringify({ key: "" }) });
      notice = "Chiave tolta.";
      renderReports();
    } else if (btn.dataset.act === "mail" && id) {
      btn.disabled = true;
      btn.textContent = "Invio…";
      await api(`/api/reports/${encodeURIComponent(id)}/mail`, { method: "POST" }).finally(() => (btn.disabled = false));
      await loadReports();
      renderReports();
    } else if (btn.dataset.act === "delete" && id) {
      if (!confirm("Eliminare questo report?")) return;
      data = await api(`/api/reports/${encodeURIComponent(id)}`, { method: "DELETE" });
      renderReports();
    }
  }));
}
