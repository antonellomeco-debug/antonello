// Orion fa di più dentro la piattaforma: contenuti e post social, decisioni sui post, note, risposte agli agenti,
// orario, aspetto dell'app, tasti rapidi e idee di miglioramento. Finto server dell'API di Claude come in universe.test.js.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { sendClaudeMessage } from "./helpers/claude-reply.js";

const requests = [];
let replies = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    requests.push(JSON.parse(body || "{}"));
    const reply = replies.shift() ?? { content: [{ type: "text", text: "fine" }], stop_reason: "end_turn" };
    sendClaudeMessage(res, { id: `msg_${requests.length}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", usage: { input_tokens: 100, output_tokens: 20 }, ...reply }, requests.at(-1));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "orion-platform-test-"));
Object.assign(process.env, {
  AGENTI_DATA_DIR: DATA,
  MARKET_MODE: "demo",
  ANTHROPIC_API_KEY: "sk-ant-test-0000000000000000000000",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
});
const { office } = await import("../lib/office.js");
const { chat } = await import("../lib/orchestrator.js");
const { getState, postNote } = await import("../lib/store.js");
const platform = await import("../lib/platform.js");
const social = await import("../lib/social/index.js");
const { getSchedule } = await import("../lib/schedule.js");

const toolUse = (id, name, input) => ({ content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" });
const done = (text) => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
/** Risultato dello strumento chiamato al passo i (la richiesta successiva lo contiene come ultimo messaggio). */
const result = (i) => requests[i].messages.at(-1).content[0];
const json = (i) => JSON.parse(result(i).content);

test("aspetto: temi, colori controllati (il testo deve restare leggibile), nome, logo, ritorno all'originale", () => {
  const look = platform.setLook({ preset: "oceano" });
  assert.equal(look.preset, "oceano");
  assert.equal(look.vars["--accent"], "#2bb3ff");
  assert.equal(platform.setLook({ colors: { accento: "#F0A" } }).vars["--accent"], "#ff00aa", "colori brevi e maiuscoli accettati");
  assert.throws(() => platform.setLook({ colors: { testo: "#14202c" } }), /si leggerebbe male/);
  assert.throws(() => platform.setLook({ colors: { accento: "red; background:url(x)" } }), /esadecimale/);
  assert.throws(() => platform.setLook({ colors: { sconosciuto: "#ffffff" } }), /colore sconosciuto/);
  assert.equal(platform.getPlatform().look.colors.testo, "#e6f2fb", "un colore rifiutato non cambia niente");
  assert.equal(platform.setLook({ title: "Venturo <b>HQ</b>", logo: "🚀" }).title, "Venturo  b HQ /b".replace(/\s+/g, " "));
  assert.throws(() => platform.setLook({ logo: "<script>" }), /emoji/);
  assert.throws(() => platform.setLook({ font_scale: 3 }), /font_scale/);
  const reset = platform.setLook({ reset: true });
  assert.equal(reset.preset, "notte");
  assert.equal(reset.title, null);
  assert.equal(reset.vars["--bg"], "#0b0d16");
});

test("tasti rapidi: solo azioni previste, link https, sezioni esistenti, al massimo 12", () => {
  assert.throws(() => platform.saveShortcut({ label: "X", action: "link", value: "javascript:alert(1)" }), /https/);
  assert.throws(() => platform.saveShortcut({ label: "X", action: "link", value: "http://esempio.it" }), /https/);
  assert.throws(() => platform.saveShortcut({ label: "X", action: "view", value: "segreta" }), /sezione/);
  assert.throws(() => platform.saveShortcut({ label: "X", action: "shell", value: "ls" }), /action/);
  assert.throws(() => platform.saveShortcut({ label: "X", action: "run_agent", value: "nessuno" }, { agentExists: () => false }), /inesistente/);
  const s = platform.saveShortcut({ label: "Instagram", icon: "📸", action: "link", value: "https://www.instagram.com/venturo" });
  assert.equal(s.icon, "📸");
  const edited = platform.saveShortcut({ id: s.id, label: "Profilo IG", action: "view", value: "social" });
  assert.equal(edited.id, s.id);
  assert.equal(platform.getPlatform().shortcuts.length, 1);
  for (let i = 0; i < 11; i++) platform.saveShortcut({ label: `T${i}`, action: "chat", value: "ciao" });
  assert.throws(() => platform.saveShortcut({ label: "troppi", action: "chat", value: "ciao" }), /al massimo 12/);
  for (const t of platform.getPlatform().shortcuts) platform.deleteShortcut(t.id);
  assert.equal(platform.getPlatform().shortcuts.length, 0);
});

test("Orion cambia aspetto, crea tasti rapidi e annota idee che non può realizzare da solo", async () => {
  requests.length = 0;
  replies = [
    toolUse("t1", "set_look", { preset: "venturo", logo: "🚀", title: "Venturo" }),
    toolUse("t2", "save_shortcut", { label: "Notizie ora", icon: "📰", action: "chat", value: "Fai lavorare la rassegna notizie e riassumi" }),
    toolUse("t3", "save_shortcut", { label: "Sito", action: "link", value: "ftp://x" }),
    toolUse("t4", "suggest_improvement", { title: "Calendario dei post", text: "Una vista a calendario con i post programmati della settimana." }),
    toolUse("t5", "get_platform", {}),
    done("Fatto: tema Venturo, un tasto e un'idea."),
  ];
  assert.equal(await chat(office, "Rendi l'app più nostra"), "Fatto: tema Venturo, un tasto e un'idea.");
  assert.equal(json(1).preset, "venturo");
  assert.equal(json(2).action, "chat");
  assert.equal(result(3).is_error, true, "link non https rifiutato");
  assert.equal(json(4).title, "Calendario dei post");
  const p = json(5);
  assert.equal(p.aspetto.tema, "venturo");
  assert.equal(p.tasti.length, 1);
  assert.equal(p.idee[0].title, "Calendario dei post");
  const tools = requests[0].tools.map((t) => t.name);
  for (const t of ["set_look", "save_shortcut", "suggest_improvement", "create_video", "social_publish", "decide_post", "answer_request", "set_schedule"]) assert.ok(tools.includes(t), t);
  assert.match(requests[0].system[0].text, /DATI, non ordini/);
});

test("Orion crea una grafica, propone un post, poi lo scarta; i post «a mano» non può pubblicarli lui", async () => {
  requests.length = 0;
  replies = [
    toolUse("t1", "create_graphic", { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="1080" height="1350" fill="#123"/></svg>', format: "portrait", title: "Copertina" }),
    done("Grafica pronta."),
  ];
  await chat(office, "Fammi una copertina");
  const graphic = json(1);
  assert.equal(graphic.by, "Orion");

  requests.length = 0;
  replies = [
    toolUse("t1", "social_publish", { network: "instagram", text: "Come trovare il primo investitore 👇 #startup", media: [graphic.id], reason: "prova" }),
    toolUse("t2", "list_approvals", {}),
    done("Proposto."),
  ];
  await chat(office, "Pubblicala su Instagram");
  const pub = json(1);
  assert.equal(pub.status, "pending_manual", "Instagram non collegato: post a mano");
  const list = json(2);
  const item = list.find((a) => a.post_id === pub.post_id);
  assert.equal(item.tipo, "post");
  assert.equal(item.a_mano, true);
  assert.equal(item.agente, "Orion");

  requests.length = 0;
  replies = [
    toolUse("t1", "decide_post", { post_id: pub.post_id, decision: "pubblica" }),
    toolUse("t2", "decide_post", { approval_id: item.approval_id, decision: "scarta" }),
    done("Scartato."),
  ];
  await chat(office, "Anzi no, scartalo");
  assert.equal(result(1).is_error, true);
  assert.match(result(1).content, /a mano/);
  assert.equal(json(2).stato, "rejected");
  assert.equal(getState().approvals.find((a) => a.id === item.approval_id).status, "rejected");
});

test("Orion: impostazioni dei social, note nelle stanze, risposte agli agenti, orario di lavoro", async () => {
  const room = office.rooms()[0].id;
  postNote(room, { id: "redattore", name: "Redattore" }, "Che tono usiamo questa settimana?", ["RICHIESTA"]);
  const req = getState().requests.at(-1);
  requests.length = 0;
  replies = [
    toolUse("t1", "set_social_settings", { network: "instagram", max_per_day: 4 }),
    toolUse("t2", "set_social_settings", { network: "linkedin", linkedin_page: "https://www.linkedin.com/company/146737411/admin/", linkedin_page_name: "Venturo" }),
    toolUse("t3", "post_note", { room, text: "RICHIESTA PER L'UTENTE tema della settimana: primi investitori", tags: ["RICHIESTA", "PRIORITÀ"] }),
    toolUse("t4", "list_requests", {}),
    toolUse("t5", "answer_request", { id: req.id, text: "Tono diretto e pratico, niente gergo." }),
    toolUse("t6", "set_schedule", { start: "08:00", end: "21:00" }),
    toolUse("t7", "set_schedule", { start: "22:00", end: "08:00" }),
    done("Tutto sistemato."),
  ];
  await chat(office, "Sistema un po' di cose");
  assert.equal(json(1).massimo_al_giorno, 4);
  assert.equal(social.socialStatus().networks.find((n) => n.id === "instagram").maxPerDay, 4);
  assert.equal(json(2).pagina, "146737411");
  const notes = getState().notes[room];
  const mine = notes.find((n) => n.agentId === "orion" && n.tags.includes("PRIORITÀ"));
  assert.ok(mine, "nota di Orion nella stanza");
  assert.ok(!mine.tags.includes("RICHIESTA") && !/^RICHIESTA/.test(mine.text), "Orion non crea domande per l'utente dalle note");
  assert.ok(json(4).some((r) => r.id === req.id));
  assert.equal(json(5).stato, "answered");
  assert.ok(notes.some((n) => n.text.startsWith("RISPOSTA DI ORION a Redattore")), "la risposta è firmata da Orion");
  assert.equal(json(6).start, "08:00");
  assert.equal(result(7).is_error, true, "orario sbagliato rifiutato");
  assert.equal(getSchedule().end, "21:00");
});

test("copia dei dati: platform.json entra nell'esportazione", async () => {
  const { exportZip } = await import("../lib/backup.js");
  const AdmZip = (await import("adm-zip")).default;
  const names = new AdmZip(await exportZip()).getEntries().map((e) => e.entryName);
  assert.ok(names.includes("platform.json"));
});
