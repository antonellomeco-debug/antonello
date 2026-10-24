// Sezione 📣 Social: collegamento degli account (Instagram, Threads, LinkedIn, X, YouTube), pubblicazione automatica o con
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
const ORIGIN = { upload: "Caricato da te", graphic: "Grafica di un agente", ai: "Immagine IA", video: "Video montato da un agente", stock: "Repertorio (Pixabay/Pexels)", variant: "Copia" };
const NET_ICON = { instagram: "📸", threads: "🧵", linkedin: "💼", x: "𝕏", youtube: "▶️" };
const NET_LABEL = { instagram: "Instagram", threads: "Threads", linkedin: "LinkedIn", x: "X", youtube: "YouTube" };

// Distanza minima tra i post dello stesso social: automatica (fascia 08:00–22:00 divisa per i post al giorno) o scelta.
const hoursLabel = (m) => (m % 60 ? `${Math.floor(m / 60) ? `${Math.floor(m / 60)} h ` : ""}${m % 60} min` : `${m / 60} ${m === 60 ? "ora" : "ore"}`);
function gapSelect(n) {
  const set = Number.isInteger(n.minGapMinutes) ? n.minGapMinutes : null;
  const opts = [60, 120, 180, 240, 360];
  if (set !== null && set !== 0 && !opts.includes(set)) opts.push(set);
  const autoText = set === null ? (n.minGap ? hoursLabel(n.minGap) : "nessuna") : "fascia 8–22 divisa per i post al giorno";
  return `<label title="Se due post sono troppo vicini, il secondo si sposta da solo più avanti, tra le 8 e le 22">Distanza tra i post
        <select data-gap="${n.id}">
          <option value="" ${set === null ? "selected" : ""}>Automatica (${autoText})</option>
          ${opts.map((m) => `<option value="${m}" ${set === m ? "selected" : ""}>Almeno ${hoursLabel(m)}</option>`).join("")}
          <option value="0" ${set === 0 ? "selected" : ""}>Nessuna</option>
        </select>
      </label>`;
}

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
    youtube: [
      `Apri <a href="https://console.cloud.google.com" target="_blank" rel="noopener">console.cloud.google.com</a> con lo stesso account Google del canale. Puoi usare il progetto che hai già per la voce di Google, oppure crearne uno: in alto <b>Seleziona un progetto</b> → <b>Nuovo progetto</b> (nome «Venturo»).`,
      `Menu ☰ → <b>API e servizi</b> → <b>Libreria</b>: cerca <b>YouTube Data API v3</b> e premi <b>Abilita</b>. Poi cerca anche <b>YouTube Analytics API</b> e premi <b>Abilita</b> (servono per i numeri di YouTube Studio: tempo di visione, fidelizzazione, fonti di traffico). Sono gratis.`,
      `Menu ☰ → <b>Google Auth Platform</b> (o «Schermata consenso OAuth») → <b>Inizia</b>: nome dell'app «Venturo Agenti», la tua email, pubblico <b>Esterno</b>, di nuovo la tua email come contatto → <b>Crea</b>.`,
      `Sempre lì, <b>Pubblico</b> → <b>Pubblica app</b> → <b>Conferma</b> (stato «In produzione»). Se resta «Test» il collegamento scade ogni 7 giorni.`,
      `<b>Client</b> → <b>Crea client</b> → tipo <b>Applicazione web</b>, nome «Venturo». In <b>URI di reindirizzamento autorizzati</b> → <b>Aggiungi URI</b> e incolla:${copy} poi <b>Crea</b>.`,
      `Copia <b>ID client</b> e <b>Client secret</b> qui sotto, premi <b>Salva</b> e poi <b>Collega</b>: scegli l'account e il canale. Google avvisa «app non verificata»: è la tua app, tocca <b>Avanzate</b> → <b>Vai a Venturo Agenti</b> → <b>Continua</b>.`,
      `<b>Verifica di Google:</b> finché YouTube non verifica l'app, i video caricati dall'app restano <b>bloccati come privati</b>. Per questo, all'inizio, i video arrivano in ✅ Approvazioni e li carichi tu (📲 Condividi), mentre commenti e statistiche funzionano già. Chiedi la verifica (gratis) con il modulo <a href="https://support.google.com/youtube/contact/yt_api_form" target="_blank" rel="noopener">YouTube API Services – Audit</a>; quando Google risponde che l'app è approvata, qui sotto scegli <b>Caricamento dei video → Dall'app</b>.`,
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
  const idLabel = { instagram: "ID app di Instagram", threads: "ID app di Threads", linkedin: "Client ID", x: "OAuth 2.0 Client ID", youtube: "ID client" }[n.id];
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
  const manualNote = acc && n.id === "youtube" && !n.apiVerified
    ? `<p class="hint">Commenti e statistiche passano dal collegamento. I <b>video</b> invece li carichi tu da ✅ Approvazioni (📲 Condividi, poi <b>Fatto</b>) finché Google non verifica l'app: caricati dall'app resterebbero bloccati come privati.</p>`
    : !acc
    ? `<p class="hint">Senza collegamento i post degli agenti arrivano lo stesso in ✅ Approvazioni: li pubblichi tu con <b>📲 Condividi</b> (foto pronte e testo già copiato), poi tocchi <b>Fatto</b>.</p>`
    : "";
  const settings = `${manualNote}<div class="social-settings">
      <label>Pubblicazione
        <select data-auto="${n.id}">
          <option value="0" ${n.auto ? "" : "selected"}>Con la mia approvazione</option>
          <option value="1" ${n.auto ? "selected" : ""}>Automatica (senza chiedermi)</option>
        </select>
      </label>
      <label>Post al giorno (massimo) <input type="number" min="0" max="50" step="1" value="${n.maxPerDay}" data-max="${n.id}" /></label>
      ${gapSelect(n)}
      ${n.id === "instagram" ? `<label>Storie al giorno (massimo) <input type="number" min="0" max="25" step="1" value="${n.maxStoriesPerDay ?? 5}" data-max-stories="${n.id}" /></label>` : ""}
      ${n.id !== "linkedin" ? `<label>Risposte ai commenti
        <select data-replies="${n.id}">
          <option value="" ${n.autoReplies == null ? "selected" : ""}>Come i post</option>
          <option value="1" ${n.autoReplies === true ? "selected" : ""}>Automatiche</option>
          <option value="0" ${n.autoReplies === false ? "selected" : ""}>Con la mia approvazione</option>
        </select>
      </label>` : ""}
      <p class="meta">Oggi: ${n.today} su ${n.maxPerDay}${n.id === "instagram" ? ` · storie ${n.storiesToday ?? 0} su ${n.maxStoriesPerDay ?? 5}` : ""}${n.id === "x" ? " · 0,015 $ a post (0,20 $ con un link)" : ""}</p>
    </div>${n.id === "linkedin" ? pageSettings(n) : ""}${n.id === "youtube" ? youtubeSettings(n) : ""}`;
  return `<article class="card social-card" data-net="${n.id}">
    <h3><span class="net-ico">${n.icon}</span> ${esc(n.label)} <span class="social-state">${pill}</span></h3>
    ${warn}
    ${form}
    ${actions}
    ${settings}
    ${howto(n.id, st.redirectUri, st.publicServer)}
  </article>`;
}

/** Indirizzi delle pagine pubbliche Privacy e Termini, con il tasto Copia. */
function legalLinks() {
  const base = location.origin;
  return ["privacy", "termini"].map((p) => `<span class="copy-row"><code>${esc(`${base}/${p}`)}</code><button type="button" class="btn small" data-copy="${esc(`${base}/${p}`)}">Copia</button></span>`).join(" ");
}

/** YouTube: copia automatica dei video degli altri social, visibilità, etichetta IA e testo fisso della descrizione. */
function youtubeSettings(n) {
  return `<div class="social-settings yt">
    <label>Caricamento dei video
      <select data-yt="apiVerified">
        <option value="0" ${n.apiVerified ? "" : "selected"}>A mano da Approvazioni (finché Google non verifica l'app)</option>
        <option value="1" ${n.apiVerified ? "selected" : ""}>Dall'app (Google ha verificato l'app)</option>
      </select>
    </label>
    <label>Copia automatica
      <select data-yt="mirror">
        <option value="1" ${n.mirror ? "selected" : ""}>Ogni video uscito sugli altri social va anche su YouTube</option>
        <option value="0" ${n.mirror ? "" : "selected"}>Spenta (solo i video che gli agenti mandano a YouTube)</option>
      </select>
    </label>
    <label>Anche le storie di Instagram
      <select data-yt="mirrorStories">
        <option value="0" ${n.mirrorStories ? "" : "selected"}>No (consigliato: clip di pochi secondi)</option>
        <option value="1" ${n.mirrorStories ? "selected" : ""}>Sì, anche le storie video</option>
      </select>
    </label>
    <label>Visibilità dei video
      <select data-yt="privacy">
        <option value="public" ${n.privacy === "public" ? "selected" : ""}>Pubblici</option>
        <option value="unlisted" ${n.privacy === "unlisted" ? "selected" : ""}>Non in elenco (solo chi ha il link)</option>
        <option value="private" ${n.privacy === "private" ? "selected" : ""}>Privati</option>
      </select>
    </label>
    <label>Voce o immagini fatte con l'IA
      <select data-yt="aiLabel">
        <option value="1" ${n.aiLabel !== false ? "selected" : ""}>Dichiaralo a YouTube (consigliato)</option>
        <option value="0" ${n.aiLabel === false ? "selected" : ""}>Non dichiararlo</option>
      </select>
    </label>
    <label class="wide">Email di contatto (compare nelle pagine Privacy e Termini che chiede Google)
      <input type="email" data-yt="contactEmail" autocomplete="off" spellcheck="false" placeholder="ciao@venturo.it" value="${esc(n.contactEmail ?? "")}" />
    </label>
    <p class="meta wide-meta">Pagine pubbliche per il modulo di Google: ${legalLinks()}</p>
    <label class="wide">Testo in fondo a ogni descrizione (link, newsletter, altri social)
      <textarea data-yt="footer" rows="4" maxlength="1000" placeholder="📩 Newsletter gratuita: https://…&#10;📸 Instagram: …">${esc(n.footer ?? "")}</textarea>
    </label>
  </div>`;
}

/** LinkedIn: pagina aziendale dove escono i post (oltre al profilo o al suo posto). */
function pageSettings(n) {
  const on = Boolean(n.pageId);
  const state = !on
    ? ""
    : n.pageAuto
      ? `<p class="hint">✔ Sulla pagina pubblica il programma (accesso alle pagine attivo).</p>`
      : n.pageApi
        ? `<p class="hint warn-text">⚠️ Hai spuntato l'accesso alle pagine: premi <b>🔗 Ricollega</b> qui sopra. Finché LinkedIn non lo concede, i post della pagina li pubblichi tu da ✅ Approvazioni.</p>`
        : `<p class="hint">I post della pagina arrivano in ✅ Approvazioni: tocchi <b>🏢 Apri la pagina</b> (il testo è già copiato), incolli, aggiungi le foto e poi <b>Fatto</b>. Per farli uscire da soli serve il permesso di LinkedIn (vedi sotto).</p>`;
  return `<form class="social-page" data-page-form="linkedin" autocomplete="off">
      <h4>🏢 Pagina aziendale</h4>
      <div class="grid2">
        <label>Indirizzo o numero della pagina <input name="pageId" spellcheck="false" autocomplete="off" placeholder="linkedin.com/company/123456789/admin/…" value="${esc(n.pageId ?? "")}" /></label>
        <label>Nome della pagina <input name="pageName" maxlength="80" spellcheck="false" placeholder="Venturo" value="${esc(n.pageName ?? "")}" /></label>
      </div>
      ${on ? `<label>Dove escono i post
        <select name="pageOnly">
          <option value="0" ${n.pageOnly ? "" : "selected"}>Sul mio profilo e sulla pagina</option>
          <option value="1" ${n.pageOnly ? "selected" : ""}>Solo sulla pagina</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" name="pageApi" ${n.pageApi ? "checked" : ""} /> LinkedIn ha approvato l'accesso alle pagine della mia app («Community Management API»)</label>
      <p class="meta">Oggi sulla pagina: ${n.pageToday ?? 0} su ${n.maxPerDay}</p>` : ""}
      <div class="row-actions"><button class="btn small primary" type="submit">Salva</button>${on ? `<button class="btn small ghost" type="button" data-page-remove>Togli la pagina</button>` : ""}</div>
      ${state}
      ${on ? `<details class="howto"><summary>Come far pubblicare la pagina da sola (permesso di LinkedIn)</summary><ol>
        <li>Apri <a href="https://www.linkedin.com/developers/apps" target="_blank" rel="noopener">linkedin.com/developers/apps</a> → la tua app → scheda <b>Products</b>.</li>
        <li>Accanto a <b>Community Management API</b> premi <b>Request access</b> e compila il modulo (nome legale dell'azienda, indirizzo, sito, informativa privacy, a cosa serve: «pubblicare i post della mia pagina»). Se LinkedIn chiede di farlo in un'app nuova, scrivimelo e ti guido.</li>
        <li>Devi essere <b>amministratore</b> della pagina e la pagina deve essere collegata all'app (scheda <b>Settings</b> → Company → verifica).</li>
        <li>Quando LinkedIn approva (anche qualche settimana; a volte rifiuta), spunta la casella qui sopra, premi <b>Salva</b> e poi <b>🔗 Ricollega</b>.</li>
      </ol></details>` : ""}
    </form>`;
}

function aiCard(st) {
  const ai = st.ai;
  return `<h3>🎨 Immagini con l'IA <span class="social-state">${ai.configured ? `<span class="acct demo">attive</span> <span class="meta">chiave ${esc(ai.hint)}</span>` : `<span class="acct paper">non attive</span>`}</span></h3>
    <p class="sub">Senza chiave gli agenti disegnano lo stesso le grafiche (testi, caroselli, copertine) e usano le tue foto. Con la chiave di <b>Gemini</b> di Google possono anche creare immagini nuove (circa 0,07 $ l'una, sommati alla spesa nell'app).</p>
    <details class="howto"><summary>Come si fa</summary><ol>
      <li>Apri <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> ed entra con il tuo account Google.</li>
      <li>Premi <b>Crea chiave API</b> (Create API key) e copiala tutta con il pulsante <b>Copia</b> (inizia con «AQ.» oppure con «AIza»).</li>
      <li>Le immagini non sono nel piano gratuito: in AI Studio apri <b>Billing</b> (Fatturazione) e collega una carta. Puoi mettere un tetto di spesa nella console Google Cloud.</li>
      <li>Incolla la chiave qui sotto e premi Salva: l'app la prova subito con Google e ti dice se funziona.</li>
      <li>Se Google rifiuta una chiave «AQ.», creane una classica: <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">console.cloud.google.com/apis/credentials</a> → <b>Crea credenziali</b> → <b>Chiave API</b>, nello stesso progetto (con «Generative Language API» attiva).</li>
    </ol></details>
    <form class="grid2" id="ai-form" autocomplete="off">
      <label>Chiave di Gemini <input name="key" type="password" spellcheck="false" autocomplete="off" placeholder="${ai.configured ? "già salvata (scrivi per cambiarla)" : "AIza…"}" /></label>
      <div class="row-actions"><button class="btn small primary" type="submit">Salva</button>${ai.configured ? `<button class="btn small ghost" type="button" id="ai-remove">Togli la chiave</button>` : ""}</div>
    </form>`;
}

/** Video con la copertina (se c'è) e l'audio attivabile. */
const videoTag = (m) => `<video src="${esc(m.src)}"${m.thumb ? ` poster="${esc(m.thumb)}"` : ""} preload="${m.thumb ? "none" : "metadata"}" controls playsinline></video>`;

function stockCard(st) {
  const sk = st.stock ?? {};
  const pill = (c) => (c?.configured ? `(attiva, chiave ${esc(c.hint)})` : "(non attiva)");
  const form = (id, label, c) => `<form class="grid2" data-stock-form="${id}" autocomplete="off">
      <label>${label} ${pill(c)}<input name="key" type="password" spellcheck="false" autocomplete="off" placeholder="${c?.configured ? "già salvata (scrivi per cambiarla)" : "incolla la chiave"}" /></label>
      <div class="row-actions"><button class="btn small primary" type="submit">Salva</button>${c?.configured ? `<button class="btn small ghost" type="button" data-stock-remove="${id}">Togli la chiave</button>` : ""}</div>
    </form>`;
  return `<h3>🎞️ Video e foto di repertorio <span class="social-state">${sk.configured ? `<span class="acct demo">attivi</span>` : `<span class="acct paper">non attivi</span>`}</span></h3>
    <p class="sub">Con una chiave <b>gratuita</b> gli agenti cercano clip e foto vere (uffici, città, borsa, persone al lavoro) e le montano nei reel insieme alle tue foto e ai tuoi video. Uso libero anche per il brand, nessun costo. Basta una delle due; con tutte e due c'è più scelta.</p>
    <details class="howto"><summary>Chiave di Pixabay (consigliata, 3 minuti)</summary><ol>
      <li>Apri <a href="https://pixabay.com/it/accounts/register/" target="_blank" rel="noopener">pixabay.com</a> e crea un account gratuito (<b>Iscriviti</b>, con email o Google). Conferma l'email che ti arriva.</li>
      <li>Da collegato apri <a href="https://pixabay.com/api/docs/" target="_blank" rel="noopener">pixabay.com/api/docs</a>.</li>
      <li>Scorri fino alla tabella <b>Parameters</b>: alla riga <b>key (required)</b> c'è scritta in verde la tua chiave («Your API key: …»). Selezionala tutta e copiala.</li>
      <li>Incollala qui sotto e premi Salva: l'app la prova subito con Pixabay.</li>
    </ol></details>
    ${form("pixabay", "Chiave di Pixabay", sk.pixabay)}
    <details class="howto"><summary>Chiave di Pexels (facoltativa)</summary><ol>
      <li>Apri <a href="https://www.pexels.com/api/" target="_blank" rel="noopener">www.pexels.com/api</a>, crea un account gratuito e compila il breve modulo.</li>
      <li>Copia <b>Your API Key</b> e incollala qui sotto. (Se Pexels dice che il rilascio delle chiavi è in pausa, usa Pixabay.)</li>
    </ol></details>
    ${form("pexels", "Chiave di Pexels", sk.pexels)}`;
}

const voiceLabel = (v) => `${v.name.split("-").pop()}${v.gender ? ` (${v.gender})` : ""}`;

function voiceCard(st) {
  const vc = st.voice ?? { google: {}, voices: [], eleven: {}, selected: "local", usage: { chars: 0, free: 1000000 } };
  const el = vc.eleven ?? {};
  const current = vc.selected === "local" ? "voce gratuita del server" : vc.selected === "eleven" ? "la tua voce (ElevenLabs)" : voiceLabel(vc.voices.find((v) => v.name === vc.selected) ?? { name: vc.selected });
  const nf = new Intl.NumberFormat("it-IT");
  const options = [`<option value="local"${vc.selected === "local" ? " selected" : ""}>Voce gratuita del server (Paola)</option>`]
    .concat(el.configured
      ? [`<option value="eleven"${vc.selected === "eleven" ? " selected" : ""}>La mia voce · ElevenLabs${el.voiceName ? ` (${esc(el.voiceName)})` : ""}</option>`]
      : [`<option value="eleven" disabled>La mia voce · ElevenLabs (prima metti chiave e ID qui sotto)</option>`])
    .concat(vc.voices.map((v) => `<option value="${esc(v.name)}"${v.name === vc.selected ? " selected" : ""}>Google · ${esc(voiceLabel(v))}</option>`))
    .join("");
  return `<h3>🎙️ Voce dei video <span class="social-state"><span class="acct demo">${esc(current)}</span></span></h3>
    <p class="sub">La voce narrante dei reel. Con la chiave di <b>Google</b> puoi scegliere tra le voci «Chirp 3 HD», molto naturali (uomini e donne). Google regala <b>1 milione di caratteri al mese</b> (circa 2.000 reel): l'app conta i caratteri e oltre 950.000 nel mese torna da sola alla voce gratuita del server, così non paghi mai senza saperlo.</p>
    <details class="howto"><summary>Chiave di Google, passo passo (10 minuti, una volta sola)</summary><ol>
      <li>Apri <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">console.cloud.google.com</a> ed entra con il tuo account Google (se è la prima volta accetta le condizioni).</li>
      <li>In alto a sinistra scegli un progetto (va bene quello di Gemini) oppure premi <b>Nuovo progetto</b> e chiamalo «Venturo».</li>
      <li>Menu ☰ → <b>Fatturazione</b> → collega un account di fatturazione con la tua carta. Serve a Google anche per la parte gratuita.</li>
      <li>Apri <a href="https://console.cloud.google.com/apis/library/texttospeech.googleapis.com" target="_blank" rel="noopener">Cloud Text-to-Speech API</a> e premi <b>Abilita</b> (Enable).</li>
      <li>Menu ☰ → <b>API e servizi</b> → <b>Credenziali</b> → <b>Crea credenziali</b> → <b>Chiave API</b>. Copia la chiave (inizia con «AIza»).</li>
      <li>Consigliato: premi <b>Modifica chiave</b> → <b>Limita chiave</b> → scegli solo «Cloud Text-to-Speech API» → Salva.</li>
      <li>Incolla la chiave qui sotto e premi Salva: l'app chiede subito a Google l'elenco delle voci italiane.</li>
    </ol></details>
    <form class="grid2" id="voice-key-form" autocomplete="off">
      <label>Chiave di Google ${vc.google.configured ? `(salvata, ${esc(vc.google.hint)})` : "(non ancora messa)"}<input name="key" type="password" spellcheck="false" autocomplete="off" placeholder="${vc.google.configured ? "già salvata (scrivi per cambiarla)" : "AIza…"}" /></label>
      <div class="row-actions"><button class="btn small primary" type="submit">Salva</button>${vc.google.configured ? `<button class="btn small ghost" type="button" id="voice-key-remove">Togli la chiave</button>` : ""}</div>
    </form>
    <div class="grid2">
      <label>Voce dei video <select id="voice-select">${options}</select></label>
      <div class="row-actions">${vc.voices.length || el.configured ? `<button class="btn small" type="button" id="voice-preview">▶️ Ascolta</button>` : ""}</div>
    </div>
    ${vc.selected === "eleven" ? `<p class="meta">✔ <b>La tua voce è la voce predefinita</b>: tutti i video degli agenti e di Orion parlano con la tua voce clonata. Ricordati «Voce generata con IA» nella didascalia.</p>
    <div class="grid2">
      <label>Se la tua voce non è disponibile <select id="voice-fallback">${[
        `<option value="local"${vc.fallback === "local" ? " selected" : ""}>Usa la voce gratuita del server</option>`,
        ...(vc.google.configured ? vc.voices.map((v) => `<option value="${esc(v.name)}"${v.name === vc.fallback ? " selected" : ""}>Usa Google · ${esc(voiceLabel(v))}</option>`) : []),
        `<option value="stop"${vc.fallback === "stop" ? " selected" : ""}>Non fare il video (riprova più tardi)</option>`,
      ].join("")}</select></label>
      <p class="hint">Succede se ElevenLabs non risponde o se i crediti del mese sono finiti.</p>
    </div>` : ""}
    ${vc.google.configured ? `<p class="meta">Caratteri di Google usati questo mese: ${nf.format(vc.usage.chars)} su ${nf.format(vc.usage.free)} gratuiti.</p>` : ""}
    <h4>🗣️ La tua voce (ElevenLabs)</h4>
    <p class="sub">Per far parlare i video con <b>la tua voce</b>: la crei una volta su ElevenLabs (piano Starter, circa 6 $ al mese, che permette l'uso commerciale) e metti qui la chiave e l'ID della voce. Appena la salvi diventa la voce predefinita di tutti i video; se ElevenLabs non risponde o i crediti del mese finiscono, si usa la voce di riserva che scegli qui sopra.</p>
    <details class="howto"><summary>Chiave e ID della voce, passo passo</summary><ol>
      <li>Su <a href="https://elevenlabs.io" target="_blank" rel="noopener">elevenlabs.io</a>, menu a sinistra → <b>Developers</b> → <b>API Keys</b> → <b>Create API Key</b>.</li>
      <li>Permessi: <b>Text to Speech</b> (accesso) e <b>Voices</b> (lettura); metti un limite di caratteri al mese. Copia la chiave (inizia con «sk_»).</li>
      <li>Menu <b>Voices</b> → <b>My Voices</b> → «…» sulla tua voce → <b>Copy voice ID</b>.</li>
      <li>Incolla tutti e due qui sotto e premi Salva: l'app fa una prova di una parola e sceglie la tua voce per i video.</li>
    </ol></details>
    <form class="grid2" id="eleven-form" autocomplete="off">
      <label>Chiave di ElevenLabs ${el.hint ? `(salvata, ${esc(el.hint)})` : "(non ancora messa)"}<input name="key" type="password" spellcheck="false" autocomplete="off" placeholder="${el.hint ? "già salvata (scrivi per cambiarla)" : "sk_…"}" /></label>
      <label>ID della voce<input name="voiceId" type="text" spellcheck="false" autocomplete="off" value="${esc(el.voiceId ?? "")}" placeholder="es. 21m00Tcm4TlvDq8ikWAM" /></label>
      <label>Modello <select name="model">
        <option value="eleven_multilingual_v2"${(el.model ?? "eleven_multilingual_v2") === "eleven_multilingual_v2" ? " selected" : ""}>Multilingual v2 (stabile, consigliato)</option>
        <option value="eleven_v3"${el.model === "eleven_v3" ? " selected" : ""}>v3 (più espressivo)</option>
        <option value="eleven_flash_v2_5"${el.model === "eleven_flash_v2_5" ? " selected" : ""}>Flash v2.5 (metà crediti)</option>
      </select></label>
      <div class="row-actions"><button class="btn small primary" type="submit">Salva</button>${el.hint ? `<button class="btn small ghost" type="button" id="eleven-remove">Togli</button>` : ""}</div>
    </form>
    ${el.configured ? `<p class="meta">Caratteri letti con la tua voce questo mese: ${nf.format(el.charsThisMonth ?? 0)} (lo Starter ne comprende circa 30.000).</p>` : ""}`;
}

let previewAudio = null;
/** Fa sentire una frase di prova con la voce scelta nell'elenco (la voce del server non ha l'ascolto). */
async function playPreview(btn) {
  const name = $("#voice-select").value;
  if (name === "local") return alert("La voce gratuita del server si sente nei video di prova: scegli una voce di Google per l'ascolto.");
  btn.disabled = true;
  btn.textContent = "Preparo…";
  try {
    const res = await fetch("/api/social/voice/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `errore ${res.status}`);
    previewAudio?.pause();
    previewAudio = new Audio(URL.createObjectURL(await res.blob()));
    await previewAudio.play();
  } finally {
    btn.disabled = false;
    btn.textContent = "▶️ Ascolta";
  }
}

function mediaCard(m) {
  const visual = m.kind === "video"
    ? videoTag(m)
    : m.kind === "audio"
      ? `<div class="media-audio">🎵<audio src="${esc(m.src)}" preload="none" controls></audio></div>`
      : `<a href="${esc(m.src)}" target="_blank" rel="noopener"><img src="${esc(m.thumb ?? m.src)}" alt="${esc(m.title)}" loading="lazy" /></a>`;
  const dims = (m.width ? ` · ${m.width}×${m.height}` : "") + (m.duration ? ` · ${m.duration} s` : "");
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
        ? videoTag(m)
        : `<a href="${esc(m.src)}" target="_blank" rel="noopener"><img src="${esc(m.thumb ?? m.src)}" alt="${esc(m.title)}" loading="lazy" /></a>`))
    .join("")}</div>`;
}

function postCard(p) {
  const canCancel = p.status === "scheduled" || p.status === "pending";
  return `<article class="card post-card ${p.status === "published" ? "decided" : ""}">
    <div class="kicker"><span>${NET_ICON[p.network] ?? ""} ${esc(NET_LABEL[p.network] ?? p.network)}${p.page ? ` · pagina ${esc(p.page.name)}` : ""}</span><span class="meta">· ${esc(p.agentName ?? "")} · ${when(p.at)}</span></div>
    ${p.title ? `<p class="post-title"><b>${esc(p.title)}</b></p>` : ""}
    <p class="post-text">${esc(p.text) || "<i>(senza testo)</i>"}</p>
    ${postMediaStrip(p.media)}
    ${p.note ? `<p class="hint warn-text">⚠️ ${esc(p.note)}</p>` : ""}
    <p class="meta">${POST_STATUS[p.status] ?? esc(p.status)}${p.status === "scheduled" && p.publishAt ? ` per ${when(p.publishAt)}` : ""}${p.publishedAt ? ` · ${when(p.publishedAt)}` : ""}${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">apri il post</a>` : ""}</p>
    ${p.error ? `<p class="hint warn-text">${esc(p.error)}</p>` : ""}
    ${canCancel ? `<button class="btn small ghost" data-post-cancel="${esc(p.id)}">Annulla</button>` : ""}
  </article>`;
}

/** Copertina del Reel (video animati): solo per Instagram, dove la griglia del profilo mostra la copertina. */
const coverOf = (p) => (p.network === "instagram" && p.format !== "story" ? (p.media ?? []).find((m) => m.kind === "video" && m.cover)?.cover ?? null : null);

/** Scheda di un post da approvare in ✅ Approvazioni. */
export function renderPostApproval(a, outcomeLabel) {
  const p = a.post ?? {};
  const pending = a.status === "pending";
  const net = p.page ? `${NET_LABEL[p.network] ?? p.network} · pagina ${p.page.name}` : NET_LABEL[p.network] ?? p.network;
  const what = p.replyTo ? `Risposta su ${net}` : p.format === "story" ? `Storia su ${net}` : p.network === "youtube" ? `Video su ${net}${p.mirrorOf ? " (copia automatica)" : ""}` : `Post su ${net}`;
  const outcome = a.status === "scheduled"
    ? `🕒 Approvato: parte ${p.publishAt ? when(p.publishAt) : "all'ora scelta"}`
    : a.status === "executed"
      ? p.manual ? "✔ Pubblicato da te" : `✔ Pubblicato${p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">apri il post</a>` : ""}`
      : `${outcomeLabel[a.status] ?? esc(a.status)}${a.error ? ` — ${esc(a.error)}` : ""}`;
  return `<article class="card ${pending ? "" : "decided"}">
    <div class="kicker"><span>${NET_ICON[p.network] ?? "📣"} ${esc(what)}</span><span class="meta">· ${esc(a.agentName)} · ${when(a.at)}</span></div>
    ${p.title ? `<p class="post-title"><b>${esc(p.title)}</b></p>` : ""}
    <p class="post-text">${esc(p.text) || "<i>(senza testo)</i>"}</p>
    ${postMediaStrip(p.media)}
    ${p.publishAt ? `<p class="meta">${p.manual ? "Ora consigliata" : "Da pubblicare"}: ${when(p.publishAt)}</p>` : ""}
    ${p.network === "x" ? `<p class="meta">Costo su X: ${/(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|it|net|org|io|ly|co|eu|me|app|dev|ai)\b/i.test(p.text ?? "") ? "0,20 $ (contiene un link)" : "0,015 $"}</p>` : ""}
    <p>${p.purpose ? `<b>${p.purpose === "clienti" ? "🎯 Porta clienti" : "📚 Valore"}</b> · ` : ""}${esc(p.reason) || ""}</p>
    ${pending && p.manual && p.page ? `<ol class="share-steps">
      ${(p.media ?? []).length ? `<li>Tocca <b>📲 Salva i file</b> e scegli <b>Salva immagine</b> (o <b>Salva video</b>).</li>` : ""}
      <li>Tocca <b>🏢 Apri la pagina</b>: il testo è già copiato. Su LinkedIn premi <b>Crea</b> (o «Inizia un post») come pagina ${esc(p.page.name)}, tieni premuto → <b>Incolla</b>${(p.media ?? []).length ? ", aggiungi i file dalla galleria" : ""} e pubblica.</li>
      <li>Torna qui e tocca <b>Fatto</b>.</li>
    </ol>` : ""}
    ${pending && p.manual && !p.page ? `<ol class="share-steps">
      ${coverOf(p) ? `<li>Tocca <b>🖼️ Salva copertina</b> e scegli <b>Salva immagine</b>: è la copertina con il titolo per la griglia del profilo.</li>` : ""}
      <li>Tocca <b>📲 Condividi</b>: ${(p.media ?? []).length ? `${(p.media ?? []).some((m) => m.kind === "video") ? "i file sono pronti" : "le foto sono pronte"} e ${p.network === "youtube" ? "il titolo è" : "il testo è"} già copiato` : "il testo è pronto (ed è già copiato)"}.</li>
      <li>Scegli <b>${esc(net)}</b>${p.network === "instagram" ? (p.format === "story" ? " → <b>Storia</b>" : " → <b>Feed</b>") : ""}${p.network === "instagram" ? `, tieni premuto nella didascalia → <b>Incolla</b>${coverOf(p) ? "; tocca <b>Modifica copertina</b> → <b>Aggiungi dal rullino</b> e scegli la copertina salvata" : ""}` : ""}${p.network === "youtube" ? " (se non c'è: <b>Salva video</b> e caricalo dall'app YouTube con <b>+</b>). Incolla il titolo; poi torna qui, tocca <b>📋 Copia descrizione</b> e incollala nella descrizione" : ""} e pubblica.</li>
      <li>Torna qui e tocca <b>Fatto</b>.</li>
    </ol>` : ""}
    <div class="actions">
      ${pending
        ? p.manual && p.page
          ? `${(p.media ?? []).length ? `<button class="btn" data-share="${a.id}">📲 Salva i file</button>` : ""}<button class="btn primary" data-open-page="${a.id}">🏢 Apri la pagina</button><button class="btn good" data-approve="${a.id}">✔ Fatto</button><button class="btn ghost" data-reject="${a.id}">Scarta</button>`
          : p.manual
          ? `${coverOf(p) ? `<button class="btn" data-save-cover="${a.id}">🖼️ Salva copertina</button>` : ""}<button class="btn primary" data-share="${a.id}">📲 Condividi su ${esc(net)}</button>${p.network === "youtube" ? `<button class="btn" data-copy-desc="${a.id}">📋 Copia descrizione</button>` : ""}<button class="btn good" data-approve="${a.id}">✔ Fatto</button><button class="btn ghost" data-reject="${a.id}">Scarta</button>`
          : `<button class="btn good" data-approve="${a.id}">${p.publishAt ? "Approva" : "Pubblica"}</button><button class="btn ghost" data-reject="${a.id}">Scarta</button>`
        : `<span class="meta">${outcome}</span>`}
    </div>
  </article>`;
}

// ---------- pubblicazione a mano (social non collegati) ----------
// La condivisione dell'iPhone (navigator.share) parte solo dentro un tocco: i file si scaricano prima, appena la
// scheda compare (i video al primo tocco, poi si tocca di nuovo). Il testo si copia negli appunti nello stesso tocco.

const shareFiles = new Map(); // id dell'approvazione → { ready, files, promise }

function prepareFiles(a) {
  let entry = shareFiles.get(a.id);
  if (entry) return entry;
  const media = (a.post?.media ?? []).filter((m) => !m.missing);
  entry = { ready: false, files: [] };
  entry.promise = Promise.all(
    media.map(async (m, i) => {
      const r = await fetch(m.src);
      if (!r.ok) throw new Error(`file ${i + 1} non scaricato`);
      const blob = await r.blob();
      const ext = m.kind === "video" ? (m.mime === "video/quicktime" ? "mov" : "mp4") : "jpg";
      return new File([blob], `${a.post.network}-${i + 1}.${ext}`, { type: blob.type || m.mime });
    }),
  ).then(
    (files) => Object.assign(entry, { ready: true, files }),
    (err) => {
      shareFiles.delete(a.id);
      throw err;
    },
  );
  shareFiles.set(a.id, entry);
  return entry;
}

/** Collega i pulsanti «📲 Condividi» delle schede e prepara in anticipo le foto (non i video, che pesano). */
export function bindShareButtons(container, approvals) {
  for (const a of approvals) {
    const media = a.post?.media ?? [];
    if (a.kind === "post" && a.status === "pending" && a.post?.manual && media.length && media.every((m) => m.kind !== "video")) {
      prepareFiles(a).promise.catch(() => {});
    }
  }
  container.querySelectorAll("[data-share]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const a = approvals.find((x) => x.id === btn.dataset.share);
      if (a) sharePost(a, btn);
    }),
  );
  // Copertina del Reel: si salva nelle foto (condivisione → «Salva immagine»), poi su Instagram «Aggiungi dal rullino».
  container.querySelectorAll("[data-save-cover]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const a = approvals.find((x) => x.id === btn.dataset.saveCover);
      if (a) saveCover(a, btn);
    }),
  );
  // YouTube a mano: il titolo si copia con «Condividi», la descrizione con questo pulsante.
  container.querySelectorAll("[data-copy-desc]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const a = approvals.find((x) => x.id === btn.dataset.copyDesc);
      navigator.clipboard?.writeText(a?.post?.text ?? "").then(() => { btn.textContent = "✔ Descrizione copiata"; }, () => alert("Non riesco a copiare: tieni premuto sul testo e copialo a mano."));
    }),
  );
  // Post della pagina aziendale: testo negli appunti (dentro il tocco) e pagina di LinkedIn da amministratore.
  container.querySelectorAll("[data-open-page]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const a = approvals.find((x) => x.id === btn.dataset.openPage);
      if (!a?.post?.page) return;
      navigator.clipboard?.writeText(a.post.text ?? "").catch(() => {});
      window.open(`https://www.linkedin.com/company/${encodeURIComponent(a.post.page.id)}/admin/page-posts/published/`, "_blank", "noopener");
    }),
  );
}

const coverFiles = new Map(); // id dell'approvazione → File della copertina (scaricato al primo tocco)

async function saveCover(a, btn) {
  const src = coverOf(a.post ?? {});
  if (!src) return;
  const file = coverFiles.get(a.id);
  // La condivisione dell'iPhone parte solo dentro un tocco: al primo si scarica, al secondo si condivide.
  if (!file) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Preparo la copertina…";
    try {
      const r = await fetch(src);
      if (!r.ok) throw new Error(`errore ${r.status}`);
      const blob = await r.blob();
      coverFiles.set(a.id, new File([blob], "copertina-reel.jpg", { type: "image/jpeg" }));
      btn.textContent = "🖼️ Tocca di nuovo per salvarla";
    } catch (err) {
      btn.textContent = label;
      alert(`Non riesco a scaricare la copertina: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
    return;
  }
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      btn.textContent = "✔ Copertina pronta";
    } catch (err) {
      if (err.name !== "AbortError") alert(`Non riesco a salvarla: ${err.message}`);
    }
    return;
  }
  window.open(src, "_blank", "noopener"); // computer: si apre l'immagine e si salva con il tasto destro
}

async function sharePost(a, btn) {
  const p = a.post;
  const label = btn.textContent;
  // Prima di tutto (dentro il tocco) il testo negli appunti: su Instagram si incolla nella didascalia.
  navigator.clipboard?.writeText(p.network === "youtube" ? p.title ?? "" : p.text ?? "").catch(() => {});
  const entry = prepareFiles(a);
  if (!entry.ready) {
    btn.disabled = true;
    btn.textContent = "Preparo i file…";
    try {
      await entry.promise;
      btn.textContent = "📲 Tocca di nuovo per condividere";
    } catch (err) {
      btn.textContent = label;
      alert(`Non riesco a preparare i file: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
    return;
  }
  // Instagram ignora il testo condiviso (e con il testo a volte non compare tra le app): solo i file.
  const data = entry.files.length ? (p.network === "instagram" || p.page ? { files: entry.files } : { files: entry.files, text: p.text }) : { text: p.text };
  if (navigator.share && (!data.files || navigator.canShare?.(data))) {
    try {
      await navigator.share(data);
    } catch (err) {
      if (err.name !== "AbortError") alert(`Condivisione non riuscita: ${err.message}`);
    }
    return;
  }
  // Computer senza condivisione: testo copiato e file da salvare.
  for (const m of p.media ?? []) if (!m.missing) window.open(m.src, "_blank", "noopener");
  alert(`Testo copiato negli appunti.${(p.media ?? []).length ? " Le foto e i video si aprono in nuove schede: salvali" : ""} e pubblica dall'app o dal sito del social, poi torna qui e tocca «Fatto».`);
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
  if (!isEditing($("#social-stock"))) $("#social-stock").innerHTML = stockCard(status);
  if (!isEditing($("#social-voice"))) $("#social-voice").innerHTML = voiceCard(status);
  $("#media-usage").textContent = `${status.media.count} file · ${mb(status.media.bytes)}`;
  if (!isEditing($("#media-grid"))) {
    $("#media-grid").innerHTML = mediaList?.length
      ? mediaList.map(mediaCard).join("")
      : `<p class="empty">Ancora nessun file. Carica foto, video e musiche dal telefono: gli agenti li useranno per i post e per montare i video (scrivi due parole su cosa mostrano).</p>`;
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
    } else if (t.id === "voice-preview") {
      await playPreview(t);
    } else if (t.id === "eleven-remove") {
      if (!confirm("Togliere la tua voce di ElevenLabs? I video useranno la voce gratuita del server.")) return;
      status = await api("/api/social/voice/eleven", { method: "PUT", body: JSON.stringify({ key: "" }) });
      renderSocial();
    } else if (t.id === "voice-key-remove") {
      if (!confirm("Togliere la chiave di Google? I video useranno la voce gratuita del server.")) return;
      status = await api("/api/social/voice/key", { method: "PUT", body: JSON.stringify({ key: "" }) });
      renderSocial();
    } else if (t.dataset.stockRemove) {
      const name = t.dataset.stockRemove === "pixabay" ? "Pixabay" : "Pexels";
      if (!confirm(`Togliere la chiave di ${name}?`)) return;
      status = await api("/api/social/stock", { method: "PUT", body: JSON.stringify({ provider: t.dataset.stockRemove, key: "" }) });
      renderSocial();
    } else if (t.hasAttribute("data-page-remove")) {
      if (!confirm("Togliere la pagina aziendale? I post di LinkedIn usciranno solo sul tuo profilo.")) return;
      status = await api("/api/social/linkedin/settings", { method: "PUT", body: JSON.stringify({ pageId: "" }) });
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
    } else if (f.dataset.pageForm) {
      const had = status.networks.find((n) => n.id === "linkedin");
      const body = { pageId: f.pageId.value, pageName: f.pageName.value };
      if (f.pageOnly) body.pageOnly = f.pageOnly.value === "1";
      if (f.pageApi) body.pageApi = f.pageApi.checked;
      status = await api("/api/social/linkedin/settings", { method: "PUT", body: JSON.stringify(body) });
      document.activeElement?.blur();
      renderSocial();
      const li = status.networks.find((n) => n.id === "linkedin");
      if (li.pageApi && !had?.pageApi && li.account) alert("Ora premi 🔗 Ricollega su LinkedIn: ti chiederà anche il permesso di pubblicare sulla pagina.");
      else if (li.pageId && !had?.pageId) alert("✔ Pagina salvata: da ora ogni post di LinkedIn degli agenti arriva anche per la pagina.");
    } else if (f.id === "eleven-form") {
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Provo la voce…";
      try {
        const body = { voiceId: f.voiceId.value, model: f.model.value };
        if (f.key.value.trim()) body.key = f.key.value;
        status = await api("/api/social/voice/eleven", { method: "PUT", body: JSON.stringify(body) });
      } finally {
        btn.disabled = false;
        btn.textContent = "Salva";
      }
      document.activeElement?.blur();
      renderSocial();
    } else if (f.id === "voice-key-form") {
      if (!f.key.value.trim()) return;
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Chiedo le voci a Google…";
      try {
        status = await api("/api/social/voice/key", { method: "PUT", body: JSON.stringify({ key: f.key.value }) });
      } finally {
        btn.disabled = false;
        btn.textContent = "Salva";
      }
      document.activeElement?.blur();
      renderSocial();
      alert(`✔ Chiave salvata: ${status.voice.voices.length} voci italiane di Google. Scegline una nell'elenco e premi ▶️ Ascolta per sentirla.`);
    } else if (f.dataset.stockForm) {
      if (!f.key.value.trim()) return;
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Provo la chiave…";
      try {
        status = await api("/api/social/stock", { method: "PUT", body: JSON.stringify({ provider: f.dataset.stockForm, key: f.key.value }) });
      } finally {
        btn.disabled = false;
        btn.textContent = "Salva";
      }
      document.activeElement?.blur();
      renderSocial();
      const name = f.dataset.stockForm === "pixabay" ? "Pixabay" : "Pexels";
      alert(status.stockNote ? `Chiave salvata. ${status.stockNote}` : `✔ Chiave salvata e provata con ${name}: i video di repertorio sono attivi.`);
    } else if (f.id === "ai-form") {
      if (!f.key.value.trim()) return;
      const btn = f.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Provo la chiave…";
      try {
        status = await api("/api/social/ai", { method: "PUT", body: JSON.stringify({ key: f.key.value }) });
      } finally {
        btn.disabled = false;
        btn.textContent = "Salva";
      }
      document.activeElement?.blur();
      renderSocial();
      alert(status.aiNote ? `Chiave salvata. ${status.aiNote}` : "✔ Chiave salvata e provata con Google: le immagini con l'IA sono attive.");
    }
  }));
  view.addEventListener("change", act(async (e) => {
    const t = e.target;
    if (t.id === "voice-select") {
      status = await api("/api/social/voice", { method: "PUT", body: JSON.stringify({ name: t.value }) });
      renderSocial();
      return;
    }
    if (t.id === "voice-fallback") {
      status = await api("/api/social/voice/fallback", { method: "PUT", body: JSON.stringify({ name: t.value }) });
      renderSocial();
      return;
    }
    if (t.dataset.auto) {
      const on = t.value === "1";
      if (on && !confirm(`Pubblicazione AUTOMATICA su ${NET_LABEL[t.dataset.auto]}: gli agenti pubblicheranno a tuo nome senza chiederti niente (sempre entro il massimo di post al giorno). Vuoi attivarla?`)) {
        t.value = "0";
        return;
      }
      status = await api(`/api/social/${t.dataset.auto}/settings`, { method: "PUT", body: JSON.stringify({ auto: on }) });
      t.blur();
      renderSocial();
    } else if (t.dataset.replies) {
      const v = t.value;
      if (v === "1" && !confirm(`Risposte ai commenti AUTOMATICHE su ${NET_LABEL[t.dataset.replies]}: gli agenti risponderanno a tuo nome senza chiederti niente (al massimo 30 al giorno). Vuoi attivarle?`)) {
        renderSocial();
        return;
      }
      status = await api(`/api/social/${t.dataset.replies}/settings`, { method: "PUT", body: JSON.stringify({ autoReplies: v === "" ? null : v === "1" }) });
      t.blur();
      renderSocial();
    } else if (t.dataset.yt) {
      const f = t.dataset.yt;
      const value = ["privacy", "footer", "contactEmail"].includes(f) ? t.value : t.value === "1";
      if (f === "apiVerified" && value && !confirm("Scegli «Dall'app» solo se Google ti ha scritto che l'app è approvata (audit di YouTube): prima, i video caricati dall'app restano bloccati come privati. Continuare?")) {
        renderSocial();
        return;
      }
      status = await api("/api/social/youtube/settings", { method: "PUT", body: JSON.stringify({ [f]: value }) });
      t.blur();
      renderSocial();
    } else if (t.dataset.gap) {
      status = await api(`/api/social/${t.dataset.gap}/settings`, { method: "PUT", body: JSON.stringify({ minGapMinutes: t.value === "" ? null : Number(t.value) }) });
      t.blur();
      renderSocial();
    } else if (t.dataset.maxStories) {
      status = await api(`/api/social/${t.dataset.maxStories}/settings`, { method: "PUT", body: JSON.stringify({ maxStoriesPerDay: Number(t.value) }) });
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
        // Alcuni browser non danno il tipo delle musiche: si ricava dall'estensione.
        const byExt = { mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav" }[u.name.split(".").pop().toLowerCase()];
        xhr.setRequestHeader("Content-Type", u.file.type || byExt || "application/octet-stream");
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
