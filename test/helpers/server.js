// Avvia il vero server (server.js o start.js) in un processo a parte, con una cartella dati temporanea e
// solo le variabili d'ambiente indicate: così si provano le diverse configurazioni (Mac, cloud, proxy…).
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export const tempDir = (name = "server-test-") => fs.mkdtempSync(path.join(os.tmpdir(), name));

/** Richiesta HTTP con pieno controllo delle intestazioni (anche Host). */
export function request(port, method, urlPath, { headers = {}, body, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const h = { ...(data && !Buffer.isBuffer(body) && typeof body !== "string" ? { "content-type": "application/json" } : {}), ...headers };
    if (data) h["content-length"] = data.length;
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        if (!raw) {
          try {
            json = JSON.parse(buf.toString("utf8"));
          } catch {
            /* non JSON */
          }
        }
        resolve({ status: res.statusCode, headers: res.headers, body: raw ? buf : buf.toString("utf8"), json });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Avvia il server. env: variabili in più (oltre a PATH, HOME, porta e cartella dati).
 * script: "server.js" (predefinito) o "start.js" (con il riavvio automatico).
 */
export async function startServer(env = {}, { script = "server.js", dataDir = tempDir(), port, wait = true } = {}) {
  port ??= await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MARKET_MODE: "demo",
      OPEN_BROWSER: "0",
      PORT: String(port),
      AGENTI_DATA_DIR: dataDir,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const srv = {
    port,
    dataDir,
    child,
    exited,
    output: () => output,
    req: (method, urlPath, opts) => request(port, method, urlPath, opts),
    async waitReady(timeout = 15_000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (child.exitCode != null) throw new Error(`il server è uscito (${child.exitCode}):\n${output}`);
        try {
          const r = await request(port, "GET", "/healthz");
          if (r.status === 200) return;
        } catch {
          /* non ancora in ascolto */
        }
        await sleep(100);
      }
      throw new Error(`il server non risponde:\n${output}`);
    },
    async stop() {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
      return exited;
    },
  };
  if (wait) await srv.waitReady();
  return srv;
}
