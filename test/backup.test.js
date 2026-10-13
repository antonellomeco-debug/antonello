// Copia dei dati (⚙️ Impostazioni): esportazione in .zip, controlli all'importazione (solo i file previsti,
// niente percorsi fuori dalla cartella, JSON leggibili), copia di sicurezza, applicazione al riavvio e
// conferma con password sul server.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { startServer, tempDir } from "./helpers/server.js";

const dataDir = tempDir("backup-test-");
process.env.AGENTI_DATA_DIR = dataDir;
const backup = await import("../lib/backup.js");

const write = (rel, content) => {
  fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dataDir, rel), typeof content === "string" ? content : JSON.stringify(content));
};
const read = (rel) => JSON.parse(fs.readFileSync(path.join(dataDir, rel), "utf8"));
const zipOf = (files) => {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(files)) z.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(typeof content === "string" ? content : JSON.stringify(content)));
  return z.toBuffer();
};
const names = (buf) => new AdmZip(buf).getEntries().map((e) => e.entryName).sort();

write("building.json", { name: "Palazzo di prova", floors: [], rooms: [], links: [] });
write("agents/alfa.json", { name: "Alfa" });
write("agents/beta.json", { name: "Beta" });
write("state.json", { notes: {} });
write("settings.json", { anthropicApiKey: "sk-ant-prova" });
write("safety.json", { liveEnabled: false });
write("ctrader.json", { clientId: "x" });
write("auth.json", { sessions: {} });
write("calendar.json", { events: [] });
write("installed.json", { sha: "abc" });
write("state.json.tmp", "{");
write("backup/vecchia/server.js", "// copia");
write("agents/note.txt", "non è un agente");

test("esportazione: solo i dati dell'utente, niente accessi, cache o file temporanei", () => {
  assert.deepEqual(names(backup.exportZip()), [
    "agents/alfa.json", "agents/beta.json", "building.json", "ctrader.json", "safety.json", "settings.json", "state.json",
  ]);
  assert.match(backup.backupFileName(new Date("2026-10-13T10:00:00Z")), /^agenti-dati-2026-10-13\.zip$/);
});

test("importazione rifiutata: non è uno zip, JSON rovinato, nessun dato dell'app, file troppo grande", () => {
  assert.throws(() => backup.readBackup(Buffer.from("ciao")), /non è uno \.zip valido/);
  assert.throws(() => backup.readBackup(zipOf({ "building.json": "{rotto" })), /building\.json è rovinato/);
  assert.throws(() => backup.readBackup(zipOf({ "agents/a.json": "[1,2]" })), /non ha il contenuto atteso/);
  assert.throws(() => backup.readBackup(zipOf({ "foto.jpg": "x", "auth.json": "{}" })), /non sembra una copia/);
  assert.throws(() => backup.readBackup(zipOf({ "building.json": { floors: "no" } })), /palazzo/);
  const big = `{"x":"${"a".repeat(11 * 1024 * 1024)}"}`;
  assert.throws(() => backup.readBackup(zipOf({ "state.json": big, "building.json": {} })), /troppo grande/);
});

test("importazione: i file fuori elenco o fuori cartella si ignorano (zip-slip)", () => {
  const z = new AdmZip();
  z.addFile("building.json", Buffer.from("{}"));
  z.addFile("auth.json", Buffer.from('{"sessions":{}}'));
  z.addFile("calendar.json", Buffer.from("{}"));
  z.addFile("agents/ok.json", Buffer.from('{"name":"Ok"}'));
  z.addFile("agents/Maiuscolo.json", Buffer.from("{}"));
  z.addFile("x/../../fuori.json", Buffer.from("{}"));
  z.addFile("agents/../../../fuori2.json", Buffer.from("{}"));
  z.addFile("__MACOSX/._building.json", Buffer.from("x"));
  const buf = z.toBuffer();
  const { files, skipped } = backup.readBackup(buf);
  assert.deepEqual([...files.keys()].sort(), ["agents/ok.json", "building.json"]);
  assert.ok(skipped.length >= 4);
});

test("importazione completa: copia di sicurezza, poi i file vanno a posto al riavvio (anche da una cartella data/)", () => {
  const r = backup.importZip(zipOf({
    "data/building.json": { name: "Palazzo importato", floors: [], rooms: [], links: [] },
    "data/agents/gamma.json": { name: "Gamma" },
    "data/settings.json": { anthropicApiKey: "sk-ant-nuova" },
    "data/auth.json": { sessions: { finta: {} } },
  }));
  assert.equal(r.files, 3);
  assert.match(r.copy, /^backup[/\\]prima-di-import-.*\.zip$/);
  const copy = path.join(dataDir, r.copy);
  assert.ok(names(fs.readFileSync(copy)).includes("agents/alfa.json"), "la copia contiene i dati di prima");
  assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
  assert.equal(read("building.json").name, "Palazzo di prova", "finché il programma non riparte i dati restano quelli di prima");

  assert.equal(backup.applyStagedImport(), 3);
  assert.equal(read("building.json").name, "Palazzo importato");
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "agents")).filter((f) => f.endsWith(".json")), ["gamma.json"], "gli agenti sono quelli della copia");
  assert.equal(read("settings.json").anthropicApiKey, "sk-ant-nuova");
  assert.equal(fs.statSync(path.join(dataDir, "settings.json")).mode & 0o777, 0o600);
  assert.deepEqual(read("auth.json"), { sessions: {} }, "auth.json non si importa");
  assert.equal(read("safety.json").liveEnabled, false, "i file che la copia non ha restano");
  assert.equal(fs.existsSync(backup.STAGING_DIR), false);
  assert.equal(backup.applyStagedImport(), 0, "una volta sola");
});

test("preparazione interrotta (manca PRONTO): ignorata", () => {
  fs.mkdirSync(backup.STAGING_DIR, { recursive: true });
  fs.writeFileSync(path.join(backup.STAGING_DIR, "building.json"), '{"name":"a metà"}');
  assert.equal(backup.applyStagedImport(), 0);
  assert.equal(read("building.json").name, "Palazzo importato");
  assert.equal(fs.existsSync(backup.STAGING_DIR), false);
});

// ---------- dal server ----------

const PASSWORD = "copia-dei-dati-2026";
const servers = [];
after(() => Promise.all(servers.map((s) => s.stop())));

test("server: scarica la copia e importala con la password (riavvio automatico con start.js)", async () => {
  const env = { APP_PASSWORD: PASSWORD, PUBLIC_URL: "https://agenti.example.test", HOST: "127.0.0.1" };
  const s = await startServer(env, { script: "start.js" });
  servers.push(s);
  const login = await s.req("POST", "/api/login", { body: { password: PASSWORD } });
  const cookie = String(login.headers["set-cookie"][0]).split(";")[0];

  assert.equal((await s.req("GET", "/api/backup")).status, 401, "serve l'accesso");
  const dl = await s.req("GET", "/api/backup", { headers: { cookie }, raw: true });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers["content-type"], "application/zip");
  assert.match(dl.headers["content-disposition"], /^attachment; filename=agenti-dati-\d{4}-\d{2}-\d{2}\.zip$/);
  const exported = names(dl.body);
  assert.ok(exported.includes("building.json") && exported.some((n) => n.startsWith("agents/")));
  assert.equal(exported.includes("auth.json"), false);

  const z = new AdmZip(dl.body);
  const b = JSON.parse(z.readAsText("building.json"));
  b.name = "Palazzo dalla copia";
  z.updateFile("building.json", Buffer.from(JSON.stringify(b)));
  const upload = z.toBuffer();
  const post = (headers) => s.req("POST", "/api/backup", { body: upload, headers: { cookie, "content-type": "application/zip", ...headers } });

  const none = await post({});
  assert.equal(none.status, 401);
  assert.deepEqual(none.json, { error: "Password sbagliata", stepUp: true });
  assert.equal((await post({ "x-agenti-password": "sbagliata-000" })).status, 401);
  const bad = await s.req("POST", "/api/backup", { body: Buffer.from("non è uno zip"), headers: { cookie, "content-type": "application/zip", "x-agenti-password": PASSWORD } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /non è uno \.zip valido/);

  const ok = await post({ "x-agenti-password": PASSWORD });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.restarting, true);
  // start.js fa ripartire il server (codice 75): poi il palazzo è quello della copia, e si resta dentro.
  const t0 = Date.now();
  let name = null;
  while (Date.now() - t0 < 15_000) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const o = await s.req("GET", "/api/office", { headers: { cookie } });
      if (o.status === 200 && o.json.building.name === "Palazzo dalla copia") {
        name = o.json.building.name;
        break;
      }
    } catch {
      /* in riavvio */
    }
  }
  assert.equal(name, "Palazzo dalla copia", s.output());
  assert.match(s.output(), /Riavvio con la nuova versione|Riavvio/);
  const copies = fs.readdirSync(path.join(s.dataDir, "backup")).filter((f) => f.startsWith("prima-di-import-"));
  assert.equal(copies.length, 1);
});

test("server senza start.js: importazione pronta, va riavviato a mano", async () => {
  const s = await startServer({});
  servers.push(s);
  const dl = await s.req("GET", "/api/backup", { raw: true });
  const r = await s.req("POST", "/api/backup", { body: dl.body, headers: { "content-type": "application/zip" } });
  assert.deepEqual({ ok: r.json.ok, restarting: r.json.restarting, message: r.json.message }, { ok: true, restarting: false, message: "Riavvia il programma" });
  const big = await s.req("POST", "/api/backup", { body: Buffer.alloc(21 * 1024 * 1024), headers: { "content-type": "application/zip" } });
  assert.equal(big.status, 413);
});
