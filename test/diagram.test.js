// Diagrammi con i colori di Venturo (lib/social/diagram.js, strumento create_diagram).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "diagram-test-"));
process.env.MARKET_MODE = "demo";
const { diagramSvg, DIAGRAM_TYPES } = await import("../lib/social/diagram.js");
const media = await import("../lib/social/media.js");
const { runTool, TOOL_DEFS } = await import("../lib/tools.js");
const { ALL_TOOLS } = await import("../lib/config.js");

const SPECS = {
  process: { items: [{ label: "Iscriviti al registro", text: "Alla Camera di commercio" }, { label: "Fai la domanda", focus: true }, "Firma"] },
  timeline: { items: [{ date: "4 nov", label: "Apre il bando" }, { date: "30 nov", label: "Chiude", focus: true }] },
  funnel: { items: [{ label: "visite", value: "1.000" }, { label: "contatti", value: "12", focus: true }] },
  compare: { left: { title: "Ditta", items: ["Costi bassi"] }, right: { title: "Srl", items: ["Rischio limitato", "IRES 24%"], focus: true } },
  quadrant: { x_label: "Sforzo", y_label: "Impatto", quadrants: ["Subito", "Dopo", "Piccole cose", "No"], items: [{ label: "Newsletter", x: 20, y: 90, focus: true }, { label: "App", x: 90, y: 60 }] },
  bars: { unit: "%", items: [{ label: "Lombardia", value: 24.5, focus: true }, { label: "Lazio", value: 11 }] },
  cycle: { center: "Chi fa impresa", items: ["Informazioni", "Contatti", { label: "Capitali", focus: true }] },
};

test("tutti i tipi: SVG con titolo, logo, fonte e misure del formato; testo protetto", () => {
  assert.deepEqual(Object.keys(SPECS).sort(), [...DIAGRAM_TYPES].sort());
  for (const [type, spec] of Object.entries(SPECS)) {
    const svg = diagramSvg({ type, title: `Prova ${type} <&>`, source: "Istat, 2026", page: "2/8", ...spec });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1080" height="1350"/, type);
    assert.match(svg, /Prova \w+ &lt;&amp;&gt;/, `${type}: testo protetto`);
    assert.match(svg, /Fonte: Istat, 2026/);
    assert.match(svg, />venturo</);
    assert.match(svg, />2\/8</);
    assert.match(svg, /font-family="Sora"/);
    assert.ok(svg.includes("#2F5BFF"), `${type}: elemento evidenziato con l'accento`);
  }
  assert.match(diagramSvg({ type: "bars", title: "x", format: "landscape", theme: "notte", items: [{ label: "a", value: 3900 }, { label: "b", value: 1 }] }), /width="1200" height="675"[\s\S]*#0A1F44[\s\S]*3\.900/);
});

test("regole: pochi elementi, al massimo 2 evidenziati, dati validi, testi brevi", () => {
  assert.throws(() => diagramSvg({ type: "pie", title: "x" }), /type: process/);
  assert.throws(() => diagramSvg({ type: "process", title: "", items: ["a", "b"] }), /title/);
  assert.throws(() => diagramSvg({ type: "process", title: "x", items: Array(8).fill("passo") }), /da 2 a 7 elementi/);
  assert.throws(() => diagramSvg({ type: "process", title: "x", items: [{ label: "a", focus: true }, { label: "b", focus: true }, { label: "c", focus: true }] }), /al massimo 2/);
  assert.throws(() => diagramSvg({ type: "bars", title: "x", items: [{ label: "a", value: "tanti" }, { label: "b", value: 2 }] }), /value/);
  assert.throws(() => diagramSvg({ type: "quadrant", title: "x", items: [{ label: "a" }] }), /x e y/);
  assert.throws(() => diagramSvg({ type: "compare", title: "x", left: { title: "a", items: [] }, right: { title: "b", items: ["c"] } }), /left\.items/);
  assert.throws(() => diagramSvg({ type: "process", title: "x".repeat(91), items: ["a", "b"] }), /al massimo 90/);
  assert.throws(() => diagramSvg({ type: "process", title: "x", format: "banner_x", items: ["a", "b"] }), /format/);
});

test("create_diagram: immagine nell'archivio, controllo dello stile, Sora tra i caratteri delle grafiche", async () => {
  assert.ok(ALL_TOOLS.includes("create_diagram"));
  assert.match(TOOL_DEFS.create_diagram.description, /quadrant/);
  assert.ok(media.FONTS.includes("Sora"));
  const agent = { id: "grafico", name: "Grafico", tools: ["create_diagram"] };
  const m = await runTool(agent, "create_diagram", { type: "process", title: "Come aprire una Srl in 4 passi", format: "square", items: ["Notaio", "Capitale", "Registro", "Partita IVA"] });
  assert.equal(m.kind, "image");
  assert.equal(m.width, 1080);
  assert.equal(m.height, 1080);
  assert.equal(m.origin, "graphic");
  assert.match(m.message, /social_publish/);
  await assert.rejects(runTool(agent, "create_diagram", { type: "cycle", title: "Facciamo chiarezza sul ciclo", items: ["a", "b", "c"] }), /Il diagramma NON è stato inviato/);
});
