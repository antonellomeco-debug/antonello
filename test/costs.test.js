// Spesa: conteggio per agente e palazzo, budget, ritmo dei palazzi, "solo con novità", consigli per risparmiare.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AGENTI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "costs-test-"));
process.env.MARKET_MODE = "demo";
const { addUsage, addCost, costScope, countRun, getState, postNote } = await import("../lib/store.js");
const costs = await import("../lib/costs.js");
const { office } = await import("../lib/office.js");
const { normalize, validate } = await import("../lib/config.js");

const b = () => office.building();
const room = () => b().rooms[0].id;
const palace = () => b().palaces[0].id;

test("la spesa si conta sull'agente e sul suo palazzo, Orion e il resto a parte", () => {
  costScope.run({ agentId: "analista", palace: palace() }, () => {
    countRun("analista");
    addUsage("claude-haiku-5-5", { input_tokens: 1_000_000, output_tokens: 0 }); // 0,10 $
    addCost(0.015); // un post su X
  });
  costScope.run({ kind: "orion" }, () => addUsage("claude-sonnet-5-5", { input_tokens: 100_000, output_tokens: 0 })); // 0,20 $
  addCost(0.5); // senza nessuno: "altro"
  const m = costs.monthSpend();
  assert.ok(Math.abs(m.agents.analista.usd - 0.115) < 1e-9);
  assert.equal(m.agents.analista.runs, 1);
  assert.ok(Math.abs(m.palaces[palace()] - 0.115) < 1e-9);
  assert.ok(Math.abs(m.other.orion - 0.2) < 1e-9);
  assert.ok(Math.abs(m.other.altro - 0.5) < 1e-9);
  assert.ok(Math.abs(m.total - 0.815) < 1e-9);
});

test("la cache costa meno: lettura un decimo, scrittura di un'ora il doppio", () => {
  const before = getState().usage.costUsd;
  addUsage("claude-opus-5-5", { input_tokens: 0, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 }, output_tokens: 0 });
  assert.ok(Math.abs(getState().usage.costUsd - before - (0.4 + 8)) < 1e-9);
});

test("budget del mese (generale e del palazzo) e pausa fermano lo scheduler", () => {
  const agent = normalize({ id: "x", name: "X", room: room(), everyMinutes: 60 });
  assert.equal(costs.scheduleBlock(agent, b()), null);
  costs.setBudgets({ monthlyUsd: 50 });
  assert.equal(costs.scheduleBlock(agent, b()), null, "spesi meno di 50 $");
  costs.setBudgets({ monthlyUsd: 5 });
  assert.match(costs.scheduleBlock(agent, b()), /budget del mese raggiunto/);
  costs.setBudgets({ monthlyUsd: "", palaces: { [palace()]: 0.1 } });
  assert.match(costs.scheduleBlock(agent, b()), /budget del palazzo raggiunto/);
  costs.setBudgets({ palaces: { [palace()]: null } });
  assert.equal(costs.scheduleBlock(agent, b()), null);
  costs.setPalacePace(palace(), "pausa", b());
  assert.equal(costs.scheduleBlock(agent, b()), "palazzo in pausa");
  assert.throws(() => costs.setBudgets({ monthlyUsd: "tanti" }), /numero di dollari/);
  assert.throws(() => costs.setPalacePace(palace(), "turbo", b()), /ritmo/);
  assert.throws(() => costs.setPalacePace("inesistente", "minimo", b()), /non esiste/);
});

test("il ritmo del palazzo allunga l'intervallo degli agenti", () => {
  const agent = normalize({ id: "x", name: "X", room: room(), everyMinutes: 60 });
  costs.setPalacePace(palace(), "normale", b());
  assert.equal(costs.effectiveEvery(agent, b()), 60);
  costs.setPalacePace(palace(), "risparmio", b());
  assert.equal(costs.effectiveEvery(agent, b()), 120);
  costs.setPalacePace(palace(), "minimo", b());
  assert.equal(costs.effectiveEvery(agent, b()), 240);
  costs.setPalacePace(palace(), "normale", b());
});

test("solo con novità: c'è lavoro solo se altri hanno scritto nelle stanze che l'agente legge", async () => {
  const agent = normalize({ id: "editore", name: "Editore", room: room(), everyMinutes: 60, onlyOnNews: true });
  const since = Date.now() + 1;
  assert.equal(costs.hasNews(agent, b(), since), false);
  await new Promise((r) => setTimeout(r, 5));
  postNote(room(), { id: "editore", name: "Editore" }, "nota mia");
  assert.equal(costs.hasNews(agent, b(), since), false, "le proprie note non contano");
  postNote(room(), { id: "trend", name: "Trend" }, "nuovo trend");
  assert.equal(costs.hasNews(agent, b(), since), true);
  assert.deepEqual(validate({ ...agent, instructions: "x" }, b().rooms), []);
});

test("rapporto: agenti dal più costoso, stime e consigli", () => {
  const room0 = room();
  const opus = office.saveAgent(normalize({ name: "Capo costoso", room: room0, mode: "llm", instructions: "x", model: "claude-opus-5-5", effort: "medium", everyMinutes: 15, tools: ["read_notes", "post_note"] }));
  costScope.run({ agentId: opus.id, palace: palace() }, () => {
    countRun(opus.id);
    addUsage("claude-opus-5-5", { input_tokens: 200_000, output_tokens: 10_000 }); // 1 $
  });
  const r = costs.costReport(office.agents(), b());
  const row = r.agents[0];
  assert.equal(row.id, opus.id);
  assert.ok(Math.abs(row.perRun - 1) < 1e-9);
  assert.ok(row.monthlyEstimate > 100, "ogni 15 minuti per tutto l'orario di lavoro");
  assert.ok(row.tips.some((t) => /Haiku/.test(t)));
  assert.ok(row.tips.some((t) => /più di una volta all'ora/.test(t)));
  assert.ok(row.tips.some((t) => /solo con novità/.test(t)));
  assert.ok(r.projection >= r.total);
  assert.equal(r.palaces.find((p) => p.id === palace()).pace, "normale");
});

test("nuovi agenti: di partenza Haiku con poco ragionamento", () => {
  const a = normalize({ name: "Nuovo" });
  assert.equal(a.model, "claude-haiku-5-5");
  assert.equal(a.effort, "low");
  assert.equal(a.onlyOnNews, false);
});
