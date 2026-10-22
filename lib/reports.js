// Report settimanali in PDF: un agente (es. il «Reporter» di un palazzo, la domenica) scrive il report con lo strumento
// weekly_report passando solo i contenuti (sintesi, numeri, sezioni, tabelle, piano della settimana dopo); qui si
// impagina con i colori di Venturo, si stampa in PDF con Chrome senza finestra (lo stesso di HyperFrames), si salva in
// <dati>/reports/ e si manda per email all'utente (lib/mailer.js). Senza Chrome il report resta una pagina HTML.
// I report non entrano nei backup (come i file dell'archivio): l'elenco si vede in 📄 Report.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./paths.js";
import { writeFileAtomic, readJsonSafe } from "./files.js";
import { bus } from "./store.js";
import { romeParts } from "./schedule.js";
import { sendMail, mailStatus } from "./mailer.js";
import { PUBLIC_URL } from "./env.js";
import { findBrowser } from "./browser.js";

export { findBrowser };

const DIR = path.join(DATA_DIR, "reports");
const INDEX = path.join(DIR, "index.json");
const MAX_REPORTS = 200;
const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");
export const INCLUDES = ["spesa", "operazioni"];
const ID = /^r-[a-z0-9-]{4,90}$/;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const list = (x, n) => (Array.isArray(x) ? x : x ? [x] : []).slice(0, n);

function readIndex() {
  const { data } = readJsonSafe(INDEX);
  return Array.isArray(data) ? data.filter((r) => r && typeof r === "object" && ID.test(r.id ?? "")) : [];
}
function writeIndex(items) {
  const keep = items.slice(0, MAX_REPORTS);
  for (const old of items.slice(MAX_REPORTS)) fs.rmSync(path.join(DIR, old.file ?? ""), { force: true });
  writeFileAtomic(INDEX, JSON.stringify(keep, null, 2));
}

export function listReports() {
  return readIndex();
}

/** File di un report per scaricarlo: { file, type, filename } oppure null. */
export function reportFile(id) {
  if (!ID.test(String(id))) return null;
  const r = readIndex().find((x) => x.id === id);
  if (!r) return null;
  const file = path.join(DIR, path.basename(r.file));
  if (!fs.existsSync(file)) return null;
  return { file, type: r.type, filename: downloadName(r) };
}

const downloadName = (r) => `${String(r.title).replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-").slice(0, 70) || "report"}-${r.at.slice(0, 10)}.${r.type}`;

/** Testo semplice → HTML: righe vuote = paragrafi, righe con «- » = elenco, **grassetto**. Tutto il resto escapato. */
function rich(text) {
  const blocks = String(text ?? "").replace(/\r/g, "").split(/\n{2,}/);
  return blocks
    .map((b) => {
      const lines = b.split("\n").filter((l) => l.trim());
      if (!lines.length) return "";
      const inline = (l) => esc(l).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      if (lines.every((l) => /^\s*[-•*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-•*]\s+/, ""))}</li>`).join("")}</ul>`;
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}

const cell = (v) => (typeof v === "number" ? v.toLocaleString("it-IT", { maximumFractionDigits: 2 }) : clip(v, 300));

function table(t) {
  const cols = list(t?.columns, 8).map((c) => clip(c, 60));
  const rows = list(t?.rows, 60).map((r) => list(r, cols.length || 8));
  if (!rows.length) return "";
  const num = (v) => typeof v === "number" || /^[+-−]?[\d.,]+\s*(%|€|\$)?$/.test(String(v ?? "").trim());
  const numCol = cols.map((_, i) => rows.every((r) => r[i] == null || r[i] === "" || num(r[i])));
  return `<table>${cols.length ? `<thead><tr>${cols.map((c, i) => `<th class="${numCol[i] ? "n" : ""}">${esc(c)}</th>`).join("")}</tr></thead>` : ""}<tbody>${rows
    .map((r) => `<tr>${r.map((v) => `<td class="${num(v) ? "n" : ""}">${esc(cell(v))}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function fontFaces() {
  const face = (file, range) => {
    try {
      return `@font-face{font-family:Sora;font-weight:300 800;src:url(data:font/woff2;base64,${fs.readFileSync(path.join(FONTS, file)).toString("base64")}) format("woff2");unicode-range:${range}}`;
    } catch {
      return "";
    }
  };
  return face("Sora-latin.woff2", "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215") +
    face("Sora-latin-ext.woff2", "U+0100-02AF,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF");
}

const LOGO = `<svg viewBox="0 0 200 200" width="34" height="34"><rect width="200" height="200" rx="44" fill="#0A1F44"/><path d="M48 78 L96 148 L144 64" fill="none" stroke="#fff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/><circle cx="160" cy="40" r="16" fill="#2BD67B"/></svg>`;

/** Pagina HTML del report (anche il contenuto dell'email, accorciato). */
export function reportHtml(r) {
  const kpis = list(r.kpis, 8);
  const auto = r.auto ?? {};
  const section = (s) => `<section><h2>${esc(clip(s.title, 120))}</h2>${s.text ? rich(clip(s.text, 6000)) : ""}${list(s.bullets, 25).length ? `<ul>${list(s.bullets, 25).map((b) => `<li>${esc(clip(b, 500))}</li>`).join("")}</ul>` : ""}${s.table ? table(s.table) : ""}</section>`;
  const bullets = (title, items, cls) => (items.length ? `<section class="${cls}"><h2>${esc(title)}</h2><ol>${items.map((x) => `<li>${esc(clip(x, 600))}</li>`).join("")}</ol></section>` : "");
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${esc(r.title)}</title><style>
${fontFaces()}
@page{size:A4;margin:16mm 14mm 18mm}
*{box-sizing:border-box}body{font:10.5pt/1.5 Sora,"Liberation Sans",Arial,sans-serif;color:#0B1220;margin:0}
header{display:flex;align-items:center;gap:12px;border-bottom:3px solid #0A1F44;padding-bottom:10px;margin-bottom:14px}
header .t{flex:1}h1{font-size:19pt;line-height:1.2;color:#0A1F44;margin:0;font-weight:800}.meta{color:#5B6575;font-size:9pt;margin-top:3px}
h2{font-size:12.5pt;color:#0A1F44;margin:18px 0 6px;font-weight:700;break-after:avoid}
p{margin:0 0 7px}ul,ol{margin:0 0 8px;padding-left:20px}li{margin:2px 0}
.summary{background:#F7F9FC;border-left:4px solid #2F5BFF;border-radius:6px;padding:10px 14px;margin-bottom:12px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0 4px}
.kpi{border:1px solid #DCE3EE;border-radius:8px;padding:8px 10px;break-inside:avoid}.kpi .v{font-size:15pt;font-weight:800;color:#0A1F44;line-height:1.2}
.kpi .l{font-size:8.5pt;color:#5B6575}.kpi .c{font-size:8.5pt;font-weight:700}.up{color:#0B7A45}.down{color:#B42318}
table{width:100%;border-collapse:collapse;margin:6px 0 10px;font-size:9pt;break-inside:auto}tr{break-inside:avoid}
th{background:#0A1F44;color:#fff;text-align:left;padding:5px 7px;font-weight:600}td{padding:4px 7px;border-bottom:1px solid #E3E8F0;vertical-align:top}
td.n,th.n{text-align:right;white-space:nowrap}tbody tr:nth-child(even) td{background:#F7F9FC}
.next{background:#EAF8F0;border-radius:8px;padding:4px 14px 8px;break-inside:avoid}.next h2{color:#0B7A45}
.user{background:#FFF6E5;border-radius:8px;padding:4px 14px 8px;break-inside:avoid}.user h2{color:#8A5300}
.auto{border-top:1px dashed #C8D0DC;margin-top:16px}.auto h2{font-size:11pt}.note{color:#5B6575;font-size:8.5pt}
</style></head><body>
<header>${LOGO}<div class="t"><h1>${esc(r.title)}</h1><div class="meta">${esc(r.period)} · ${esc(r.palaceName ?? "Tutti i palazzi")} · scritto da ${esc(r.agentName)} il ${esc(r.atLabel)}</div></div></header>
${r.summary ? `<div class="summary">${rich(r.summary)}</div>` : ""}
${kpis.length ? `<div class="kpis">${kpis.map((k) => {
    const ch = clip(k.change, 30);
    const dir = /^[+↑]/.test(ch) ? "up" : /^[-−↓]/.test(ch) ? "down" : "";
    return `<div class="kpi"><div class="l">${esc(clip(k.label, 60))}</div><div class="v">${esc(clip(k.value, 30))}</div>${ch ? `<div class="c ${dir}">${esc(ch)}</div>` : ""}${k.note ? `<div class="l">${esc(clip(k.note, 80))}</div>` : ""}</div>`;
  }).join("")}</div>` : ""}
${list(r.sections, 14).map(section).join("")}
${bullets("Cosa faremo la prossima settimana", list(r.next_week, 20), "next")}
${bullets("Cosa serve da te", list(r.for_user, 10), "user")}
${auto.operazioni ? `<section class="auto"><h2>Operazioni chiuse della settimana (dati del conto)</h2>${auto.operazioni}</section>` : ""}
${auto.spesa ? `<section class="auto"><h2>Spesa della piattaforma (dati della piattaforma)</h2>${auto.spesa}</section>` : ""}
<p class="note" style="margin-top:18px">Report scritto da un agente IA della piattaforma: controlla i numeri importanti prima di decidere. Non è consulenza finanziaria né fiscale.</p>
</body></html>`;
}

/** Tabelle con i dati veri della piattaforma, aggiunte dal codice (non dall'agente): spesa e operazioni chiuse. */
export function spesaHtml(s) {
  if (!s) return "";
  const usd = (x) => `${(Number(x) || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
  const days = table({ columns: ["Giorno", "Spesa"], rows: (s.giorni ?? []).map((d) => [d.giorno, usd(d.spesa)]) });
  const agents = table({ columns: ["Agente", "Modello", "Spesa", "Lavori"], rows: (s.agenti ?? []).slice(0, 12).map((a) => [a.nome, a.modello, usd(a.spesa_periodo), a.lavori_periodo]) });
  return `<p><b>Totale ultimi 7 giorni: ${usd(s.totale)}</b> · mese in corso ${usd(s.mese_in_corso?.spesa)}${s.mese_in_corso?.budget_mese ? ` su ${s.mese_in_corso.budget_mese} $ di budget` : ""} · stima a fine mese ${usd(s.mese_in_corso?.stima_fine_mese)}</p>${days}${agents}`;
}

export function operazioniHtml(j) {
  const c = j?.conto_ctrader;
  if (!c || typeof c !== "object") return `<p>Conto cTrader non collegato: nessuna operazione da mostrare.</p>`;
  const t = c.riepilogo ?? {};
  const num = (x) => (x == null ? "—" : Number(x).toLocaleString("it-IT", { maximumFractionDigits: 2 }));
  const head = `<p><b>Netto: ${num(t.net)} ${esc((t.currencies ?? []).join("/"))}</b> · operazioni ${num(t.count)} · vinte ${num(t.wins)} · perse ${num(t.losses)}${t.winRate != null ? ` · ${num(t.winRate)}% vinte` : ""}</p>`;
  const rows = (c.operazioni ?? []).slice(0, 40).map((o) => [String(o.chiusa ?? "").slice(0, 16).replace("T", " "), o.simbolo, o.lato, o.agente, o.durata_ore ?? "—", o.netto]);
  return head + (rows.length ? table({ columns: ["Chiusa", "Simbolo", "Lato", "Agente", "Ore", "Netto"], rows }) : "<p>Nessuna operazione chiusa negli ultimi 7 giorni.</p>");
}

// ——— PDF con Chrome senza finestra ———

let pdfChain = Promise.resolve();

/** HTML → PDF (Buffer), uno per volta; null se Chrome o puppeteer non ci sono. REPORT_PDF=fake nei test. */
export function renderPdf(html) {
  const job = pdfChain.then(() => renderPdfNow(html));
  pdfChain = job.catch(() => {});
  return job;
}

async function renderPdfNow(html) {
  if (process.env.REPORT_PDF === "fake") return Buffer.from(`%PDF-1.4\n% finto PDF dei test: ${html.length} caratteri\n%%EOF\n`);
  if (process.env.REPORT_PDF === "off") return null;
  const exe = findBrowser();
  if (!exe) return null;
  const mod = await import("puppeteer-core").catch(() => null);
  const puppeteer = mod?.default ?? mod;
  if (!puppeteer?.launch) return null;
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--font-render-hinting=none", "--no-first-run"],
  });
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    // Solo il contenuto del report: niente richieste verso fuori (immagini o font esterni).
    await page.setRequestInterception(true);
    page.on("request", (req) => (/^(data|about):/.test(req.url()) ? req.continue() : req.abort()));
    await page.setContent(html, { waitUntil: "load", timeout: 60_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="font-size:8px;color:#5B6575;width:100%;padding:0 14mm;display:flex;justify-content:space-between;font-family:Arial,sans-serif"><span>Venturo Agenti · report settimanale</span><span>pagina <span class="pageNumber"></span> di <span class="totalPages"></span></span></div>`,
      timeout: 60_000,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ——— Creazione, archivio, email ———

const lastWeek = (at = new Date()) => {
  const fmt = (d) => romeParts(d).date.split("-").reverse().join("/");
  return `Settimana dal ${fmt(new Date(at.getTime() - 6 * 86_400_000))} al ${fmt(at)}`;
};

/**
 * Crea un report. input = parametri di weekly_report; ctx = { palace: {id,name}|null, auto: { spesa, operazioni } (HTML già pronto) }.
 * Restituisce la voce dell'elenco (con lo stato dell'email).
 */
export async function createReport(agent, input = {}, ctx = {}) {
  const title = clip(input.title, 120);
  if (!title) throw new Error("serve title (es. «Report settimanale – Palazzo Social»)");
  const sections = list(input.sections, 14).filter((s) => s && typeof s === "object" && clip(s.title, 120));
  if (!clip(input.summary, 10) && !sections.length) throw new Error("scrivi almeno summary e qualche sezione (sections)");
  const recent = readIndex().find((r) => r.agentId === agent.id && Date.now() - Date.parse(r.at) < 6 * 3600_000);
  if (recent && !input.replace) {
    throw new Error(`hai già fatto un report alle ${romeParts(new Date(recent.at)).time} («${recent.title}»): uno per volta. Se devi correggerlo rifallo con replace: true.`);
  }
  const at = new Date();
  const r = {
    title,
    period: clip(input.period, 80) || lastWeek(at),
    summary: clip(input.summary, 3000),
    kpis: list(input.kpis, 8).filter((k) => k && typeof k === "object"),
    sections,
    next_week: list(input.next_week, 20).map((x) => clip(x, 600)).filter(Boolean),
    for_user: list(input.for_user, 10).map((x) => clip(x, 600)).filter(Boolean),
    palaceName: ctx.palace?.name ?? null,
    agentName: agent.name,
    atLabel: romeParts(at).label,
    auto: ctx.auto ?? {},
  };
  const html = reportHtml(r);
  const pdf = await renderPdf(html).catch((err) => {
    console.error(`[report] PDF non riuscito: ${err.message}`);
    return null;
  });
  const id = `r-${romeParts(at).date.replaceAll("-", "")}-${String(agent.id).replace(/[^a-z0-9-]/g, "-").slice(0, 40)}-${crypto.randomBytes(3).toString("hex")}`;
  const type = pdf ? "pdf" : "html";
  const file = `${id}.${type}`;
  fs.mkdirSync(DIR, { recursive: true });
  writeFileAtomic(path.join(DIR, file), pdf ?? html);
  const entry = {
    id,
    at: at.toISOString(),
    title,
    period: r.period,
    summary: r.summary.replace(/\*\*/g, "").slice(0, 600),
    palace: ctx.palace?.id ?? null,
    palaceName: r.palaceName,
    agentId: agent.id,
    agentName: agent.name,
    file,
    type,
    bytes: (pdf ?? Buffer.from(html)).length,
    email: { status: "off" },
  };
  let items = readIndex();
  if (recent && input.replace) {
    fs.rmSync(path.join(DIR, path.basename(recent.file)), { force: true });
    items = items.filter((x) => x.id !== recent.id);
  }
  writeIndex([entry, ...items]);
  if (input.email !== false) entry.email = await mailOne(entry, r);
  bus.emit("event", { type: "report-pdf", report: entry });
  return entry;
}

function emailBody(entry, r) {
  const link = PUBLIC_URL ? `<p><a href="${esc(PUBLIC_URL)}/#reports">Apri i report nell'app</a></p>` : "";
  const kpis = (r?.kpis ?? []).map((k) => `<li><b>${esc(clip(k.label, 60))}:</b> ${esc(clip(k.value, 30))}${k.change ? ` (${esc(clip(k.change, 30))})` : ""}</li>`).join("");
  const next = (r?.next_week ?? []).slice(0, 6).map((x) => `<li>${esc(x)}</li>`).join("");
  return `<div style="font-family:Arial,sans-serif;color:#0B1220;max-width:640px">
<h2 style="color:#0A1F44;margin:0 0 4px">${esc(entry.title)}</h2><p style="color:#5B6575;margin:0 0 12px">${esc(entry.period)} · ${esc(entry.palaceName ?? "Tutti i palazzi")} · ${esc(entry.agentName)}</p>
${r?.summary ? rich(r.summary) : `<p>${esc(entry.summary)}</p>`}${kpis ? `<ul>${kpis}</ul>` : ""}${next ? `<p><b>La prossima settimana</b></p><ol>${next}</ol>` : ""}
<p>Il report completo è ${entry.type === "pdf" ? "nel PDF allegato" : "nella pagina allegata (il server non ha potuto creare il PDF)"}.</p>${link}
<p style="color:#5B6575;font-size:12px">Venturo Agenti · email automatica dei report</p></div>`;
}

async function mailOne(entry, r = null) {
  if (!mailStatus().configured) return { status: "off", note: "email non impostata in 📄 Report" };
  try {
    const content = fs.readFileSync(path.join(DIR, path.basename(entry.file)));
    const sent = await sendMail({
      subject: `📊 ${entry.title} · ${entry.period}`,
      html: emailBody(entry, r),
      text: `${entry.title}\n${entry.period}\n\n${entry.summary}\n\nIl report completo è in allegato.`,
      attachments: [{ filename: downloadName(entry), content }],
    });
    return setEmail(entry.id, { status: "sent", at: new Date().toISOString(), id: sent.id ?? null, to: mailStatus().to });
  } catch (err) {
    return setEmail(entry.id, { status: "failed", at: new Date().toISOString(), error: err.message.slice(0, 300) });
  }
}

function setEmail(id, email) {
  const items = readIndex();
  const it = items.find((x) => x.id === id);
  if (it) {
    it.email = email;
    writeIndex(items);
  }
  return email;
}

/** Rimanda per email un report già fatto (pulsante in 📄 Report). */
export async function mailReport(id) {
  const entry = readIndex().find((x) => x.id === id);
  if (!entry) throw new Error("report non trovato");
  if (!mailStatus().configured) throw new Error("Prima imposta la chiave di Resend e la tua email qui sotto.");
  const email = await mailOne(entry);
  if (email.status !== "sent") throw new Error(email.error ?? "email non partita");
  return { ...entry, email };
}

export function deleteReport(id) {
  const items = readIndex();
  const it = items.find((x) => x.id === id);
  if (!it) throw new Error("report non trovato");
  fs.rmSync(path.join(DIR, path.basename(it.file)), { force: true });
  writeIndex(items.filter((x) => x.id !== id));
  return { deleted: id };
}
