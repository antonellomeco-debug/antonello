// Esegue un agente: modalità "llm" (istruzioni in linguaggio naturale + Claude con tool)
// oppure modalità "rule" (una strategia JavaScript nella cartella strategies/).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { STRATEGY_NAME } from "./config.js";
import { STRATEGIES_DIR } from "./paths.js";
import { getClient, hasCredentials, MISSING_KEY, friendlyError } from "./claude.js";
import { toolsFor, runTool } from "./tools.js";
import { log, bus, addUsage } from "./store.js";
import { getQuote, getHistory } from "./market.js";
import * as indicators from "./indicators.js";
import { readNotes, postNote } from "./store.js";
import { portfolioValue, submitOrder } from "./broker.js";
import { readableRooms, floorOfRoom } from "./building.js";

const MAX_STEPS = 12;
const running = new Set();

export function isRunning(id) {
  return running.has(id);
}

function setStatus(agent, status, detail = "") {
  bus.emit("event", { type: "status", agentId: agent.id, status, detail });
}

export async function runAgent(agent, building, { task } = {}) {
  if (running.has(agent.id)) throw new Error(`${agent.name} è già al lavoro`);
  running.add(agent.id);
  setStatus(agent, "working");
  log(agent.id, "info", `▶ avvio (${agent.mode})${task ? `: ${task}` : ""}`);
  try {
    const result = agent.mode === "rule" ? await runRule(agent, building) : await runLLM(agent, building, task);
    log(agent.id, "info", `✔ completato${result ? `: ${String(result).slice(0, 500)}` : ""}`);
    setStatus(agent, "idle");
    return result;
  } catch (err) {
    const message = friendlyError(err);
    log(agent.id, "error", `✖ ${message}`);
    setStatus(agent, "error", message);
    throw new Error(message);
  } finally {
    running.delete(agent.id);
  }
}

// ---------- modalità regole ----------

async function runRule(agent, building) {
  const readable = new Set(readableRooms(agent, building).map((r) => r.id));
  // Solo nomi semplici: niente percorsi verso file fuori dalla cartella strategies/.
  if (!STRATEGY_NAME.test(agent.strategy ?? "")) throw new Error(`strategia non valida: ${agent.strategy}`);
  const file = path.join(STRATEGIES_DIR, `${agent.strategy}.js`);
  const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`); // ricarica a caldo
  const ctx = {
    agent,
    params: agent.params ?? {},
    market: { getQuote, getHistory, indicators },
    notes: {
      read: (room = agent.room, limit) => {
        if (!readable.has(room)) throw new Error(`${agent.name} non può leggere la stanza ${room} (piano non collegato?)`);
        return readNotes(room, limit);
      },
      post: (text, tags) => postNote(agent.room, agent, text, tags),
    },
    portfolio: portfolioValue,
    order: (o) => submitOrder(agent, o),
    log: (msg) => log(agent.id, "info", msg),
  };
  return mod.default(ctx);
}

// ---------- modalità LLM ----------

function systemPrompt(agent, building) {
  const room = building.rooms.find((r) => r.id === agent.room);
  const floor = building.floors.find((f) => f.id === floorOfRoom(building, agent.room));
  const floorName = (id) => building.floors.find((f) => f.id === id)?.name ?? id;
  const visible = readableRooms(agent, building)
    .map((r) => `- ${r.id}: ${r.name} (${floorName(r.floor)}) — ${r.description}`)
    .join("\n");
  return `Sei "${agent.name}", un agente che lavora nella stanza "${room?.name ?? agent.room}" del piano "${floor?.name ?? "?"}"${floor?.sector ? ` (settore: ${floor.sector})` : ""} di un palazzo virtuale di analisi dei mercati finanziari.

IL TUO COMPITO
${agent.instructions}

CONTESTO
- Watchlist: ${agent.watchlist.join(", ") || "(nessuna)"}
- Stanze che puoi leggere con read_notes (anche di altri piani, se collegati al tuo):
${visible}
- Il portafoglio è SIMULATO (paper trading): nessun ordine reale viene inviato.
${agent.canTrade ? `- Puoi usare place_order entro i limiti di rischio; motiva sempre l'ordine.${agent.limits.requireApproval === false ? "" : " Gli ordini vengono PROPOSTI all'utente, che li approva o scarta."}` : "- Non puoi eseguire ordini: comunica le tue conclusioni con post_note."}

REGOLE
- Basati solo sui dati ottenuti con gli strumenti; se un dato ha source "demo" è simulato, dillo.
- Pubblica il risultato del tuo lavoro con post_note (sintetico, con ticker e numeri chiave).
- Concludi con un breve riepilogo di cosa hai fatto.`;
}

async function runLLM(agent, building, task) {
  if (!hasCredentials()) throw new Error(MISSING_KEY);
  const client = getClient();
  const tools = toolsFor(agent);
  const messages = [
    {
      role: "user",
      content: task || `Esegui il tuo lavoro ora. Data di oggi: ${new Date().toISOString().slice(0, 10)}.`,
    },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: agent.model,
      max_tokens: 16000,
      system: systemPrompt(agent, building),
      tools,
      messages,
      output_config: { effort: agent.effort },
      // Se il modello rifiuta una richiesta, l'API riprova su un modello di riserva.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    addUsage(agent.model, response.usage);
    if (response.stop_reason === "refusal") {
      throw new Error(`richiesta rifiutata dal modello (${response.stop_details?.category ?? "n/d"})`);
    }
    // Rimandiamo indietro l'intero contenuto (inclusi i blocchi di thinking).
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      if (response.stop_reason === "max_tokens") log(agent.id, "warn", "risposta troncata (max_tokens)");
      return response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    }

    const results = await Promise.all(
      toolUses.map(async (tu) => {
        setStatus(agent, "working", tu.name);
        try {
          const out = await runTool(agent, tu.name, tu.input ?? {}, building);
          log(agent.id, "tool", `${tu.name}(${JSON.stringify(tu.input)})`);
          return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) };
        } catch (err) {
          log(agent.id, "warn", `${tu.name} fallito: ${err.message}`);
          return { type: "tool_result", tool_use_id: tu.id, content: err.message, is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  throw new Error(`superato il limite di ${MAX_STEPS} passi`);
}
