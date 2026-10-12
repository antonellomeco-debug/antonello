// Una connessione con un server della cTrader Open API (demo o reale).
// TLS sulla porta 5035, messaggi protobuf con prefisso di lunghezza, risposte abbinate alle richieste
// tramite clientMsgId, heartbeat periodico e limite di velocità delle richieste.
import tls from "node:tls";
import net from "node:net";
import { EventEmitter } from "node:events";
import { encodeMessage, decodeMessage, frame, unframe } from "./protocol.js";

export const HOSTS = {
  demo: process.env.CTRADER_DEMO_HOST ?? "demo.ctraderapi.com",
  live: process.env.CTRADER_LIVE_HOST ?? "live.ctraderapi.com",
};
export const PORT = Number(process.env.CTRADER_PORT ?? 5035);
const USE_TLS = process.env.CTRADER_TLS !== "0"; // solo i test usano una connessione in chiaro

const HEARTBEAT_MS = 10_000;
const SILENCE_MS = 60_000; // nessun dato dal server per un minuto: connessione considerata persa
// Limiti prudenti (Spotware indica 50 richieste/s in generale e 5/s per i dati storici).
const LIMITS = { general: 30, historical: 4 };
const HISTORICAL = new Set(["ProtoOAGetTrendbarsReq", "ProtoOAGetTickDataReq"]);
const ERROR_MESSAGES = new Set(["ProtoOAErrorRes", "ProtoErrorRes", "ProtoOAOrderErrorEvent"]);

export class CTraderError extends Error {
  constructor({ errorCode, description, retryAfter, maintenanceEndTimestamp }, request) {
    super(description ? `${errorCode}: ${description}` : String(errorCode));
    this.code = errorCode;
    this.description = description;
    this.retryAfter = retryAfter;
    this.maintenanceEnd = maintenanceEndTimestamp;
    this.request = request;
  }
}

let msgCounter = 0;

export class Connection extends EventEmitter {
  constructor(env) {
    super();
    this.env = env; // "demo" | "live"
    this.host = HOSTS[env];
    this.port = PORT;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map(); // clientMsgId -> { resolve, reject, timer, name }
    this.sent = { general: [], historical: [] }; // istanti degli ultimi invii (finestra di 1 s)
    this.queue = Promise.resolve();
    this.state = "closed"; // closed | connecting | open
  }

  connect() {
    if (this.state === "open") return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.state = "connecting";
    this.connecting = new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port };
      const socket = USE_TLS ? tls.connect({ ...opts, servername: this.host }) : net.connect(opts);
      const onError = (err) => {
        cleanup();
        this.state = "closed";
        reject(new Error(`Impossibile collegarsi a cTrader (${this.host}): ${err.message}`));
      };
      const cleanup = () => {
        socket.off("error", onError);
        this.connecting = null;
      };
      socket.once(USE_TLS ? "secureConnect" : "connect", () => {
        cleanup();
        this.socket = socket;
        this.state = "open";
        this.lastReceived = Date.now();
        this.lastSent = Date.now();
        socket.setNoDelay(true);
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("close", () => this.onClose("connessione chiusa"));
        socket.on("error", (err) => this.emit("warning", err));
        this.timer = setInterval(() => this.tick(), 2000);
        this.emit("open");
        resolve();
      });
      socket.once("error", onError);
      socket.setTimeout(15_000, () => socket.destroy(new Error("tempo scaduto")));
      socket.once(USE_TLS ? "secureConnect" : "connect", () => socket.setTimeout(0));
    });
    return this.connecting;
  }

  close() {
    this.socket?.destroy();
  }

  onClose(reason) {
    if (this.state === "closed") return;
    this.state = "closed";
    clearInterval(this.timer);
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Connessione con cTrader interrotta (${reason})`));
    }
    this.pending.clear();
    this.emit("close", reason);
  }

  tick() {
    const now = Date.now();
    if (now - this.lastReceived > SILENCE_MS) {
      this.socket?.destroy(new Error("il server non risponde"));
      return;
    }
    if (now - this.lastSent > HEARTBEAT_MS) this.write("ProtoHeartbeatEvent", {});
  }

  write(name, fields, clientMsgId) {
    if (!this.socket) throw new Error("Connessione con cTrader non aperta");
    this.socket.write(frame(encodeMessage(name, fields, clientMsgId)));
    this.lastSent = Date.now();
  }

  onData(chunk) {
    this.lastReceived = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let parsed;
    try {
      parsed = unframe(this.buffer);
    } catch (err) {
      this.socket?.destroy(err);
      return;
    }
    this.buffer = parsed.rest;
    for (const bytes of parsed.messages) {
      let msg;
      try {
        msg = decodeMessage(bytes);
      } catch (err) {
        this.emit("warning", err);
        continue;
      }
      if (msg.name === "ProtoHeartbeatEvent") {
        continue; // il nostro heartbeat periodico basta a tenere viva la connessione
      }
      const waiting = msg.clientMsgId && this.pending.get(msg.clientMsgId);
      if (waiting) {
        this.pending.delete(msg.clientMsgId);
        clearTimeout(waiting.timer);
        if (ERROR_MESSAGES.has(msg.name)) waiting.reject(new CTraderError(msg.data, waiting.name));
        else waiting.resolve(msg);
      }
      this.emit("message", msg); // anche le risposte vengono notificate (es. eventi di esecuzione)
    }
  }

  /** Aspetta il proprio turno per rispettare i limiti di velocità. */
  async throttle(kind) {
    const limit = LIMITS[kind];
    const list = this.sent[kind];
    for (;;) {
      const now = Date.now();
      while (list.length && now - list[0] >= 1000) list.shift();
      if (list.length < limit) {
        list.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000 - (now - list[0]) + 5));
    }
  }

  /** Invia una richiesta e aspetta la risposta con lo stesso clientMsgId. */
  async request(name, fields = {}, { timeoutMs = 20_000 } = {}) {
    await this.connect();
    // Una richiesta alla volta passa dal controllo di velocità (le risposte arrivano in parallelo).
    const turn = this.queue.then(() => this.throttle(HISTORICAL.has(name) ? "historical" : "general"));
    this.queue = turn.catch(() => {});
    await turn;
    const clientMsgId = `m${++msgCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(clientMsgId);
        reject(new Error(`cTrader non ha risposto in tempo (${name})`));
      }, timeoutMs);
      this.pending.set(clientMsgId, { resolve, reject, timer, name });
      try {
        this.write(name, fields, clientMsgId);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(clientMsgId);
        reject(err);
      }
    });
  }
}
