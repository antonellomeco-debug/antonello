// Esegue un agente: modalità "llm" (istruzioni in linguaggio naturale + Claude con tool)
// oppure modalità "rule" (una strategia JavaScript nella cartella strategies/).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { STRATEGY_NAME } from "./config.js";
import { STRATEGIES_DIR } from "./paths.js";
import { getClient, hasCredentials, MISSING_KEY, friendlyError, responseText } from "./claude.js";
import { toolsFor, runTool, enabledTools } from "./tools.js";
import { log, bus, addUsage, costScope, countRun } from "./store.js";
import { getQuote, getHistory, symbolCatalog } from "./market.js";
import * as indicators from "./indicators.js";
import { readNotes, postNote } from "./store.js";
import { briefFor } from "./platform.js";
import { WRITING_RULES } from "./style.js";
import { portfolioFor, submitOrder, tradingTarget } from "./broker.js";
import { readableRooms, floorOfRoom } from "./building.js";
import { clockLine } from "./schedule.js";

const MAX_STEPS = 12;

/** Primo messaggio di ogni lavoro: giorno della settimana e ora italiana, poi l'eventuale compito. */
export function firstMessage(task, at = new Date()) {
  const clock = clockLine(at);
  return task ? `${clock}\n\n${task}` : `Esegui il tuo lavoro ora. ${clock}`;
}

const running = new Set();

export function isRunning(id) {
  return running.has(id);
}

function setStatus(agent, status, detail = "") {
  bus.emit("event", { type: "status", agentId: agent.id, status, detail });
}

export async function runAgent(agent, building, opts = {}) {
  // La spesa di questo lavoro (Claude, ricerche, immagini, post su X) si conta sull'agente e sul suo palazzo.
  const palace = building.floors.find((f) => f.id === floorOfRoom(building, agent.room))?.palace ?? null;
  return costScope.run({ agentId: agent.id, palace }, () => runAgentInner(agent, building, opts));
}

async function runAgentInner(agent, building, { task } = {}) {
  if (running.has(agent.id)) throw new Error(`${agent.name} è già al lavoro`);
  running.add(agent.id);
  setStatus(agent, "working");
  log(agent.id, "info", `▶ avvio (${agent.mode})${task ? `: ${task}` : ""}`);
  try {
    if (agent.mode !== "rule") countRun(agent.id);
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
  // Sui piani collegati a cTrader i dati vengono dal conto del piano (gli stessi prezzi degli ordini).
  const target = tradingTarget(agent);
  const accountId = target.mode === "ctrader" ? target.accountId : undefined;
  // Solo nomi semplici: niente percorsi verso file fuori dalla cartella strategies/.
  if (!STRATEGY_NAME.test(agent.strategy ?? "")) throw new Error(`strategia non valida: ${agent.strategy}`);
  const file = path.join(STRATEGIES_DIR, `${agent.strategy}.js`);
  const mod = await import(`${pathToFileURL(file).href}?v=${Date.now()}`); // ricarica a caldo
  const ctx = {
    agent,
    params: agent.params ?? {},
    market: {
      getQuote: (symbol) => getQuote(symbol, { accountId }),
      getHistory: (symbol, opts = {}) => getHistory(symbol, { accountId, ...opts }),
      symbols: () => symbolCatalog({ accountId }), // tutti i mercati del broker (null senza cTrader)
      indicators,
    },
    trading: target, // { mode: "paper" } oppure { mode: "ctrader", accountId, isLive, label }
    notes: {
      read: (room = agent.room, limit) => {
        if (!readable.has(room)) throw new Error(`${agent.name} non può leggere la stanza ${room} (piano non collegato?)`);
        return readNotes(room, limit);
      },
      post: (text, tags) => postNote(agent.room, agent, text, tags),
    },
    portfolio: () => portfolioFor(agent),
    order: (o) => submitOrder(agent, o),
    log: (msg) => log(agent.id, "info", msg),
  };
  return mod.default(ctx);
}

// ---------- modalità LLM ----------

/** Dove opera l'agente e come vanno espresse le quantità. */
function tradingContext(agent, building) {
  const t = tradingTarget(agent);
  const tools = enabledTools(agent);
  const approval = agent.limits.requireApproval === false ? "" : " Gli ordini vengono PROPOSTI all'utente, che li approva o scarta.";
  const lines = [];
  if (t.mode === "ctrader") {
    lines.push(`- Il tuo piano opera sul conto ${t.label}.${t.isLive ? " ATTENZIONE: è un conto con SOLDI VERI, sii prudente." : " È un conto demo (soldi finti) con prezzi reali del broker."}`);
    lines.push(`- Usa i nomi degli strumenti del broker (es. EURUSD, XAUUSD, US500)${tools.has("search_symbols") ? "; se non conosci il nome cercalo con search_symbols" : ""}.`);
    if (agent.canTrade) {
      lines.push(`- Con place_order indica lots (es. 0.01) e uno stop_loss_pct ragionevole.${approval}`);
      lines.push("- Su questo conto side \"sell\" APRE una nuova posizione in vendita: per uscire da una tua posizione usa close_position (positionId da get_portfolio).");
    }
  } else {
    lines.push("- Il portafoglio del tuo piano è SIMULATO (paper trading): i tuoi ordini non escono dal computer.");
    if (agent.canTrade) lines.push(`- Con place_order indica qty (numero di pezzi), entro i limiti di rischio; motiva sempre l'ordine.${approval}`);
  }
  const elsewhere = building.floors.filter((f) => f.trading?.mode === "ctrader" && f.id !== floorOfRoom(building, agent.room));
  if (elsewhere.length) {
    lines.push(`- Altri piani operano su conti cTrader: ${elsewhere.map((f) => f.name).join(", ")}${!agent.canTrade && tools.has("get_portfolio") ? " (get_portfolio mostra anche i loro conti)" : ""}.`);
  }
  if (tools.has("send_signal")) {
    lines.push("- Con send_signal mandi all'utente un segnale (comprare o vendere un'azione del suo portafoglio VERO, che compra e vende lui " +
      "con la sua banca): lo decide lui in ✅ Approvazioni. Solo segnali ben motivati, con stop loss, e nel rispetto del suo profilo (my_portfolio).");
  }
  if (!agent.canTrade) lines.push(`- Non puoi eseguire ordini: comunica le tue conclusioni con post_note${tools.has("send_signal") ? " (e i segnali con send_signal)" : ""}.`);
  return lines.join("\n");
}

/** Chi scrive testi che escono a nome dell'utente riceve anche le regole per scrivere come una persona. */
const WRITING_TOOLS = new Set(["social_publish", "create_motion_video", "create_video", "create_graphic", "weekly_report"]);

function systemPrompt(agent, building) {
  const room = building.rooms.find((r) => r.id === agent.room);
  const floor = building.floors.find((f) => f.id === floorOfRoom(building, agent.room));
  const palace = building.palaces?.find((p) => p.id === floor?.palace);
  const floorName = (id) => {
    const f = building.floors.find((x) => x.id === id);
    if (!f) return id;
    return f.palace && f.palace !== floor?.palace ? `${f.name}, palazzo ${building.palaces?.find((p) => p.id === f.palace)?.name ?? f.palace}` : f.name;
  };
  const visible = readableRooms(agent, building)
    .map((r) => `- ${r.id}: ${r.name} (${floorName(r.floor)}) — ${r.description}`)
    .join("\n");
  const where = palace
    ? `del palazzo "${palace.name}"${palace.description ? ` (${palace.description})` : ""}, in un universo virtuale di agenti AI che lavorano per l'utente`
    : "di un palazzo virtuale di agenti AI";
  const brief = briefFor(palace?.id ?? null);
  const writes = [...enabledTools(agent)].some((t) => WRITING_TOOLS.has(t));
  return `Sei "${agent.name}", un agente che lavora nella stanza "${room?.name ?? agent.room}" del piano "${floor?.name ?? "?"}"${floor?.sector ? ` (settore: ${floor.sector})` : ""} ${where}.
${brief ? `\nIL PROGETTO (brief comune a tutti gli agenti: tienilo sempre presente)\n${brief}\n` : ""}
IL TUO COMPITO
${agent.instructions}

CONTESTO
- Watchlist: ${agent.watchlist.join(", ") || "(nessuna)"}
- Stanze che puoi leggere con read_notes (anche di altri piani, se collegati al tuo):
${visible}
${tradingContext(agent, building)}
${writes ? `\n${WRITING_RULES}\n` : ""}
REGOLE
- Il primo messaggio indica il giorno della settimana, la data e l'ora italiana di adesso.
- Basati solo sui dati ottenuti con gli strumenti; se un dato ha source "demo" è simulato, dillo.
- Pubblica il risultato del tuo lavoro con post_note (sintetico, con ticker e numeri chiave).
- Lavori in autonomia: gli errori li correggi tu, un dato che non riesci a verificare lo togli, un post doppio o oltre il limite
  del giorno lo rimandi o lo scarti. All'utente scrivi (etichetta RICHIESTA) solo una domanda breve che solo lui può risolvere.
- Concludi con un breve riepilogo di cosa hai fatto.`;
}

/** Parametri di uno strumento per il registro: accorciati (una grafica SVG può essere lunghissima). */
const short = (input) => {
  const t = JSON.stringify(input) ?? "";
  return t.length > 400 ? `${t.slice(0, 400)}…` : t;
};

async function runLLM(agent, building, task) {
  if (!hasCredentials()) throw new Error(MISSING_KEY);
  const client = getClient();
  const tools = toolsFor(agent);
  const messages = [
    {
      role: "user",
      content: firstMessage(task),
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
      cache_control: { type: "ephemeral" }, // i passaggi successivi rileggono la conversazione a prezzo ridotto
      // Se il modello rifiuta una richiesta, l'API riprova su un modello di riserva.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    addUsage(agent.model, response.usage);
    if (response.stop_reason === "refusal") {
      throw new Error(`richiesta rifiutata dal modello (${response.stop_details?.category ?? "n/d"})`);
    }
    // Rimandiamo indietro l'intero contenuto (inclusi i blocchi di thinking e i risultati della ricerca web).
    messages.push({ role: "assistant", content: response.content });
    for (const b of response.content.filter((x) => x.type === "server_tool_use")) {
      setStatus(agent, "working", b.name);
      log(agent.id, "tool", `${b.name}(${short(b.input)})`);
    }
    // Ricerca web lunga: l'API si ferma ("pause_turn") e riprende se le rimandiamo la conversazione così com'è.
    if (response.stop_reason === "pause_turn") continue;

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      if (response.stop_reason === "max_tokens") log(agent.id, "warn", "risposta troncata (max_tokens)");
      return responseText(response.content);
    }

    const results = await Promise.all(
      toolUses.map(async (tu) => {
        setStatus(agent, "working", tu.name);
        try {
          const out = await runTool(agent, tu.name, tu.input ?? {}, building);
          log(agent.id, "tool", `${tu.name}(${short(tu.input)})`);
          // Alcuni strumenti (media_view) restituiscono blocchi pronti, per esempio una foto da guardare.
          return { type: "tool_result", tool_use_id: tu.id, content: Array.isArray(out?.toolContent) ? out.toolContent : JSON.stringify(out) };
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
