// Notizie RSS (read_feeds) e testo di pagine e PDF (read_page) contro un finto server (READER_API_BASE), con il blocco
// degli indirizzi interni.
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";

const DAY = 86_400_000;
const rfc = (ms) => new Date(Date.now() - ms).toUTCString();
const iso = (ms) => new Date(Date.now() - ms).toISOString();

/** PDF minimo con una riga di testo (offset della tabella xref calcolati). */
function tinyPdf(text) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 14 Tf 72 760 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const calls = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const [, host, ...rest] = u.pathname.split("/");
  const p = `/${rest.join("/")}`;
  calls.push({ host, path: p });
  const send = (status, type, body) => {
    res.writeHead(status, { "content-type": type });
    res.end(body);
  };
  if (host === "www.ansa.it" && p === "/sito/notizie/economia/economia_rss.xml") {
    return send(200, "application/rss+xml; charset=utf-8", `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>ANSA.it - Economia</title>
      <item><title><![CDATA[Nuovo bando Invitalia per le PMI: 50 milioni]]></title><link>https://www.ansa.it/a1.html</link><pubDate>${rfc(DAY)}</pubDate><description><![CDATA[<p>Domande dal 4 novembre &amp; fino al 30.</p>]]></description></item>
      <item><title>Borsa: Milano chiude in rialzo</title><link>https://www.ansa.it/a2.html</link><pubDate>${rfc(2 * 3600_000)}</pubDate><description>Ftse Mib +1%</description></item>
      <item><title>Vecchia notizia sul bando</title><link>https://www.ansa.it/a3.html</link><pubDate>${rfc(40 * DAY)}</pubDate><description>bando</description></item>
    </channel></rss>`);
  }
  if (host === "news.example.it" && p === "/atom.xml") {
    return send(200, "application/atom+xml", `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Esempio Atom</title>
      <entry><title>Credito d&#39;imposta 4.0: le novità</title><link rel="alternate" href="https://news.example.it/credito"/><updated>${iso(3600_000)}</updated><summary>Aliquote 2026</summary></entry>
    </feed>`);
  }
  if (host === "www.invitalia.it" && (p === "/" || p === "")) {
    return send(200, "text/html", `<html><head><link rel="alternate" type="application/rss+xml" href="/feed/notizie.xml"></head><body>Home</body></html>`);
  }
  if (host === "www.invitalia.it" && p === "/feed/notizie.xml") {
    return send(200, "text/xml; charset=ISO-8859-1", Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Invitalia</title><item><title>Resto al Sud: novità per chi è under 35</title><link>https://www.invitalia.it/n1</link><pubDate>${rfc(5 * 3600_000)}</pubDate><description>Più fondi.</description></item></channel></rss>`, "latin1"));
  }
  if (host === "www.mimit.gov.it" && (p === "/" || p === "")) return send(200, "text/html", "<html><body>Niente feed</body></html>");
  if (host === "bandi.example.it" && p === "/smart-start") {
    return send(200, "text/html; charset=windows-1252", Buffer.from(`<!doctype html><html><head><title>Smart&amp;Start Italia | Invitalia</title>
      <meta property="article:published_time" content="2026-10-20T09:00:00Z"><meta name="description" content="Finanziamenti a tasso zero">
      <script>var tracking = "NON DEVE COMPARIRE";</script><style>.x{}</style></head><body>
      <header><nav><a href="/">Home</a> Menu principale</nav></header>
      <article><h1>Smart&amp;Start Italia</h1><p>Il bando finanzia fino all&#39;80% delle spese, con un massimo di 1,5 milioni di euro. Lo sportello è aperto: si presenta la domanda con SPID o CIE e la valutazione dura circa sessanta giorni.</p>
      <ul><li>Startup innovative</li><li>Spese tra 100.000 e 1,5 milioni</li></ul>
      <p>Scadenza: 30 novembre 2026. ${"Testo lungo. ".repeat(60)}</p>
      <a href="/docs/bando.pdf">Scarica il bando</a> <a href="https://bandi.example.it/faq">FAQ</a> <a href="/chi-siamo">Chi siamo</a></article>
      <footer>Cookie e privacy FOOTER</footer></body></html>`, "latin1"));
  }
  if (host === "bandi.example.it" && p === "/docs/bando.pdf") return send(200, "application/pdf", tinyPdf("Scadenza delle domande 30 novembre 2026"));
  if (host === "bandi.example.it" && p === "/vai") {
    res.writeHead(302, { location: "http://127.0.0.1:3000/api/stats" });
    return res.end();
  }
  if (host === "bandi.example.it" && p === "/sposta") {
    res.writeHead(301, { location: "/smart-start" });
    return res.end();
  }
  send(404, "text/plain", "non trovato");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => new Promise((r) => server.close(r)));

Object.assign(process.env, {
  AGENTI_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "reader-test-")),
  MARKET_MODE: "demo",
  READER_API_BASE: `http://127.0.0.1:${server.address().port}`,
});
const { readFeeds, readPage, _resetReader, FEED_PRESETS, htmlToText } = await import("../lib/reader.js");
const { runTool, TOOL_DEFS } = await import("../lib/tools.js");
const { ALL_TOOLS } = await import("../lib/config.js");

beforeEach(() => _resetReader());

test("read_feeds: fonti pronte, Atom, feed trovato dalla home, filtro per parole e giorni, più recenti prima", async () => {
  const r = await readFeeds({ feeds: ["ansa-economia", "https://news.example.it/atom.xml", "invitalia"], days: 7 });
  assert.deepEqual(r.notizie.map((n) => n.titolo), [
    "Credito d'imposta 4.0: le novità",
    "Borsa: Milano chiude in rialzo",
    "Resto al Sud: novità per chi è under 35",
    "Nuovo bando Invitalia per le PMI: 50 milioni",
  ], "ordine per data; la notizia di 40 giorni fa resta fuori; ISO-8859-1 letto bene");
  const bando = r.notizie.at(-1);
  assert.equal(bando.fonte, "ANSA.it - Economia");
  assert.equal(bando.link, "https://www.ansa.it/a1.html");
  assert.equal(bando.sommario, "Domande dal 4 novembre & fino al 30.");
  assert.equal(r.notizie[0].link, "https://news.example.it/credito");
  assert.ok(calls.some((c) => c.host === "www.invitalia.it" && c.path === "/feed/notizie.xml"), "feed cercato nella home");

  const f = await readFeeds({ feeds: "ansa-economia, mimit", query: "bando", days: 60 });
  assert.deepEqual(f.notizie.map((n) => n.link), ["https://www.ansa.it/a1.html", "https://www.ansa.it/a3.html"]);
  assert.match(f.errori.mimit, /nessun feed RSS trovato/);
  await assert.rejects(readFeeds({}), /feeds: nomi delle fonti pronte/);
  await assert.rejects(readFeeds({ feeds: Array(9).fill("ansa-economia").map((x, i) => `${x}${i}`) }), /al massimo 8/);
  assert.ok(FEED_PRESETS["gazzetta-ufficiale"]);
});

test("read_page: testo pulito dell'articolo (senza menu, script e piè di pagina), data, link ai documenti, a pezzi", async () => {
  const r = await readPage({ url: "https://bandi.example.it/smart-start", max_chars: 1000 });
  assert.equal(r.tipo, "pagina");
  assert.equal(r.titolo, "Smart&Start Italia | Invitalia");
  assert.equal(r.pubblicato, "2026-10-20T09:00:00Z");
  assert.equal(r.descrizione, "Finanziamenti a tasso zero");
  assert.match(r.testo, /fino all'80% delle spese/);
  assert.match(r.testo, /- Startup innovative/);
  assert.match(r.testo, /lo sportello è aperto|Lo sportello è aperto/, "windows-1252 letto bene");
  assert.doesNotMatch(r.testo, /NON DEVE COMPARIRE|Menu principale|FOOTER/);
  assert.equal(r.testo.length, 1000);
  assert.equal(r.continua_da, 1000);
  assert.deepEqual(r.collegamenti.map((l) => l.url), ["https://bandi.example.it/docs/bando.pdf", "https://bandi.example.it/faq"]);
  const next = await readPage({ url: "https://bandi.example.it/smart-start", max_chars: 1000, from: r.continua_da });
  const full = await readPage({ url: "https://bandi.example.it/smart-start", max_chars: 20000 });
  assert.equal(next.testo, full.testo.slice(1000, 2000), "il pezzo dopo riparte dove finiva il primo");
  assert.equal(full.continua_da, undefined);
  const moved = await readPage({ url: "https://bandi.example.it/sposta" });
  assert.equal(moved.url, "https://bandi.example.it/smart-start", "redirect seguito");
});

test("read_page: PDF letto con pdftotext (o avviso chiaro se manca)", async () => {
  let has = true;
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
  } catch (err) {
    has = err.code !== "ENOENT";
  }
  if (has) {
    const r = await readPage({ url: "https://bandi.example.it/docs/bando.pdf" });
    assert.equal(r.tipo, "pdf");
    assert.match(r.testo, /Scadenza delle domande 30 novembre 2026/);
  } else {
    await assert.rejects(readPage({ url: "https://bandi.example.it/docs/bando.pdf" }), /manca il programma per leggerlo/);
  }
});

test("indirizzi interni bloccati, anche dopo un redirect; solo http e https", async () => {
  for (const url of ["http://localhost:3000/api/stats", "http://127.0.0.1:3000/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://10.0.0.5/", "http://192.168.1.1/", "http://intranet/", "http://server.internal/"]) {
    await assert.rejects(readPage({ url }), /indirizzi interni non permessi/, url);
  }
  await assert.rejects(readPage({ url: "file:///etc/passwd" }), /solo indirizzi http o https/);
  await assert.rejects(readPage({ url: "https://utente:pw@bandi.example.it/" }), /nome utente o password/);
  await assert.rejects(readPage({ url: "https://bandi.example.it/vai" }), /indirizzi interni non permessi/);
  assert.ok(!calls.some((c) => c.path.includes("api/stats")), "il redirect verso il server interno non parte");
  await assert.rejects(readPage({ url: "non è un indirizzo" }), /url: indirizzo non valido/);
  await assert.rejects(readPage({ url: "https://bandi.example.it/manca" }), /HTTP 404/);
});

test("strumenti per gli agenti e per Orion; HTML in testo", async () => {
  assert.ok(ALL_TOOLS.includes("read_feeds") && ALL_TOOLS.includes("read_page"));
  assert.match(TOOL_DEFS.read_feeds.description, /gazzetta-ufficiale/);
  const agent = { id: "bandi", name: "Cacciatore di bandi", tools: ["read_feeds", "read_page"] };
  const r = await runTool(agent, "read_feeds", { feeds: ["ansa-economia"], query: "borsa" });
  assert.equal(r.notizie.length, 1);
  const p = await runTool(agent, "read_page", { url: "https://bandi.example.it/smart-start" });
  assert.match(p.testo, /Smart&Start Italia/);
  assert.equal(htmlToText("<p>Uno<br>due</p><ul><li>a</li></ul><table><tr><td>x</td><td>y</td></tr></table>"), "Uno\ndue\n\n- a\n\nx | y |");
});
