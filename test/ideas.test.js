// 💡 Idee per i contenuti (lib/ideas.js): idee con il perché, foto, video (fotogrammi e parlato), documenti, strumenti
// degli agenti ideas e idea_used.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import AdmZip from "adm-zip";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ideas-test-"));
Object.assign(process.env, { AGENTI_DATA_DIR: DATA, MARKET_MODE: "demo" });
const ideas = await import("../lib/ideas.js");
const { runTool, enabledTools } = await import("../lib/tools.js");
const sharp = (await import("sharp")).default;

const tmpFile = (name, buf) => {
  const f = path.join(DATA, `.t-${Date.now()}-${name}`);
  fs.writeFileSync(f, buf);
  return f;
};
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function tinyPdf(text) {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
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

test("un'idea vuole sempre il perché e un tipo valido; i social si puliscono", () => {
  assert.throws(() => ideas.addIdea({ text: "bandi", motive: "argomenti", reason: "" }), /perché/);
  assert.throws(() => ideas.addIdea({ text: "x", motive: "boh", reason: "perché sì" }), /tipo di idea/);
  const i = ideas.addIdea({ text: "Bandi per donne imprenditrici", motive: "argomenti", reason: "Sono i temi delle prossime due settimane", networks: ["instagram", "tiktok", "INSTAGRAM", "linkedin"] });
  assert.deepEqual(i.networks, ["instagram", "linkedin"]);
  assert.equal(i.status, "nuova");
  assert.equal(ideas.listIdeas({ status: "da_usare" })[0].id, i.id);
});

test("foto ridotte a JPEG, documenti (testo, Word, PDF) letti; file e idee si eliminano", async () => {
  const i = ideas.addIdea({ motive: "stile", reason: "Mi piace questa grafica: colori pieni e un numero grande", networks: ["instagram"] });
  const png = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#2f5bff" } }).png().toBuffer();
  await ideas.addFile(i.id, tmpFile("a.png", png), { name: "esempio.png", mime: "image/png" });
  const img = ideas.getIdea(i.id).files[0];
  assert.equal(img.kind, "image");
  assert.equal(img.mime, "image/jpeg");
  assert.ok(img.width <= 1600, "foto ridotta");
  assert.ok(fs.existsSync(ideas.filePath(i.id, img.id).file));

  await ideas.addFile(i.id, tmpFile("n.txt", "Titoli corti.\nUn numero per slide."), { name: "appunti.txt", mime: "" });
  const zip = new AdmZip();
  zip.addFile("word/document.xml", Buffer.from('<w:document><w:body><w:p><w:r><w:t>Argomento: credito d&apos;imposta</w:t></w:r></w:p><w:p><w:r><w:t>Seconda riga</w:t></w:r></w:p></w:body></w:document>'));
  await ideas.addFile(i.id, tmpFile("d.docx", zip.toBuffer()), { name: "temi.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  await ideas.addFile(i.id, tmpFile("p.pdf", tinyPdf("Piano editoriale di novembre")), { name: "piano.pdf", mime: "application/pdf" });
  const [, txt, docx, pdf] = ideas.getIdea(i.id).files;
  assert.equal(txt.kind, "document");
  assert.match(txt.preview, /Titoli corti/);
  assert.match(docx.preview, /credito d'imposta\nSeconda riga/);
  assert.match(pdf.preview, /Piano editoriale/);

  await assert.rejects(ideas.addFile(i.id, tmpFile("x.exe", "MZ"), { name: "virus.exe", mime: "application/x-msdownload" }), /Formato non supportato/);
  assert.equal(fs.readdirSync(DATA).filter((f) => f.startsWith(".t-")).length, 0, "i file temporanei si cancellano sempre");

  ideas.deleteFile(i.id, txt.id);
  assert.equal(ideas.getIdea(i.id).files.length, 3);
  ideas.deleteIdea(i.id);
  assert.throws(() => ideas.getIdea(i.id), /non trovata/);
  assert.ok(!fs.existsSync(path.join(ideas.IDEAS_DIR, i.id)), "la cartella dell'idea sparisce");
});

test("video: foglio di 6 fotogrammi e parlato trascritto, pronto per gli agenti", { skip: !hasFfmpeg && "ffmpeg non disponibile" }, async () => {
  const video = path.join(DATA, "esempio.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x568:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-shortest", "-pix_fmt", "yuv420p", video]);
  ideas._setTranscriber(async (wav) => {
    assert.equal(wav.toString("ascii", 0, 4), "RIFF", "al riconoscimento arriva un WAV");
    return "Tre numeri che ogni imprenditore deve sapere";
  });
  const i = ideas.addIdea({ motive: "stile", reason: "Ritmo veloce e testo grande: facciamo così i Reel", networks: ["instagram", "youtube"] });
  await ideas.addFile(i.id, tmpFile("v.mp4", fs.readFileSync(video)), { name: "reel.mp4", mime: "video/mp4" });
  assert.equal(ideas.getIdea(i.id).files[0].ready, false, "si prepara dopo, senza far aspettare");
  await ideas._idle();
  const f = ideas.getIdea(i.id).files[0];
  assert.equal(f.ready, true);
  assert.equal(f.seconds, 3);
  assert.equal(f.state, "pronto");
  assert.equal(f.transcript, "Tre numeri che ogni imprenditore deve sapere");
  const meta = await sharp(ideas.filePath(i.id, f.id, "sheet").file).metadata();
  assert.equal(meta.width, 3 * 360, "6 fotogrammi in 3 colonne");

  const seen = await ideas.ideasTool({ id: i.id, file_id: f.id });
  assert.equal(seen.toolContent[0].type, "image");
  assert.match(seen.toolContent[1].text, /Tre numeri/);
  ideas._setTranscriber(async () => {
    throw Object.assign(new Error("modello"), { status: 409 });
  });
  await ideas.addFile(i.id, tmpFile("v2.mp4", fs.readFileSync(video)), { name: "senza-voce.mp4", mime: "video/mp4" });
  await ideas._idle();
  assert.match(ideas.getIdea(i.id).files[1].state, /riconoscimento della voce non è ancora scaricato/);
});

test("strumenti degli agenti: elenco per social con le regole da evitare, documento a pezzi, idea usata", async () => {
  const forX = ideas.addIdea({ text: "Thread sui bandi", motive: "formato", reason: "Proviamo i thread da 5 post", networks: ["x"] });
  ideas.addIdea({ text: "«Non ci crederai»", motive: "evitare", reason: "Titoli acchiappa-clic: mai", networks: [] });
  const long = ideas.addIdea({ motive: "argomenti", reason: "Leggi il documento con i temi", networks: [] });
  await ideas.addFile(long.id, tmpFile("l.txt", "A".repeat(20_000)), { name: "lungo.txt", mime: "text/plain" });

  const writer = { id: "copy", name: "Copywriter Instagram", room: "trading", tools: ["social_publish", "read_notes"] };
  assert.ok(enabledTools(writer).has("ideas") && enabledTools(writer).has("idea_used"), "chi pubblica riceve le idee da solo");
  assert.ok(!enabledTools({ id: "t", tools: ["get_quote"] }).has("ideas"), "gli agenti di trading no");

  const insta = await runTool(writer, "ideas", { network: "instagram" });
  assert.ok(!insta.idee.some((x) => x.id === forX.id), "le idee solo per X non arrivano a Instagram");
  assert.match(insta.da_evitare_sempre.join(" "), /acchiappa-clic/);
  assert.match(insta.come_usarle, /senza copiare/);

  const doc = ideas.getIdea(long.id).files[0];
  const part1 = await runTool(writer, "ideas", { id: long.id, file_id: doc.id });
  assert.equal(part1.testo.length, 12_000);
  assert.equal(part1.continua_da, 12_000);
  const part2 = await runTool(writer, "ideas", { id: long.id, file_id: doc.id, from: 12_000 });
  assert.equal(part2.testo.length, 8_000);

  await assert.rejects(runTool(writer, "idea_used", { id: forX.id, note: "ok" }), /cosa hai fatto/);
  const r = await runTool(writer, "idea_used", { id: forX.id, note: "Thread di 5 post sui bandi, uscito lunedì" });
  assert.equal(r.stato, "in_uso");
  const u = ideas.getIdea(forX.id).uses.at(-1);
  assert.equal(u.by, "Copywriter Instagram");
  await runTool(writer, "idea_used", { id: forX.id, note: "Secondo thread, idea esaurita", finished: true });
  assert.equal(ideas.getIdea(forX.id).status, "usata");
  assert.ok(!(await runTool(writer, "ideas", {})).idee.some((x) => x.id === forX.id), "le idee usate escono dall'elenco da usare");
});

test("le idee restano dopo un riavvio e si archiviano", () => {
  const i = ideas.addIdea({ text: "Caroselli con mappe", motive: "formato", reason: "Le mappe si salvano molto" });
  ideas._reload();
  assert.equal(ideas.getIdea(i.id).text, "Caroselli con mappe");
  ideas.updateIdea(i.id, { status: "archiviata" });
  assert.ok(ideas.listIdeas({ status: "archiviata" }).some((x) => x.id === i.id));
  assert.throws(() => ideas.updateIdea(i.id, { reason: " " }), /non può restare vuoto/);
});
