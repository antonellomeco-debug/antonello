// Sezione 💡 Idee: l'utente scrive o incolla un'idea per i contenuti, sceglie per quali social, allega foto, video o
// documenti e dice SEMPRE perché. Gli agenti dei social le leggono (strumento ideas) e qui si vede chi le ha usate.

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (iso) => new Date(iso).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const mb = (n) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
const NET_LABEL = { instagram: "Instagram", linkedin: "LinkedIn", threads: "Threads", x: "X", youtube: "YouTube" };
const STATUS_LABEL = { nuova: "Da usare", in_uso: "In uso", usata: "Usata", archiviata: "Archiviata" };
const PLACEHOLDER = {
  argomenti: "Es. questi sono i temi da trattare nelle prossime settimane: bandi per le donne imprenditrici, passaggio generazionale…",
  stile: "Es. mi piace questo video: ritmo veloce, testo grande, voce calma. Facciamo qualcosa di simile per i Reel.",
  formato: "Es. proviamo questo formato a domande e risposte per i caroselli del sabato.",
  evitare: "Es. non usare mai più titoli con «incredibile» o «non ci crederai».",
  altro: "Spiega cosa vuoi che gli agenti facciano con questa idea.",
};

let api = null;
let data = null;
let filter = "da_usare";
let busy = false;
let notice = "";

export async function loadIdeas() {
  data = await api("/api/ideas");
  return data;
}

const linkify = (t) => esc(t).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);

function formHtml() {
  const motives = Object.entries(data.motives);
  return `
    <form class="card idea-form" id="idea-form" autocomplete="off">
      <h2>Nuova idea</h2>
      <label>Idea, testo o link
        <textarea name="text" rows="3" placeholder="Scrivi o incolla qui: un'idea, un argomento, il link di un video o di un articolo…"></textarea>
      </label>
      <fieldset class="idea-motives"><legend>Che cos'è?</legend>
        ${motives.map(([k, v], i) => `<label class="chip-radio"><input type="radio" name="motive" value="${k}" ${i === 0 ? "checked" : ""} /><span>${esc(v)}</span></label>`).join("")}
      </fieldset>
      <label>Perché? <b class="req">obbligatorio</b>
        <textarea name="reason" id="idea-reason" rows="2" required placeholder="${esc(PLACEHOLDER.argomenti)}"></textarea>
      </label>
      <fieldset class="idea-nets"><legend>Per quali social</legend>
        <label class="chip-check"><input type="checkbox" name="all" checked /><span>Tutti</span></label>
        ${data.networks.map((n) => `<label class="chip-check"><input type="checkbox" name="net" value="${n}" /><span>${NET_LABEL[n] ?? n}</span></label>`).join("")}
      </fieldset>
      <label>Foto, video o documenti (facoltativo)
        <input type="file" name="files" multiple accept="image/*,video/*,.pdf,.docx,.txt,.md" />
      </label>
      <p class="hint">Foto fino a 40 MB, video fino a 300 MB, PDF e Word fino a 25 MB. Dei video gli agenti vedono 6 fotogrammi e, se il riconoscimento vocale è pronto, leggono il parlato. I link di Instagram e TikTok gli agenti non riescono ad aprirli: meglio caricare il video o una schermata.</p>
      <div class="row wrap"><button class="btn primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Salvo…" : "Salva l'idea"}</button><span class="hint" id="idea-progress">${esc(notice)}</span></div>
    </form>`;
}

function fileHtml(idea, f) {
  const base = `/api/ideas/${idea.id}/files/${f.id}`;
  const state = f.kind === "video" && !f.ready ? `<small class="hint">⏳ ${esc(f.state ?? "in lavorazione")}</small>` : f.state && f.state !== "pronto" ? `<small class="hint">${esc(f.state)}</small>` : "";
  if (f.kind === "image") return `<a class="idea-file" href="${base}" target="_blank" rel="noopener"><img src="${base}" alt="${esc(f.name)}" loading="lazy" /></a>`;
  if (f.kind === "video") {
    return `<div class="idea-file idea-video">
      ${f.sheet ? `<a href="${base}" target="_blank" rel="noopener"><img src="${base}?v=sheet" alt="Fotogrammi di ${esc(f.name)}" loading="lazy" /></a>` : `<a href="${base}" target="_blank" rel="noopener">🎬 ${esc(f.name)}</a>`}
      <small>🎬 ${esc(f.name)}${f.seconds ? ` · ${f.seconds} s` : ""} · ${mb(f.size)}</small>${state}
      ${f.transcript ? `<details><summary>Parlato trascritto</summary><p>${esc(f.transcript)}</p></details>` : ""}
    </div>`;
  }
  return `<div class="idea-file idea-doc"><a href="${base}" target="_blank" rel="noopener">📄 ${esc(f.name)}</a><small>${mb(f.size)}${f.chars ? ` · ${f.chars.toLocaleString("it-IT")} caratteri letti` : ""}</small>${state}</div>`;
}

function ideaHtml(x) {
  const nets = x.networks.length ? x.networks.map((n) => NET_LABEL[n] ?? n).join(" · ") : "Tutti i social";
  const archived = x.status === "archiviata";
  return `
    <article class="card idea ${archived ? "muted" : ""}" data-id="${x.id}">
      <header class="idea-head">
        <span class="idea-motive m-${x.motive}">${esc(data.motives[x.motive] ?? x.motive)}</span>
        <span class="idea-status s-${x.status}">${STATUS_LABEL[x.status] ?? x.status}</span>
        <small class="hint">${when(x.at)} · ${esc(nets)}</small>
      </header>
      ${x.text ? `<p class="idea-text">${linkify(x.text)}</p>` : ""}
      <p class="idea-reason"><b>Perché:</b> ${esc(x.reason)}</p>
      ${x.files?.length ? `<div class="idea-files">${x.files.map((f) => fileHtml(x, f)).join("")}</div>` : ""}
      ${x.uses?.length ? `<ul class="idea-uses">${x.uses.slice(-5).reverse().map((u) => `<li>✔ <b>${esc(u.by)}</b> · ${when(u.at)}: ${esc(u.note)}</li>`).join("")}</ul>` : `<p class="hint">Nessun agente l'ha ancora usata.</p>`}
      <div class="row wrap">
        <label class="btn small ghost idea-add-file">📎 Aggiungi file<input type="file" data-add-files="${x.id}" multiple accept="image/*,video/*,.pdf,.docx,.txt,.md" hidden /></label>
        ${archived ? `<button class="btn small" data-idea-status="nuova">Rimetti tra quelle da usare</button>` : `<button class="btn small ghost" data-idea-status="archiviata">Archivia</button>`}
        ${x.status === "usata" && !archived ? `<button class="btn small ghost" data-idea-status="nuova">Da usare ancora</button>` : ""}
        <button class="btn small ghost danger" data-idea-delete>Elimina</button>
      </div>
    </article>`;
}

export function renderIdeas() {
  const el = $("#ideas-body");
  if (!el) return;
  if (!data) {
    el.innerHTML = `<p class="hint">Carico…</p>`;
    return;
  }
  // Non si riscrive il modulo mentre l'utente ci sta scrivendo o caricando.
  const form = $("#idea-form", el);
  const typing = form && (form.contains(document.activeElement) || busy);
  const list = data.ideas.filter((x) => (filter === "da_usare" ? x.status === "nuova" || x.status === "in_uso" : filter === "tutte" ? true : x.status === filter));
  const count = (s) => data.ideas.filter((x) => (s === "da_usare" ? x.status === "nuova" || x.status === "in_uso" : x.status === s)).length;
  const tabs = [["da_usare", "Da usare"], ["usata", "Usate"], ["archiviata", "Archiviate"], ["tutte", "Tutte"]];
  const listHtml = `
    <div class="filter idea-tabs" role="tablist">${tabs.map(([k, v]) => `<button class="chip ${filter === k ? "active" : ""}" data-idea-filter="${k}">${v}${k === "tutte" ? "" : ` (${count(k)})`}</button>`).join("")}</div>
    <div class="idea-list">${list.length ? list.map(ideaHtml).join("") : `<p class="empty">${filter === "da_usare" ? "Nessuna idea da usare: scrivine una qui sopra." : "Niente qui."}</p>`}</div>`;
  if (typing) {
    $("#idea-list-wrap", el).innerHTML = listHtml;
    return;
  }
  el.innerHTML = `${formHtml()}<div id="idea-list-wrap">${listHtml}</div>`;
}

/** Carica un file per un'idea, con l'avanzamento. */
function upload(ideaId, file, onPct) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/ideas/${ideaId}/files`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (ev) => ev.lengthComputable && onPct(Math.round((ev.loaded / ev.total) * 100));
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText || "{}");
      } catch {
        // risposta non JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body.error ?? `caricamento non riuscito (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("connessione interrotta durante il caricamento"));
    xhr.send(file);
  });
}

async function uploadAll(ideaId, files) {
  const errors = [];
  let i = 0;
  for (const f of files) {
    i++;
    const set = (pct) => {
      const p = $("#idea-progress");
      if (p) p.textContent = `Carico ${i} di ${files.length}: ${f.name} ${pct}%`;
    };
    try {
      await upload(ideaId, f, set);
    } catch (err) {
      errors.push(`${f.name}: ${err.message}`);
    }
  }
  return errors;
}

export function initIdeas(apiFn) {
  api = apiFn;
  const el = $("#ideas-body");
  const refresh = async () => {
    await loadIdeas();
    renderIdeas();
  };
  el.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.name === "motive") $("#idea-reason").placeholder = PLACEHOLDER[t.value] ?? "";
    if (t.name === "all" && t.checked) el.querySelectorAll('#idea-form input[name="net"]').forEach((c) => (c.checked = false));
    if (t.name === "net" && t.checked) $('#idea-form input[name="all"]').checked = false;
    if (t.dataset.addFiles && t.files?.length) {
      const errors = await uploadAll(t.dataset.addFiles, [...t.files]);
      if (errors.length) alert(errors.join("\n"));
      await refresh();
    }
  });
  el.addEventListener("submit", async (e) => {
    if (e.target.id !== "idea-form") return;
    e.preventDefault();
    const f = e.target;
    const reason = f.reason.value.trim();
    if (reason.length < 3) {
      f.reason.focus();
      return;
    }
    const networks = [...f.querySelectorAll('input[name="net"]:checked')].map((c) => c.value);
    const files = [...(f.files.files ?? [])];
    busy = true;
    notice = "";
    $("button[type=submit]", f).disabled = true;
    try {
      const idea = await api("/api/ideas", { method: "POST", body: JSON.stringify({ text: f.text.value, motive: f.motive.value, reason, networks }) });
      const errors = files.length ? await uploadAll(idea.id, files) : [];
      busy = false;
      notice = errors.length ? `Idea salvata, ma alcuni file no: ${errors.join("; ")}` : "✅ Idea salvata: gli agenti dei social la vedranno al prossimo lavoro.";
      filter = "da_usare";
      data = null;
      $("#ideas-body").innerHTML = "";
      await refresh();
    } catch (err) {
      busy = false;
      notice = "";
      renderIdeas();
      alert(err.message);
    }
  });
  el.addEventListener("click", async (e) => {
    const tab = e.target.closest("[data-idea-filter]");
    if (tab) {
      filter = tab.dataset.ideaFilter;
      renderIdeas();
      return;
    }
    const card = e.target.closest(".idea[data-id]");
    if (!card) return;
    const id = card.dataset.id;
    try {
      const st = e.target.closest("[data-idea-status]");
      if (st) {
        await api(`/api/ideas/${id}`, { method: "PUT", body: JSON.stringify({ status: st.dataset.ideaStatus }) });
        await refresh();
      } else if (e.target.closest("[data-idea-delete]")) {
        if (!confirm("Eliminare questa idea e i suoi file? Non si può annullare.")) return;
        await api(`/api/ideas/${id}`, { method: "DELETE" });
        await refresh();
      }
    } catch (err) {
      alert(err.message);
    }
  });
}
