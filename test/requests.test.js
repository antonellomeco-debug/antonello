// Domande degli agenti all'utente (note RICHIESTA) e copertine dei profili.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "requests-test-"));
process.env.MARKET_MODE = "demo";
const { postNote, getState, answerRequest, readNotes } = await import("../lib/store.js");
const media = await import("../lib/social/media.js");

const agent = { id: "profilo_ig", name: "Brand Manager Instagram" };

test("una nota RICHIESTA diventa una domanda per l'utente; la risposta torna nella stanza", () => {
  postNote("direzione-instagram", agent, "Mi serve il logo in alta qualità e l'email di contatto.", ["RICHIESTA", "profilo"]);
  postNote("direzione-instagram", agent, "RICHIESTA PER L'UTENTE: in che città lavori?");
  postNote("direzione-instagram", agent, "Kit profilo pronto.", ["PROFILO"]);
  const open = getState().requests.filter((r) => r.status === "open");
  assert.equal(open.length, 2);
  const r = answerRequest(open[0].id, "Email: info@esempio.it [Allegato: foto «logo», id m123 nell'archivio]");
  assert.equal(r.status, "answered");
  const last = readNotes("direzione-instagram", 1)[0];
  assert.equal(last.agentId, "utente");
  assert.match(last.text, /^RISPOSTA DELL'UTENTE a Brand Manager Instagram \(«Mi serve il logo/);
  assert.match(last.text, /info@esempio\.it/);
  assert.equal(getState().requests.filter((x) => x.status === "open").length, 1, "la risposta dell'utente non è una nuova domanda");
  assert.throws(() => answerRequest(open[0].id, "di nuovo"), /già chiusa/);
  assert.throws(() => answerRequest(open[1].id, "   "), /Scrivi la risposta/);
  assert.equal(answerRequest(open[1].id, "", { dismiss: true }).status, "dismissed");
});

test("copertine dei profili: X 1500×500 e LinkedIn 1584×396", async () => {
  const svg = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#0a66c2"/><text x="400" y="250" font-family="Montserrat" font-size="80" fill="#fff">Brand</text></svg>`;
  const x = await media.createGraphic({ svg: svg(1500, 500), format: "banner_x", title: "Copertina X" });
  assert.deepEqual([x.width, x.height], [1500, 500]);
  const li = await media.createGraphic({ svg: svg(1584, 396), format: "banner_linkedin", title: "Copertina LinkedIn" });
  assert.deepEqual([li.width, li.height], [1584, 396]);
});
