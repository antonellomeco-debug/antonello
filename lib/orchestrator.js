// Assistente "regista" con cui parli dal pannello "Parla con …": conosce tutto il palazzo,
// può far lavorare gli agenti, creare o modificare agenti, piani, stanze e collegamenti tra piani.
import { getClient, hasCredentials, MISSING_KEY, friendlyError } from "./claude.js";
import { ALL_TOOLS } from "./config.js";
import { floorConnections } from "./building.js";
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
let lastSnapshot = null; // ultimo stato del palazzo già inviato al modello

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
    name: "list_building",
    description: "Mostra il palazzo: piani (con settore e livello), stanze di ogni piano e collegamenti tra piani.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "save_floor",
    description:
      "Crea un nuovo piano (senza id) o modifica un piano esistente (con id). Ogni piano gestisce un settore " +
      "(es. Crypto, Materie prime, Azioni USA). level = altezza nel palazzo (0 = piano terra).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "solo per modificare un piano esistente" },
        name: { type: "string", description: "es. '2° Piano · Crypto'" },
        sector: { type: "string" },
        description: { type: "string" },
        color: { type: "string", description: "colore esadecimale, es. #2fb7c4 (facoltativo)" },
        level: { type: "integer" },
      },
    },
  },
  {
    name: "delete_floor",
    description: "Elimina un piano vuoto (prima vanno spostate o eliminate le sue stanze). Chiedi conferma all'utente prima di usarlo.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "save_room",
    description: "Crea una nuova stanza su un piano (senza id) o modifica/sposta una stanza esistente (con id).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "solo per modificare una stanza esistente" },
        floor: { type: "string", description: "id del piano" },
        name: { type: "string" },
        description: { type: "string" },
        color: { type: "string", description: "colore esadecimale (facoltativo)" },
      },
    },
  },
  {
    name: "delete_room",
    description: "Elimina una stanza vuota (prima vanno spostati o eliminati i suoi agenti). Chiedi conferma all'utente prima di usarlo.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "set_link",
    description:
      "Collega due piani o cambia il collegamento. direction 'both' = si leggono a vicenda; 'one-way' = le informazioni vanno " +
      "da 'from' a 'to' (gli agenti di 'to' leggono le bacheche di 'from'). active=false lo spegne senza cancellarlo.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        direction: { type: "string", enum: ["both", "one-way"] },
        active: { type: "boolean" },
      },
      required: ["from", "to", "direction", "active"],
    },
  },
  {
    name: "delete_link",
    description: "Elimina il collegamento tra due piani.",
    input_schema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
  {
    name: "save_agent",
    description:
      "Crea un nuovo agente o modifica uno esistente. Passa la configurazione COMPLETA. Campi: id (facoltativo per un nuovo agente: viene creato dal nome), name, avatar (emoji), room, " +
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

function describeBuilding(b, agents = []) {
  const floorName = (id) => b.floors.find((f) => f.id === id)?.name ?? id;
  return b.floors
    .slice()
    .reverse()
    .map((f) => {
      const rooms =
        b.rooms
          .filter((r) => r.floor === f.id)
          .map((r) => {
            const who = agents.filter((a) => a.room === r.id).map((a) => a.name);
            return `${r.name} [${r.id}]${who.length ? ` (${who.join(", ")})` : " (vuota)"}`;
          })
          .join(", ") || "nessuna stanza";
      const links = floorConnections(b, f.id)
        .map((c) => `${c.receives && c.sends ? "↔" : c.receives ? "← riceve da" : "→ invia a"} ${floorName(c.floor)}`)
        .join("; ");
      return `- ${f.name} [${f.id}] livello ${f.level}${f.sector ? `, settore ${f.sector}` : ""}: ${rooms}${links ? ` | collegamenti: ${links}` : " | nessun collegamento"}`;
    })
    .join("\n");
}

// Il prompt di sistema resta IDENTICO per tutta la conversazione: cambiarlo invaliderebbe la cronologia
// (e il ragionamento salvato) del modello. Lo stato del palazzo arriva invece come messaggio "system"
// aggiunto in coda alla conversazione, solo quando cambia.
const SYSTEM_PROMPT = `Sei ${ASSISTANT_NAME}, il regista di un palazzo virtuale di agenti AI che analizzano la borsa per l'utente.
Parli in italiano, in modo diretto e sintetico.

COME È FATTO IL PALAZZO
Il palazzo ha più piani; ogni piano gestisce un settore e contiene stanze, e in ogni stanza lavorano agenti.
Gli agenti leggono la propria stanza e le stanze del proprio piano indicate in readsFrom.
Due piani comunicano solo se sono collegati (collegamento attivo): allora gli agenti di un piano leggono tutte le bacheche dell'altro.
Un collegamento può essere nei due sensi ("both") o in un solo senso ("one-way": da 'from' verso 'to').

La situazione aggiornata del palazzo ti arriva in messaggi "Stato attuale del palazzo"; se hai dubbi usa list_building.

Cosa puoi fare:
- spiegare cosa stanno facendo gli agenti e riassumere le bacheche;
- far lavorare un agente (run_agent);
- creare o modificare piani (save_floor), stanze (save_room) e collegamenti tra piani (set_link, delete_link);
- creare o modificare agenti (save_agent): prima leggi la configurazione attuale con list_agents, poi salva quella completa;
- controllare portafoglio e ordini in attesa di approvazione.
Quando l'utente chiede di creare un piano per un settore, proponi anche le stanze e gli agenti adatti e creali se è d'accordo
(o se l'ha già chiesto). Dopo una modifica al palazzo, riassumi in breve cosa hai creato e come sono collegati i piani.
Prima di eliminare piani, stanze o agenti chiedi conferma all'utente.

Regole:
- Il portafoglio è SIMULATO. Non puoi approvare ordini: lo fa solo l'utente dal pannello Approvazioni.
- Quando crei o modifichi un agente con canTrade, lascia requireApproval a true salvo richiesta esplicita.
- Non inventare dati di mercato: usa gli strumenti. Se un dato ha source "demo", dillo.
- Non dare consigli finanziari personalizzati come certezze: presenta analisi e rischi.`;

async function runTool_(ctx, name, input) {
  switch (name) {
    case "list_agents":
      return {
        rooms: ctx.rooms().map((r) => ({ id: r.id, name: r.name, floor: r.floor })),
        agents: ctx.agents().map((a) => ({ ...a, running: isRunning(a.id) })),
      };
    case "list_building":
      return ctx.building();
    case "save_floor":
      return { saved: ctx.saveFloor(input) };
    case "delete_floor":
      ctx.deleteFloor(input.id);
      return { deleted: input.id };
    case "save_room":
      return { saved: ctx.saveRoom(input) };
    case "delete_room":
      ctx.deleteRoom(input.id);
      return { deleted: input.id };
    case "set_link":
      return { saved: ctx.setLink(input) };
    case "delete_link":
      ctx.deleteLink(input.from, input.to);
      return { deleted: true };
    case "run_agent": {
      const agent = ctx.agents().find((a) => a.id === input.id);
      if (!agent) throw new Error(`agente ${input.id} inesistente`);
      return { result: await runAgent(agent, ctx.building(), { task: input.task }) };
    }
    case "save_agent": {
      const agent = ctx.saveAgent(input.agent ?? {});
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
  lastSnapshot = null;
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
    lastSnapshot = null;
    pushTranscript("system", "Conversazione lunga: riparto da zero (bacheche e agenti restano invariati).");
  }
  pushTranscript("user", text);
  const start = messages.length; // in caso di errore si torna a questa cronologia valida
  messages.push({ role: "user", content: text });
  const snapshot = `Stato attuale del palazzo "${ctx.building().name}" (dal piano più alto):\n${describeBuilding(ctx.building(), ctx.agents())}`;
  if (snapshot !== lastSnapshot) {
    messages.push({ role: "system", content: snapshot }); // messaggio di sistema in coda: non modifica la cronologia
    lastSnapshot = snapshot;
  }
  bus.emit("event", { type: "chat-status", busy: true });

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
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
    lastSnapshot = null;
    throw new Error(message);
  } finally {
    busy = false;
    bus.emit("event", { type: "chat-status", busy: false });
  }
}
