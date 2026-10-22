// Scrivere come una persona: segni tipici dei testi fatti dall'IA (lib/style.js) e controllo prima di pubblicare.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "style-test-"));
process.env.MARKET_MODE = "demo";
const { styleProblems, assertHumanText, textsOf, WRITING_RULES } = await import("../lib/style.js");
const { runTool } = await import("../lib/tools.js");

const kinds = (t) => styleProblems(t).map((p) => p.tipo);

test("segni forti: ne basta uno (contrasto finto, chiusura a effetto, annunci, resti da chat, trattini)", () => {
  assert.match(kinds("Non è solo un bando, è una vera opportunità per le PMI.").join(), /contrasto finto/);
  assert.match(kinds("Non è un bando. È un regalo.").join(), /Non è X\. È Y/);
  assert.match(kinds("Non si tratta di fortuna ma di metodo.").join(), /non si tratta di/);
  assert.match(kinds("Il credito sale al 40%. E questo cambia tutto.").join(), /chiusura/);
  assert.match(kinds("Facciamo chiarezza: il bando scade il 30.").join(), /annuncio/);
  assert.match(kinds("Certo! Le aziende possono chiederlo fino a novembre.").join(), /resto da chat/);
  assert.match(kinds("Il bando, aperto a tutti, scade il 30 — e i fondi — sono pochi.").join(), /trattini/);
  assert.match(kinds("Nell'era dell'IA le PMI rischiano.").join(), /massima/);
});

test("segni deboli: contano solo se sono almeno tre diversi; i testi normali passano", () => {
  assert.deepEqual(styleProblems("Il bando Smart&Start dà fino a 1,5 milioni a tasso zero alle startup innovative. Scade il 30 novembre."), []);
  assert.deepEqual(styleProblems("È un passaggio fondamentale: senza il DURC la domanda viene respinta."), []);
  assert.deepEqual(styleProblems("Non solo per le startup, ma anche per le PMI."), []);
  assert.deepEqual(styleProblems("Il bando è più semplice: è aperto a tutti, ma scade presto. Non è più così per i mutui."), []);
  assert.deepEqual(styleProblems("Grazie! Il bando vale per tutte le regioni tranne la Valle d'Aosta."), []);
  const many = kinds("Un ecosistema cruciale e rivoluzionario che gioca un ruolo chiave.");
  assert.ok(many.length >= 3 && many.every((k) => /gonfiat/.test(k)), many.join());
});

test("prima volta bloccato con le frasi da riscrivere; lo stesso testo identico rimandato passa", () => {
  const text = "Non è solo un bando, è una svolta.";
  assert.throws(() => assertHumanText("a1", text), /NON è stato inviato.*contrasto finto.*«Non è solo un bando, è»/s);
  assert.doesNotThrow(() => assertHumanText("a1", text));
  assert.throws(() => assertHumanText("a1", text), /NON è stato inviato/, "la seconda via libera vale una volta sola");
  assert.throws(() => assertHumanText("a2", "Certo! Ecco i dati."), /resto da chat/);
  assert.doesNotThrow(() => assertHumanText("a2", "I dati di settembre: 40 miliardi in meno."));
});

test("social_publish e i video passano dal controllo; le regole arrivano a chi scrive", async () => {
  const agent = { id: "editore", name: "Editore", room: "r", tools: ["social_publish", "create_motion_video"], limits: {} };
  const input = { network: "threads", text: "Ottima domanda! Il bando scade il 30.", reason: "prova" };
  await assert.rejects(() => runTool(agent, "social_publish", input), /Il post NON è stato inviato/);
  const p = await runTool(agent, "social_publish", input);
  assert.equal(p.status, "pending_manual", "rimandato identico passa (Threads non collegato: post a mano)");
  const video = { format: "reel", scenes: [{ type: "hook", title: "I bandi di novembre", voice: "Spero ti sia utile: ecco i bandi." }] };
  await assert.rejects(() => runTool(agent, "create_motion_video", video), /Il video NON è stato inviato.*resto da chat/s);
  assert.match(textsOf({ media: ["m1"], scenes: [{ voice: "uno", type: "hook", items: ["due"] }] }), /^uno\ndue$/);
  assert.match(WRITING_RULES, /non è solo X, è Y/);
});
