// Pagine pubbliche «Norme sulla privacy» (/privacy) e «Termini di servizio» (/termini) dell'app, senza accesso: le
// chiede Google per verificare l'app di YouTube (modulo «YouTube API Services – Audit»). Le Norme per gli sviluppatori di
// YouTube vogliono che si dica che l'app usa i servizi API di YouTube, con i link alle norme di Google e di YouTube e a
// come revocare l'accesso. L'email di contatto la mette l'utente in 📣 Social → YouTube.
import { contactEmail } from "./social/index.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const UPDATED = "20 ottobre 2026";

function page(title, body) {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Venturo Agenti</title><meta name="robots" content="noindex">
<style>body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#F7F9FC;color:#0B1220;margin:0;padding:24px 16px}
main{max-width:760px;margin:0 auto;background:#fff;border:1px solid #DCE3EE;border-radius:14px;padding:24px}h1{color:#0A1F44;margin-top:0}
h2{color:#0A1F44;font-size:19px;margin-top:28px}a{color:#2F5BFF}.muted{color:#4A5568;font-size:14px}hr{border:0;border-top:1px solid #DCE3EE;margin:32px 0}</style>
</head><body><main>${body}</main></body></html>`;
}

const contactLine = () => {
  const email = contactEmail();
  return email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : "il canale YouTube «Venturo» (scheda Informazioni)";
};

export function privacyPage() {
  const c = contactLine();
  return page("Norme sulla privacy", `
<h1>Norme sulla privacy di «Venturo Agenti»</h1>
<p class="muted">Ultimo aggiornamento: ${UPDATED}</p>
<p>«Venturo Agenti» è un'applicazione privata usata solo dal titolare del progetto Venturo per gestire i propri canali social,
compreso il proprio canale YouTube. Non è aperta al pubblico e non ha altri utenti.</p>
<h2>Uso dei servizi API di YouTube</h2>
<p>L'applicazione usa i <b>servizi API di YouTube</b>. Chi la usa accetta i
<a href="https://www.youtube.com/t/terms">Termini di servizio di YouTube</a>. Le informazioni ottenute tramite Google e YouTube
sono trattate anche secondo le <a href="https://policies.google.com/privacy">Norme sulla privacy di Google</a>.</p>
<h2>Quali dati usa l'applicazione</h2>
<ul>
<li>Il nome, l'identificativo e le statistiche pubbliche del canale YouTube del titolare (iscritti, visualizzazioni, video).</li>
<li>I video, i titoli e le descrizioni che il titolare carica sul proprio canale.</li>
<li>I commenti pubblici sotto i video del canale (autore come mostrato da YouTube, testo, data), per leggerli e rispondere.</li>
<li>Il codice di accesso rilasciato da Google per il canale del titolare.</li>
</ul>
<h2>Come li usa e dove li conserva</h2>
<p>I dati servono solo a pubblicare i video del titolare, leggere le statistiche del suo canale e rispondere ai commenti.
Sono conservati sul server privato dell'applicazione (Railway, Unione Europea), protetto da password. Il codice di accesso
di Google è salvato in un file leggibile solo dal programma. I testi dei commenti possono essere letti dal servizio di
intelligenza artificiale che aiuta a scrivere le risposte. I dati non vengono venduti né ceduti a terzi per pubblicità.</p>
<h2>Cookie</h2>
<p>L'applicazione usa un solo cookie tecnico per mantenere l'accesso del titolare. Non usa cookie di profilazione e non
salva cookie sui dispositivi degli utenti di YouTube.</p>
<h2>Per quanto tempo</h2>
<p>Statistiche e commenti letti restano al massimo 30 giorni nell'elenco dei commenti già visti; lo storico dei post al
massimo 300 elementi. Il codice di accesso si cancella scollegando YouTube dall'applicazione.</p>
<h2>Come revocare l'accesso</h2>
<p>Il titolare può scollegare YouTube in qualsiasi momento dall'applicazione oppure revocare l'accesso dalla pagina delle
impostazioni di sicurezza di Google: <a href="https://security.google.com/settings/security/permissions">security.google.com/settings/security/permissions</a>.
Dopo la revoca i dati del canale non vengono più letti; quelli conservati si cancellano entro 30 giorni o su richiesta.</p>
<h2>Contatti</h2>
<p>Per domande o richieste sui dati: ${c}.</p>
<hr>
<h1>Privacy Policy (English summary)</h1>
<p>«Venturo Agenti» is a private application used only by the owner of the Venturo project to manage his own social channels,
including his own YouTube channel. It <b>uses YouTube API Services</b>; by using it you agree to the
<a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>, and data is also handled under the
<a href="https://policies.google.com/privacy">Google Privacy Policy</a>. The app accesses the owner's channel name, ID and public
statistics, the videos, titles and descriptions he uploads, and public comments on his videos, only to publish videos, read
statistics and reply to comments. Data is stored on the app's private, password-protected server (Railway, EU), is never sold
or shared for advertising, and comment text may be processed by the AI service that drafts replies. The app sets one
technical cookie for the owner's login only. Access can be revoked at any time by disconnecting YouTube in the app or at
<a href="https://security.google.com/settings/security/permissions">security.google.com/settings/security/permissions</a>;
stored data is deleted within 30 days or on request. Contact: ${c}.</p>`);
}

export function termsPage() {
  const c = contactLine();
  return page("Termini di servizio", `
<h1>Termini di servizio di «Venturo Agenti»</h1>
<p class="muted">Ultimo aggiornamento: ${UPDATED}</p>
<p>«Venturo Agenti» è un'applicazione privata, usata solo dal titolare del progetto Venturo per i propri canali social. Non
offre servizi a terzi.</p>
<p>L'applicazione usa i servizi API di YouTube: chi la usa accetta i <a href="https://www.youtube.com/t/terms">Termini di servizio
di YouTube</a> e le <a href="https://policies.google.com/privacy">Norme sulla privacy di Google</a>. Il trattamento dei dati è
descritto nelle <a href="/privacy">Norme sulla privacy</a>.</p>
<p>Contatti: ${c}.</p>
<hr>
<h1>Terms of Service (English)</h1>
<p>«Venturo Agenti» is a private application used only by the owner of the Venturo project for his own social channels; it offers
no service to third parties. It uses YouTube API Services: by using it you agree to the
<a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a> and the <a href="https://policies.google.com/privacy">Google
Privacy Policy</a>. See also our <a href="/privacy">Privacy Policy</a>. Contact: ${c}.</p>`);
}
