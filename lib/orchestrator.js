// Assistente "regista" con cui parli dal pannello "Parla con …": conosce tutto l'ufficio,
// può far lavorare gli agenti, crearne di nuovi o modificarli, e riassumere cosa succede.
import { getClient, hasCredentials, MISSING_KEY, friendlyError } from "./claude.js";
import { normalize, validate, saveAgent, ALL_TOOLS } from "./config.js";
import { runAgent, isRunning } from "./runner.js";
import { getState, readNotes, bus, addUsage, log } from "./store.js";
import { portfolioValue } from "./broker.js";
import { runTool } from "./tools.js";

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME ?? "Orion";
const MODEL = process.env.ASSISTANT_MODEL ?? "claude-opus-5-5";
const MAX_STEPS = 15;
const MAX_HISTORY = 80; // oltre questa lunghezza la conversazione riparte da zero

let messages = []; // cronologia completa inviata al modello (append-only)
let transcript = []; // versione leggibile per l'interfaccia
let busy = false;

const TOOLS = [
  {
    name: "list_agents",
    description: "Elenca stanze e agenti con configurazione e stato.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "run_agent",
    description: "Fa lavorare subito un agente e restituisce il suo riepilogo. Puoi dargli un compito specifico.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, task: { type: "string", description: "compito specifico (facoltativo)" } },
      required: ["id"],
    },
  },
  {
    name: "save_agent",
    description:
      "Crea un nuovo agente o modifica uno esistente. Passa la configurazione COMPLETA. Campi: id, name, avatar (emoji), room, " +
      "mode ('llm' con instructions, oppure 'rule' con strategy+params), everyMinutes, watchlist, readsFrom, tools " +
      `(${ALL_TOOLS.join(", ")}), canTrade, limits {maxOrderPct, maxPositionPct, onlyWatchlist, requireApproval}, model, effort, enabled.`,
    input_schema: {
      type: "object",
      properties: { agent: { type: "object", description: "configurazione completa dell'agente" } },
      required: ["agent"],
    },
  },
  {
    name: "read_notes",
    description: "Legge la bacheca di una stanza.",
    input_schema: {
      type: "object",
      properties: { room: { type: "string" }, limit: { type: "integer" } },
      required: ["room"],
    },
  },
  {
    name: "get_portfolio",
    description: "Stato del portafoglio simulato.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_approvals",
    description: "Ordini proposti dagli agenti in attesa di approvazione dell'utente.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_indicators",
    description: "Indicatori tecnici di un titolo (SMA, RSI, volatilità, rendimenti).",
    input_schema: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
  },
];

function systemPrompt(ctx) {
  const rooms = ctx.rooms().map((r) => `- ${r.id}: ${r.name} — ${r.description}`).join("\n");
  return `Sei ${ASSISTANT_NAME}, il regista di un ufficio virtuale di agenti AI che analizzano la borsa per l'utente.
Parli in italiano, in modo diretto e sintetico.

Stanze dell'ufficio:
${rooms}

Cosa puoi fare:
- spiegare cosa stanno facendo gli agenti e riassumere le bacheche;
- far lavorare un agente (run_agent);
- creare o modificare agenti quando l'utente lo chiede (save_agent): prima leggi la configurazione attuale con list_agents, poi salva quella completa;
- controllare portafoglio e ordini in attesa di approvazione.

Regole:
- Il portafoglio è SIMULATO. Non puoi approvare ordini: lo fa solo l'utente dal pannello Approvazioni.
- Quando crei o modifichi un agente con canTrade, lascia requireApproval a true salvo richiesta esplicita.
- Non inventare dati di mercato: usa gli strumenti. Se un dato ha source "demo", dillo.
- Non dare consigli finanziari personalizzati come certezze: presenta analisi e rischi.`;
}

async function runTool_(ctx, name, input) {
  switch (name) {
    case "list_agents":
      return {
        rooms: ctx.rooms().map((r) => ({ id: r.id, name: r.name })),
        agents: ctx.agents().map((a) => ({ ...a, running: isRunning(a.id) })),
      };
    case "run_agent": {
      const agent = ctx.agents().find((a) => a.id === input.id);
      if (!agent) throw new Error(`agente ${input.id} inesistente`);
      return { result: await runAgent(agent, ctx.rooms(), { task: input.task }) };
    }
    case "save_agent": {
      const agent = normalize(input.agent ?? {});
      const errors = validate(agent, ctx.rooms());
      if (errors.length) throw new Error(`configurazione non valida: ${errors.join("; ")}`);
      saveAgent(agent);
      ctx.reload();
      log(agent.id, "info", `configurazione salvata da ${ASSISTANT_NAME}`);
      return { saved: agent };
    }
    case "read_notes":
      return readNotes(input.room, Math.min(input.limit ?? 10, 30));
    case "get_portfolio":
      return portfolioValue();
    case "list_approvals":
      return getState().approvals.filter((a) => a.status === "pending");
    case "get_indicators":
      return runTool({ tools: ["get_indicators"] }, "get_indicators", input);
    default:
      throw new Error(`tool sconosciuto ${name}`);
  }
}

function pushTranscript(role, text) {
  const entry = { at: new Date().toISOString(), role, text };
  transcript.push(entry);
  transcript = transcript.slice(-200);
  bus.emit("event", { type: "chat", entry });
}

export function getTranscript() {
  return { name: ASSISTANT_NAME, busy, transcript };
}

export function resetChat() {
  messages = [];
  transcript = [];
  bus.emit("event", { type: "chat-reset" });
}

export async function chat(ctx, text) {
  if (busy) throw new Error(`${ASSISTANT_NAME} sta ancora rispondendo`);
  if (!hasCredentials()) throw new Error(MISSING_KEY);
  busy = true;
  const client = getClient();
  if (messages.length > MAX_HISTORY) {
    messages = [];
    pushTranscript("system", "Conversazione lunga: riparto da zero (bacheche e agenti restano invariati).");
  }
  pushTranscript("user", text);
  const start = messages.length; // in caso di errore si torna a questa cronologia valida
  messages.push({ role: "user", content: text });
  bus.emit("event", { type: "chat-status", busy: true });

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: systemPrompt(ctx),
        tools: TOOLS,
        messages,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      addUsage(MODEL, response.usage);
      if (response.stop_reason === "refusal") {
        throw new Error("richiesta rifiutata dal modello");
      }
      messages.push({ role: "assistant", content: response.content });

      const said = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      const toolUses = response.content.filter((b) => b.type === "tool_use");
      if (said) pushTranscript("assistant", said);
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) return said;

      const results = [];
      for (const tu of toolUses) {
        pushTranscript("tool", `${tu.name}${tu.input?.id ? ` → ${tu.input.id}` : ""}`);
        try {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(await runTool_(ctx, tu.name, tu.input ?? {})) });
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: tu.id, content: err.message, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error("troppi passaggi, riprova con una richiesta più semplice");
  } catch (err) {
    const message = friendlyError(err);
    pushTranscript("system", `Errore: ${message}`);
    messages = messages.slice(0, start);
    throw new Error(message);
  } finally {
    busy = false;
    bus.emit("event", { type: "chat-status", busy: false });
  }
}
