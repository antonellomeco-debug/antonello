// Configurazione per il server in cloud (variabili d'ambiente), limiti di spesa degli agenti,
// salvataggi sicuri dello stato e ordini rimasti a metà dopo una chiusura improvvisa.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, tempDir } from "./helpers/server.js";

/** Valori di lib/env.js con le variabili indicate (in un processo a parte, senza ereditare quelle dei test). */
function envWith(vars) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", "import * as e from './lib/env.js'; console.log(JSON.stringify(e));"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, ...vars },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

test("Mac (nessuna variabile): niente password, localhost, aggiornamenti dall'app", () => {
  const e = envWith({});
  assert.equal(e.PUBLIC_URL, null);
  assert.equal(e.AUTH_ENABLED, false);
  assert.equal(e.FAIL_CLOSED, false);
  assert.equal(e.UPDATER_ON, true);
  assert.equal(e.VOLUME_OK, true);
  assert.equal(e.TRUST_PROXY, null);
  assert.equal(e.COOKIE_NAME, "agenti_sid");
  assert.equal(e.REDIRECT_URI, "http://localhost:3000/ctrader/callback");
  assert.equal(e.DATA_DIR, path.join(ROOT, "data"));
  assert.equal(envWith({ PORT: "3100" }).REDIRECT_URI, "http://localhost:3100/ctrader/callback");
});

test("PUBLIC_URL: variabile, poi RAILWAY_PUBLIC_DOMAIN, poi RENDER_EXTERNAL_URL; senza / finale", () => {
  assert.equal(envWith({ PUBLIC_URL: "https://agenti.example.test/" }).PUBLIC_URL, "https://agenti.example.test");
  assert.equal(envWith({ PUBLIC_URL: "agenti.example.test" }).PUBLIC_URL, "https://agenti.example.test");
  assert.equal(envWith({ RAILWAY_PUBLIC_DOMAIN: "nome.up.railway.app" }).PUBLIC_URL, "https://nome.up.railway.app");
  assert.equal(envWith({ RENDER_EXTERNAL_URL: "https://nome.onrender.com" }).PUBLIC_URL, "https://nome.onrender.com");
  assert.equal(envWith({ PUBLIC_URL: "https://a.example", RAILWAY_PUBLIC_DOMAIN: "b.up.railway.app" }).PUBLIC_URL, "https://a.example");
  const e = envWith({ PUBLIC_URL: "https://agenti.example.test", APP_PASSWORD: "0123456789" });
  assert.equal(e.CLOUD, true);
  assert.equal(e.AUTH_ENABLED, true);
  assert.equal(e.FAIL_CLOSED, false);
  assert.equal(e.UPDATER_ON, false, "sul server niente pulsante Aggiorna");
  assert.equal(e.COOKIE_NAME, "__Host-agenti");
  assert.equal(e.REDIRECT_URI, "https://agenti.example.test/ctrader/callback");
  assert.equal(envWith({ PUBLIC_URL: "https://a.example/percorso" }).FAIL_CLOSED, true, "indirizzo con percorso: da correggere");
});

test("quando l'app si rifiuta di partire senza protezione", () => {
  assert.equal(envWith({ RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" }).FAIL_CLOSED, true, "cloud senza password");
  assert.equal(envWith({ PUBLIC_URL: "https://x.example", APP_PASSWORD: "123456789" }).FAIL_CLOSED, true, "9 caratteri: troppo corta");
  assert.equal(envWith({ HOST: "0.0.0.0" }).FAIL_CLOSED, true, "rete senza password");
  assert.equal(envWith({ HOST: "0.0.0.0", APP_PASSWORD: "0123456789" }).FAIL_CLOSED, false);
  assert.equal(envWith({ APP_PASSWORD: "0123456789" }).AUTH_ENABLED, true, "con APP_PASSWORD anche sul Mac");
});

test("volume dei dati, proxy e aggiornamenti", () => {
  assert.equal(envWith({ RAILWAY_VOLUME_MOUNT_PATH: "/data" }).DATA_DIR, "/data");
  assert.equal(envWith({ RAILWAY_VOLUME_MOUNT_PATH: "/data", AGENTI_DATA_DIR: "/altro" }).DATA_DIR, "/altro");
  assert.equal(envWith({ RAILWAY_ENVIRONMENT: "production" }).VOLUME_OK, false, "su Railway senza volume");
  assert.equal(envWith({ RAILWAY_ENVIRONMENT: "production", RAILWAY_VOLUME_MOUNT_PATH: "/data" }).VOLUME_OK, true);
  assert.equal(envWith({ TRUST_PROXY: "1" }).TRUST_PROXY, 1);
  assert.equal(envWith({ TRUST_PROXY: "loopback" }).TRUST_PROXY, "loopback");
  assert.equal(envWith({ TRUST_PROXY: "true" }).TRUST_PROXY, 1, "mai fidarsi di tutti");
  assert.equal(envWith({ TRUST_PROXY: "0" }).TRUST_PROXY, null);
  assert.equal(envWith({ UPDATER: "off" }).UPDATER_ON, false);
  assert.equal(envWith({ RAILWAY_GIT_COMMIT_SHA: "ABCDEF1234567890abcdef1234567890abcdef12" }).ENV_COMMIT, "abcdef1234567890abcdef1234567890abcdef12");
});

test("limiti di spesa: modello con prezzo noto, impegno valido, niente agenti ogni 1-4 minuti", async () => {
  const { validate, normalize } = await import("../lib/config.js");
  const rooms = [{ id: "r" }];
  const agent = (over) => normalize({ id: "a", room: "r", instructions: "fai", ...over });
  assert.deepEqual(validate(agent({}), rooms), []);
  assert.deepEqual(validate(agent({ model: "claude-haiku-5-5", effort: "xhigh", everyMinutes: 5 }), rooms), []);
  assert.deepEqual(validate(agent({ everyMinutes: 0 }), rooms), [], "0 = solo a mano");
  assert.match(validate(agent({ model: "claude-qualcosa" }), rooms).join(), /model "claude-qualcosa" sconosciuto/);
  assert.match(validate(agent({ effort: "altissimo" }), rooms).join(), /effort deve essere/);
  for (const m of [1, 2, 4, 4.9]) assert.match(validate(agent({ everyMinutes: m }), rooms).join(), /almeno 5 minuti/, String(m));
  assert.match(validate(agent({ everyMinutes: -1 }), rooms).join(), /everyMinutes/);
  // Gli agenti a regole non usano Claude: il modello non conta.
  assert.deepEqual(validate(agent({ mode: "rule", strategy: "sma_cross", model: "vecchio" }), rooms), []);
});

/** Esegue un piccolo script con i moduli del programma in una cartella dati temporanea. */
function runWith(dataDir, code) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, AGENTI_DATA_DIR: dataDir, MARKET_MODE: "demo" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout;
}

test("state.json rovinato: messo da parte (non sovrascritto in silenzio) e segnalato", () => {
  const dir = tempDir("store-corrupt-");
  fs.writeFileSync(path.join(dir, "state.json"), '{"portfolio": {"cash": 12');
  const out = runWith(dir, "const s = await import('./lib/store.js'); s.persistNow(); console.log('cash=' + s.getState().portfolio.cash);");
  const corrupt = fs.readdirSync(dir).filter((f) => f.startsWith("state.json.corrupt-"));
  assert.equal(corrupt.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, corrupt[0]), "utf8"), '{"portfolio": {"cash": 12', "il file rovinato si può recuperare");
  assert.match(out, /\[error\] programma: Il file state\.json era rovinato/, "avviso anche nel registro del programma");
  assert.match(out, /cash=100000/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).log.at(-1).level, "error");
  assert.equal(fs.existsSync(path.join(dir, "state.json.tmp")), false, "scrittura atomica: nessun file temporaneo rimasto");
});

test("settings.json scritto in modo atomico e solo per l'utente", () => {
  const dir = tempDir("settings-");
  runWith(dir, "const s = await import('./lib/settings.js'); s.updateSettings({ anthropicApiKey: 'sk-ant-x' });");
  assert.equal(fs.statSync(path.join(dir, "settings.json")).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(dir, "settings.json.tmp")), false);
});

test("ordine approvato interrotto da una chiusura improvvisa: alla riapertura 'esito incerto', mai di nuovo da approvare", () => {
  const dir = tempDir("approvals-");
  const approval = (id, status) => ({ id, status, agentName: "Trader", agent: { id: "t" }, order: { action: "open", symbol: "EURUSD", side: "buy", lots: 0.01 } });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ approvals: [approval("1", "executing"), approval("2", "pending"), approval("3", "executed")] }));
  const out = runWith(dir, "const b = await import('./lib/broker.js'); const s = await import('./lib/store.js'); console.log('n=' + b.recoverInterruptedApprovals()); s.persistNow();");
  assert.match(out, /n=1/);
  assert.match(out, /\[warn\] sicurezza: Ordine approvato \(buy EURUSD di Trader\) interrotto/);
  const st = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.deepEqual(st.approvals.map((a) => a.status), ["uncertain", "pending", "executed"]);
  assert.match(st.approvals[0].error, /controlla le posizioni/);
});
