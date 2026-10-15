// Sezione 📣 Social: collegamento degli account (Instagram, Threads, LinkedIn, X), pubblicazione automatica o con
// approvazione, chiave per le immagini con l'IA, archivio di foto e video (caricamento dal telefono) e post.
// Anche le schede dei post da approvare in ✅ Approvazioni (renderPostApproval).

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (iso) => new Date(iso).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const mb = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toLocaleString("it-IT", { maximumFractionDigits: bytes > 100 * 1024 * 1024 ? 0 : 1 })} MB`;

let api = null;
let status = null;
let mediaList = null;
const ui = { editingApp: new Set(), uploads: [] };

export const POST_STATUS = {
  pending: "In attesa della tua approvazione",
  scheduled: "🕒 Programmato",
  publishing: "Pubblicazione in corso…",
  published: "✔ Pubblicato",
  failed: "✖ Non pubblicato",
  rejected: "Scartato",
  cancelled: "Annullato",
  uncertain: "⚠️ Esito incerto",
};
const ORIGIN = { upload: "Caricato da te", graphic: "Grafica di un agente", ai: "Immagine IA", variant: "Copia" };
const NET_ICON = { instagram: "📸", threads: "🧵", linkedin: "💼", x: "𝕏" };
const NET_LABEL = { instagram: "Instagram", threads: "Threads", linkedin: "LinkedIn", x: "X" };

/** Spiegazioni passo passo per creare l'app di ogni social (una volta sola). */
function howto(net, redirect, server) {
  const copy = `<span class="copy-row"><code>${esc(redirect)}</code><button type="button" class="btn small" data-copy="${esc(redirect)}">Copia</button></span>`;
  const steps = {
    instagram: [
      `Il tuo account Instagram deve essere <b>professionale</b> (gratis): nell'app Instagram → Impostazioni → <b>Tipo di account e strumenti</b> → <b>Passa a un account professionale</b> (Creator o Azienda).`,
      `Apri <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">developers.facebook.com/apps</a>, entra con Facebook (se lo chiede, registrati come sviluppatore) e premi <b>Crea app</b>. Come caso d'uso scegli <b>Gestisci messaggi e contenuti su Instagram</b>; poi tipo <b>Business</b>.`,
      `Nella pagina dell'app: <b>Instagram</b> → <b>Configurazione dell'API con l'accesso di Instagram</b>. Al punto <b>Configura l'accesso aziendale di Instagram</b> → <b>Impostazioni dell'accesso aziendale</b>, in <b>URI di reindirizzamento OAuth</b> incolla:${copy}`,
      `Sempre lì, nella sezione <b>Ruoli</b> (o <b>Ruoli dell'app</b>) aggiungi il tuo account Instagram come <b>Tester di Instagram</b>; poi su instagram.com → Impostazioni → <b>App e siti web</b> → <b>Inviti tester</b> accetta l'invito.`,
      `Copia <b>ID app di Instagram</b> e <b>Chiave segreta dell'app di Instagram</b> (in alto nella pagina della configurazione) nei campi qui sotto e premi <b>Salva</b>, poi <b>Collega</b>. L'app può restare «In sviluppo»: per te stesso non serve la revisione di Meta.`,
    ],
    threads: [
      `Su <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">developers.facebook.com/apps</a> premi <b>Crea app</b> e scegli il caso d'uso <b>Accedi all'API di Threads</b>.`,
      `In <b>Casi d'uso</b> → <b>Personalizza</b> → <b>Autorizzazioni</b> aggiungi: threads_basic, threads_content_publish, threads_manage_insights, threads_read_replies, threads_manage_replies.`,
      `In <b>Impostazioni</b> incolla questo indirizzo in <b>URL di callback di reindirizzamento</b> (e, se li chiede, anche in quelli di disinstallazione ed eliminazione):${copy}`,
      `In <b>Ruoli dell'app</b> → <b>Aggiungi persone</b> → <b>Tester di Threads</b> scrivi il tuo nome utente; poi nell'app Threads → Impostazioni → Account → <b>Autorizzazioni dei siti web</b> → <b>Inviti</b> accetta.`,
      `Copia <b>ID app di Threads</b> e <b>Chiave segreta dell'app di Threads</b> (Impostazioni dell'app) qui sotto, premi <b>Salva</b> e poi <b>Collega</b>.`,
    ],
    linkedin: [
      `LinkedIn vuole che l'app sia legata a una <b>Pagina</b>: se non ne hai una, creala gratis (linkedin.com → <b>Per le aziende</b> → <b>Crea una pagina aziendale</b>), anche col tuo nome.`,
      `Apri <a href="https://www.linkedin.com/developers/apps" target="_blank" rel="noopener">linkedin.com/developers/apps</a> → <b>Create app</b>: nome, la tua Pagina, un logo qualsiasi; accetta i termini.`,
      `Scheda <b>Products</b>: premi <b>Request access</b> su <b>Share on LinkedIn</b> e su <b>Sign In with LinkedIn using OpenID Connect</b> (sono immediati).`,
      `Scheda <b>Auth</b> → <b>Authorized redirect URLs for your app</b> → aggiungi:${copy}`,
      `Sempre in <b>Auth</b> copia <b>Client ID</b> e <b>Primary Client Secret</b> qui sotto, premi <b>Salva</b> e poi <b>Collega</b>. Il collegamento dura 60 giorni: poi premi <b>Ricollega</b> (l'app ti avvisa).`,
    ],
    x: [
      `Apri <a href="https://console.x.com" target="_blank" rel="noopener">console.x.com</a> ed entra con il tuo account X. X si paga a consumo: aggiungi un po' di credito (es. 5 $). Un post costa <b>0,015 $</b>, ma <b>0,20 $ se contiene un link</b>.`,
      `Crea un'<b>app</b>. Nelle sue impostazioni apri <b>User authentication settings</b> → <b>Set up</b>: permessi <b>Read and write</b>, tipo <b>Web App, Automated App or Bot</b>.`,
      `In <b>Callback URI / Redirect URL</b> incolla questo indirizzo; come <b>Website URL</b> metti l'indirizzo della tua app:${copy}`,
      `Salva e copia <b>OAuth 2.0 Client ID</b> e <b>Client Secret</b> nei campi qui sotto (non le «API Key» OAuth 1.0), premi <b>Salva</b> e poi <b>Collega</b>.`,
    ],
  }[net];
  const note = !server && (net === "instagram" || net === "threads")
    ? `<p class="hint warn-text">⚠️ ${NET_LABEL[net]} funziona solo dall'app sul server (vuole un indirizzo https e scarica le foto da lì).</p>`
    : "";
  return `${note}<details class="howto"><summary>Come si fa (una volta sola)</summary><ol>${steps.map((s) => `<li>${s}</li>`).join("")}</ol>
    <p class="hint">Se una voce ha un nome un po' diverso, scrivimi cosa vedi e ti guido.</p></details>`;
}

function networkCard(n, st) {
  const acc = n.account;
  const pill = acc
    ? acc.expired
      ? `<span class="acct live">accesso scaduto</span>`
      : `<span class="acct demo">collegato</span> <b>${esc(acc.username)}</b>`
    : `<span class="acct paper">non collegato</span>`;
  const warn = [
    acc?.expiresSoon ? `L'accesso scade il ${when(acc.expiresAt)}: premi <b>Ricollega</b>.` : "",
    acc?.problem ? esc(acc.problem) : "",
  ].filter(Boolean).map((t) => `<p class="hint warn-text">⚠️ ${t}</p>`).join("");
  const showForm = !n.app || ui.editingApp.has(n.id);
  const idLabel = { instagram: "ID app di Instagram", threads: "ID app di Threads", linkedin: "Client ID", x: "OAuth 2.0 Client ID" }[n.id];
  const form = showForm
    ? `<form class="grid2" data-app-form="${n.id}" autocomplete="off">
        <label>${idLabel} <input name="clientId" spellcheck="false" autocomplete="off" value="${esc(n.app?.clientId ?? "")}" /></label>
        <label>Secret <input name="clientSecret" type="password" spellcheck="false" autocomplete="off" placeholder="${n.app?.hasSecret ? "già salvato (lascia vuoto)" : ""}" /></label>
        <div class="row-actions"><button class="btn small primary" type="submit">Salva</button>${n.app ? `<button class="btn small ghost" type="button" data-app-cancel="${n.id}">Annulla</button>` : ""}</div>
      </form>`
    : `<p class="meta">App: <code>${esc(n.app.clientId)}</code> <button class="btn small ghost" data-app-edit="${n.id}">Cambia</button></p>`;
  const actions = n.app
    ? `<div class="row-actions">
        <button class="btn small ${acc ? "ghost" : "primary"}" data-connect="${n.id}">🔗 ${acc ? "Ricollega" : "Collega"}</button>
        ${acc ? `<button class="btn small ghost" data-unlink="${n.id}">Scollega</button>` : ""}
      </div>`
    : "";
  const settings = `<div class="social-settings">
      <label>Pubblicazione
        <select data-auto="${n.id}">
          <option value="0" ${n.auto ? "" : "selected"}>Con la mia approvazione</option>
          <option value="1" ${n.auto ? "selected" : ""}>Automatica (senza chiedermi)</option>
        </select>
      </label>
      <label>Post al giorno (massimo) <input type="number" min="0" max="50" step="1" value="${n.maxPerDay}" data-max="${n.id}" /></label>
      <p class="meta">Oggi: ${n.today} su ${n.maxPerDay}${n.id === "x" ? " · 0,015 $ a post (0,20 $ con un link)" : ""}</p>
    </div>`;
  return `<article class="card social-card" data-net="${n.id}">
    <h3><span class="net-ico">${n.icon}</span> ${esc(n.label)} <span class="social-state">${pill}</span></h3>
    ${warn}
    ${form}
    ${actions}
    ${settings}
    ${howto(n.id, st.redirectUri, st.publicServer)}
  </article>`;
}

function aiCard(st) {
  const ai = st.ai;
  return `<h3>🎨 Immagini con l'IA <span class="social-state">${ai.configured ? `<span class="acct demo">attive</span> <span class="meta">chiave ${esc(ai.hint)}</span>` : `<span class="acct paper">non attive</span>`}</span></h3>
    <p class="sub">Senza chiave gli agenti disegnano lo stesso le grafiche (testi, caroselli, copertine) e usano le tue foto. Con la chiave di <b>Gemini</b> di Google possono anche creare immagini nuove (circa 0,07 $ l'una, sommati alla spesa nell'app).</p>
    <details class="howto"><summary>Come si fa</summary><ol>
      <li>Apri <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> ed entra con il tuo account Google.</li>
      <li>Premi <b>Crea chiave API</b> (Create API key) e copiala.</li>
      <li>Le immagini non sono nel piano gratuito: in AI Studio apri <b>Billing</b> (Fatturazione) e collega una carta. Puoi mettere un tetto di spesa nella console Google Cloud.</li>
      <li>Incolla la chiave qui sotto e premi Salva.</li>
    </ol></details>
    <form class="grid2" id="ai-form" autocomplete="off">
      <label>Chiave di Gemini <input name="key" type="password" spellcheck="false" autocomplete="off" placeholder="${ai.configured ? "già salvata (scrivi per cambiarla)" : "AIza…"}" /></label>
      <div class="row-actions"><button class="btn small primary" type="submit">Salva</button>${ai.configured ? `<button class="btn small ghost" type="button" id="ai-remove">Togli la chiave</button>` : ""}</div>
    </form>`;
}

function mediaCard(m) {
  const visual = m.kind === "video"
    ? `<video src="${esc(m.src)}" preload="metadata" controls playsinline muted></video>`
    : `<a href="${esc(m.src)}" target="_blank" rel="noopener"><img src="${esc(m.thumb ?? m.src)}" alt="${esc(m.title)}" loading="lazy" /></a>`;
  const dims = m.width ? ` · ${m.width}×${m.height}` : "";
  return `<article class="media-card" data-media="${esc(m.id)}">
    ${visual}
    <div class="media-body">
      <input class="media-title" value="${esc(m.title)}" placeholder="Titolo" maxlength="120" data-media-title="${esc(m.id)}" />
      <textarea rows="2" placeholder="Cosa mostra? (aiuta gli agenti)" maxlength="1000" data-media-desc="${esc(m.id)}">${esc(m.description)}</textarea>
      <p class="meta">${ORIGIN[m.origin] ?? esc(m.origin)}${m.by && m.origin !== "upload" ? ` (${esc(m.by)})` : ""} · ${mb(m.size)}${dims}${m.usedIn?.length ? ` · usato: ${esc(m.usedIn.at(-1))}` : ""}</p>
      <button class="btn small ghost" data-media-del="${esc(m.id)}">🗑 Elimina</button>
    </div>
  </article>`;
}

/** Miniature dei file di un post (per le schede dei post e delle approvazioni). */
export function postMediaStrip(list = []) {
  if (!list.length) return "";
  return `<div class="post-media">${list
    .map((m) => (m.missing
      ? `<span class="meta">file eliminato</span>`
      : m.kind === "video"
        ? `<video src="${esc(m.src)}" preload="metadata" controls playsinline muted></video>`
        : `<a href="${esc(m.src)}" target="_blank" rel="noopener"><img src="${esc(m.thumb ?? m.src)}" alt="${esc(m.title)}" loading="lazy" /></a>`))
    .join("")}</div>`;
}

function postCard(p) {
  const canCancel = p.status === "scheduled" || (p.status === "pending" && !p.approvalId);
  return `<article class="card post-card ${p.status === "published" ? "decided" : ""}">
    <div class="kicker"><span>${NET_ICON[p.network] ?? ""} ${esc(NET_LABEL[p.network] ?? p.network)}</span><span class="meta">· ${esc(p.agentName ?? "")} · ${when(p.at)}</span></div>
    <p class="post-text">${esc(p.text) || "<i>(senza testo)</i>"}</p>
    ${postMediaStrip(p.media)}
    <p class="meta">${POST_STATUS[p.status] ?? esc(p.status)}${p.status === "scheduled" && p.publishAt ? ` per ${when(p.publishAt)}` : ""}${p.publishedAt ? ` · ${when(p.publishedAt)}` : ""}${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">apri il post</a>` : ""}</p>
    ${p.error ? `<p class="hint warn-text">${esc(p.error)}</p>` : ""}
    ${canCancel ? `<button class="btn small ghost" data-post-cancel="${esc(p.id)}">Annulla</button>` : ""}
  </article>`;
}

/** Scheda di un post da approvare in ✅ Approvazioni. */
export function renderPostApproval(a, outcomeLabel) {
  const p = a.post ?? {};
  const pending = a.status === "pending";
  const net = NET_LABEL[p.network] ?? p.network;
  const what = p.replyTo ? `Risposta su ${net}` : p.format === "story" ? `Storia su ${net}` : `Post su ${net}`;
  const outcome = a.status === "scheduled"
    ? `🕒 Approvato: parte ${p.publishAt ? when(p.publishAt) : "all'ora scelta"}`
    : a.status === "executed"
      ? `✔ Pubblicato${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">apri il post</a>` : ""}`
      : `${outcomeLabel[a.status] ?? esc(a.status)}${a.error ? ` — ${esc(a.error)}` : ""}`;
  return `<article class="card ${pending ? "" : "decided"}">
    <div class="kicker"><span>${NET_ICON[p.network] ?? "📣"} ${esc(what)}</span><span class="meta">· ${esc(a.agentName)} · ${when(a.at)}</span></div>
    <p class="post-text">${esc(p.text) || "<i>(senza testo)</i>"}</p>
    ${postMediaStrip(p.media)}
    ${p.publishAt ? `<p class="meta">Da pubblicare: ${when(p.publishAt)}</p>` : ""}
    ${p.network === "x" ? `<p class="meta">Costo su X: ${/(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|it|net|org|io|ly|co|eu|me|app|dev|ai)\b/i.test(p.text ?? "") ? "0,20 $ (contiene un link)" : "0,015 $"}</p>` : ""}
    <p>${esc(p.reason) || ""}</p>
    <div class="actions">
      ${pending
        ? `<button class="btn good" data-approve="${a.id}">${p.publishAt ? "Approva" : "Pubblica"}</button><button class="btn ghost" data-reject="${a.id}">Scarta</button>`
        : `<span class="meta">${outcome}</span>`}
    </div>
  </article>`;
}

export async function loadSocial() {
  [status, mediaList] = await Promise.all([api("/api/social"), api("/api/media")]);
  return status;
}

const isEditing = (el) => el?.contains(document.activeElement) && document.activeElement !== el && document.activeElement.matches("input, textarea, select");

export function renderSocial() {
  if (!status) {
    $("#social-networks").innerHTML = `<p class="hint">Carico…</p>`;
    loadSocial().then(renderSocial, (err) => ($("#social-networks").innerHTML = `<p class="hint warn-text">${esc(err.message)}</p>`));
    return;
  }
  if (!isEditing($("#social-networks"))) {
    $("#social-networks").innerHTML = status.networks.map((n) => networkCard(n, status)).join("");
  }
  if (!isEditing($("#social-ai"))) $("#social-ai").innerHTML = aiCard(status);
  $("#media-usage").textContent = `${status.media.count} file · ${mb(status.media.bytes)}`;
  if (!isEditing($("#media-grid"))) {
    $("#media-grid").innerHTML = mediaList?.length
      ? mediaList.map(mediaCard).join("")
      : `<p class="empty">Ancora nessun file. Carica foto e video dal telefono: gli agenti li useranno per i post (scrivi due parole su cosa mostrano).</p>`;
  }
  $("#media-progress").innerHTML = ui.uploads.map((u) => `<p class="meta">${u.error ? "✖" : u.done ? "✔" : "⬆️"} ${esc(u.name)} ${u.error ? `— ${esc(u.error)}` : u.done ? "" : `${u.pct}%`}</p>`).join("");
  $("#social-posts").innerHTML = status.posts.length
    ? status.posts.map(postCard).join("")
    : `<p class="empty">Nessun post ancora. Quando un agente propone o pubblica un post lo trovi qui (e in ✅ Approvazioni).</p>`;
}

/** Errori mostrati con un avviso semplice. */
const act = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    alert(err.message);
  }
};

function bindEvents() {
  const view = $("#view-social");
  view.addEventListener("click", act(async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.copy) {
      await navigator.clipboard?.writeText(t.dataset.copy).catch(() => {});
      t.textContent = "Copiato";
      setTimeout(() => (t.textContent = "Copia"), 1500);
    } else if (t.dataset.appEdit) {
      ui.editingApp.add(t.dataset.appEdit);
      renderSocial();
    } else if (t.dataset.appCancel) {
      ui.editingApp.delete(t.dataset.appCancel);
      renderSocial();
    } else if (t.dataset.connect) {
      t.disabled = true;
      const { url } = await api(`/api/social/${t.dataset.connect}/auth`, { method: "POST" });
      location.href = url; // si torna qui dopo l'accesso al social
    } else if (t.dataset.unlink) {
      if (!confirm(`Scollegare ${NET_LABEL[t.dataset.unlink]}? Gli agenti non potranno più pubblicare lì.`)) return;
      status = await api(`/api/social/${t.dataset.unlink}/unlink`, { method: "POST" });
      renderSocial();
    } else if (t.dataset.mediaDel) {
      if (!confirm("Eliminare questo file dall'archivio? I post già pubblicati restano sui social.")) return;
      await api(`/api/media/${t.dataset.mediaDel}`, { method: "DELETE" });
      await loadSocial();
      renderSocial();
    } else if (t.dataset.postCancel) {
      await api(`/api/social/posts/${t.dataset.postCancel}/cancel`, { method: "POST" });
      await loadSocial();
      renderSocial();
    } else if (t.id === "ai-remove") {
      if (!confirm("Togliere la chiave di Gemini? Gli agenti non potranno più creare immagini con l'IA.")) return;
      status = await api("/api/social/ai", { method: "PUT", body: JSON.stringify({ key: "" }) });
      renderSocial();
    }
  }));
  view.addEventListener("submit", act(async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.dataset.appForm) {
      const net = f.dataset.appForm;
      status = await api(`/api/social/${net}/app`, { method: "PUT", body: JSON.stringify({ clientId: f.clientId.value, clientSecret: f.clientSecret.value }) });
      ui.editingApp.delete(net);
      document.activeElement?.blur();
      renderSocial();
    } else if (f.id === "ai-form") {
      if (!f.key.value.trim()) return;
      status = await api("/api/social/ai", { method: "PUT", body: JSON.stringify({ key: f.key.value }) });
      document.activeElement?.blur();
      renderSocial();
    }
  }));
  view.addEventListener("change", act(async (e) => {
    const t = e.target;
    if (t.dataset.auto) {
      const on = t.value === "1";
      if (on && !confirm(`Pubblicazione AUTOMATICA su ${NET_LABEL[t.dataset.auto]}: gli agenti pubblicheranno a tuo nome senza chiederti niente (sempre entro il massimo di post al giorno). Vuoi attivarla?`)) {
        t.value = "0";
        return;
      }
      status = await api(`/api/social/${t.dataset.auto}/settings`, { method: "PUT", body: JSON.stringify({ auto: on }) });
      t.blur();
      renderSocial();
    } else if (t.dataset.max) {
      status = await api(`/api/social/${t.dataset.max}/settings`, { method: "PUT", body: JSON.stringify({ maxPerDay: Number(t.value) }) });
      t.blur();
      renderSocial();
    } else if (t.dataset.mediaTitle || t.dataset.mediaDesc) {
      const id = t.dataset.mediaTitle ?? t.dataset.mediaDesc;
      const body = t.dataset.mediaTitle ? { title: t.value } : { description: t.value };
      const saved = await api(`/api/media/${id}`, { method: "PUT", body: JSON.stringify(body) });
      const i = mediaList.findIndex((m) => m.id === id);
      if (i >= 0) mediaList[i] = saved;
    }
  }));
  $("#media-input").addEventListener("change", (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    uploadAll(files);
  });
}

/** Carica i file uno alla volta, con la percentuale (i video dal telefono possono essere lenti). */
async function uploadAll(files) {
  const entries = files.map((f) => ({ file: f, name: f.name, pct: 0, done: false, error: null }));
  ui.uploads = entries;
  renderSocial();
  for (const u of entries) {
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/media");
        xhr.setRequestHeader("Content-Type", u.file.type || "application/octet-stream");
        xhr.setRequestHeader("X-File-Name", encodeURIComponent(u.name));
        xhr.upload.onprogress = (ev) => {
          if (!ev.lengthComputable) return;
          u.pct = Math.round((ev.loaded / ev.total) * 100);
          renderProgress();
        };
        xhr.onload = () => {
          let body = {};
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            // risposta non JSON
          }
          if (xhr.status === 401) location.href = "/login";
          xhr.status < 300 ? resolve(body) : reject(new Error(body.error ?? `errore ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error("connessione interrotta"));
        xhr.send(u.file);
      });
      u.done = true;
    } catch (err) {
      u.error = err.message;
    }
    renderProgress();
  }
  await loadSocial();
  renderSocial();
  setTimeout(() => {
    if (ui.uploads === entries && entries.every((u) => u.done)) {
      ui.uploads = [];
      renderProgress();
    }
  }, 4000);
}
function renderProgress() {
  $("#media-progress").innerHTML = ui.uploads.map((u) => `<p class="meta">${u.error ? "✖" : u.done ? "✔" : "⬆️"} ${esc(u.name)} ${u.error ? `— ${esc(u.error)}` : u.done ? "" : `${u.pct}%`}</p>`).join("");
}

export function initSocial(apiFn) {
  api = apiFn;
  bindEvents();
}
