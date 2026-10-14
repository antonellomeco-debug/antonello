// Assistente "regista" con cui parli dal pannello "Parla con …": conosce tutto il palazzo,
// può far lavorare gli agenti, creare o modificare agenti, piani, stanze e collegamenti tra piani.
import { getClient, hasCredentials, MISSING_KEY, friendlyError, responseText } from "./claude.js";
import { ALL_TOOLS } from "./config.js";
import { floorConnections } from "./building.js";
import { runAgent, isRunning } from "./runner.js";
import { getState, readNotes, bus, addUsage, log } from "./store.js";
import { portfolioValue } from "./broker.js";
import { runTool, CALENDAR_SCHEMA, CALENDAR_DESCRIPTION, WEB_SEARCH_TOOL } from "./tools.js";
import { calendarFor } from "./calendar.js";
import * as ctrader from "./ctrader/service.js";
import { getSafety } from "./safety.js";
import { clockLine } from "./schedule.js";

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME ?? "Orion";
const MODEL = process.env.ASSISTANT_MODEL ?? "claude-opus-5-5";
const MAX_STEPS = 15;
const MAX_INPUT_TOKENS = 300_000; // oltre questa dimensione la conversazione riparte (con un riassunto)

let messages = []; // cronologia completa inviata al modello (append-only)
let transcript = []; // versione leggibile per l'interfaccia
let busy = false;
let lastSnapshot = null; // ultimo stato del palazzo già inviato al modello
let lastInputTokens = 0; // dimensione della conversazione all'ultima richiesta

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
    name: "delete_agent",
    description: "Elimina un agente. Chiedi SEMPRE conferma all'utente prima di usarlo.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
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
    description: "Stato del portafoglio simulato (usato dai piani non collegati a cTrader).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_broker_status",
    description:
      "Stato del collegamento con il broker cTrader: conti disponibili (demo o REALE), conto usato per i dati, " +
      "su quale conto opera ogni piano, STOP e limiti di sicurezza. Con accountId mostra anche saldo e posizioni di quel conto.",
    input_schema: { type: "object", properties: { accountId: { type: "integer", description: "facoltativo" } } },
  },
  {
    name: "set_floor_trading",
    description:
      "Decide dove operano gli agenti di un piano: mode 'paper' = portafoglio simulato; mode 'ctrader' = un conto DEMO di cTrader " +
      "(accountId da get_broker_status). I conti REALI può collegarli solo l'utente dalla sezione Broker.",
    input_schema: {
      type: "object",
      properties: {
        floor: { type: "string", description: "id del piano" },
        mode: { type: "string", enum: ["paper", "ctrader"] },
        accountId: { type: "integer", description: "solo con mode 'ctrader'" },
      },
      required: ["floor", "mode"],
    },
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
  {
    name: "get_calendar",
    description: CALENDAR_DESCRIPTION,
    input_schema: CALENDAR_SCHEMA,
  },
  WEB_SEARCH_TOOL, // eseguita dai server di Claude
];

function describeBuilding(b, agents = []) {
  const floorName = (id) => b.floors.find((f) => f.id === id)?.name ?? id;
  const floorsText = b.floors
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
      return `- ${f.name} [${f.id}] livello ${f.level}${f.sector ? `, settore ${f.sector}` : ""}: ${rooms}${links ? ` | riceve/invia: ${links}` : " | non comunica con altri piani"}`;
    })
    .join("\n");
  // Elenco esatto dei collegamenti (anche quelli spenti), con i valori da usare in set_link.
  const linkList = b.links.length
    ? b.links
        .map((l) => `- from=${l.from} to=${l.to} direction=${l.direction} active=${l.active} (${floorName(l.from)} ${l.direction === "both" ? "↔" : "→"} ${floorName(l.to)}${l.active ? "" : ", SPENTO"})`)
        .join("\n")
    : "- nessuno";
  return `${floorsText}\nCollegamenti:\n${linkList}`;
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
Ogni messaggio dell'utente inizia, tra parentesi quadre, con il giorno e l'ora italiana del momento in cui lo scrive.
Gli agenti ricevono anche loro giorno e ora all'inizio di ogni lavoro; quelli programmati lavorano solo nell'orario
di lavoro scelto dall'utente in ⚙️ Impostazioni (fuori orario puoi comunque farli lavorare con run_agent).

Cosa puoi fare:
- spiegare cosa stanno facendo gli agenti e riassumere le bacheche;
- far lavorare un agente (run_agent);
- creare o modificare piani (save_floor), stanze (save_room) e collegamenti tra piani (set_link, delete_link);
- creare, modificare o eliminare agenti (save_agent, delete_agent): prima leggi la configurazione attuale con list_agents, poi salva quella completa;
- controllare portafoglio e ordini in attesa di approvazione;
- leggere il calendario economico con orari italiani, previsioni e dati usciti (get_calendar); gli agenti possono
  averlo tra i loro strumenti (tool "get_calendar");
- cercare su internet notizie e informazioni aggiornate (web_search, con le fonti); anche gli agenti possono averla
  tra i loro strumenti (tool "web_search": costa 10 $ ogni 1.000 ricerche, più i token dei risultati);
- vedere il collegamento con il broker cTrader (get_broker_status) e far operare un piano sul portafoglio simulato
  o su un conto DEMO (set_floor_trading).
Quando l'utente chiede di creare un piano per un settore, proponi anche le stanze e gli agenti adatti e creali se è d'accordo
(o se l'ha già chiesto). Dopo una modifica al palazzo, riassumi in breve cosa hai creato e come sono collegati i piani.
Prima di eliminare piani, stanze o agenti (delete_floor, delete_room, delete_agent) chiedi conferma all'utente.

Regole:
- Ogni piano opera sul portafoglio SIMULATO oppure su un conto cTrader (demo o reale): controlla con get_broker_status.
  Non puoi approvare ordini (lo fa solo l'utente dal pannello Approvazioni), né collegare conti REALI, né cambiare
  STOP e limiti di sicurezza: se servono, spiega all'utente come farlo dalla sezione 🔌 Broker.
- Sui conti cTrader gli ordini si danno in lotti (lots) e con uno stop loss; i nomi degli strumenti sono quelli del broker.
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
    case "delete_agent":
      if (isRunning(input.id)) throw new Error("l'agente sta lavorando: riprova quando ha finito");
      if (!ctx.agents().some((a) => a.id === input.id)) throw new Error(`agente ${input.id} inesistente`);
      ctx.deleteAgent(input.id);
      return { deleted: input.id };
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
    case "get_broker_status":
      return brokerStatus(ctx, input.accountId);
    case "set_floor_trading": {
      const trading = input.mode === "ctrader" ? { mode: "ctrader", accountId: input.accountId } : { mode: "paper" };
      return { saved: ctx.setFloorTrading(input.floor, trading, { source: ASSISTANT_NAME }) };
    }
    case "list_approvals":
      return getState().approvals.filter((a) => a.status === "pending");
    case "get_indicators":
      return runTool({ tools: ["get_indicators"] }, "get_indicators", input);
    case "get_calendar":
      return calendarFor(input);
    default:
      throw new Error(`tool sconosciuto ${name}`);
  }
}

/** Stato del broker per Orion: niente chiavi né token. */
async function brokerStatus(ctx, accountId) {
  const st = ctrader.status();
  const safety = getSafety();
  const out = {
    linked: st.linked,
    accounts: st.accounts.map((a) => ({ accountId: a.ctidTraderAccountId, type: a.isLive ? "REALE" : "demo", login: a.traderLogin, broker: a.broker })),
    dataAccountId: st.dataAccountId,
    floors: ctx.building().floors.map((f) => ({ id: f.id, name: f.name, trading: f.trading ?? { mode: "paper" } })),
    safety: { stop: safety.killSwitch, liveEnabled: safety.liveEnabled, limits: safety.limits },
  };
  if (!st.linked) out.note = "cTrader non è collegato: l'utente lo collega dalla sezione 🔌 Broker.";
  if (accountId) {
    const [info, positions] = await Promise.all([ctrader.accountInfo(accountId), ctrader.positions(accountId)]);
    out.account = { ...info, positions };
  }
  return out;
}

function pushTranscript(role, text, extra) {
  const entry = { at: new Date().toISOString(), role, text, ...extra };
  transcript.push(entry);
  transcript = transcript.slice(-200);
  bus.emit("event", { type: "chat", entry });
}

export const isChatBusy = () => busy;

export function getTranscript() {
  return { name: ASSISTANT_NAME, busy, transcript };
}

export function resetChat() {
  if (busy) throw new Error(`${ASSISTANT_NAME} sta ancora lavorando: aspetta che finisca e riprova.`);
  messages = [];
  lastSnapshot = null;
  lastInputTokens = 0;
  transcript = [];
  bus.emit("event", { type: "chat-reset" });
}

/** Ultime battute della conversazione, da portare in quella nuova quando la vecchia diventa troppo lunga. */
function recap() {
  const last = transcript.filter((m) => m.role === "user" || m.role === "assistant").slice(-6);
  if (!last.length) return "";
  return (
    "Riepilogo delle ultime battute (la conversazione precedente è stata riavviata perché troppo lunga):\n" +
    last.map((m) => `${m.role === "user" ? "Utente" : ASSISTANT_NAME}: ${m.text.slice(0, 800)}`).join("\n") +
    "\n\nNuovo messaggio dell'utente:\n"
  );
}

const INTERRUPTED =
  "Non eseguito: la risposta è stata interrotta perché troppo lunga. Fai meno operazioni per volta e riprova.";

// Davanti ai messaggi vocali, per Orion: il testo viene da una trascrizione automatica.
const VOICE_NOTE =
  "(Messaggio vocale trascritto in automatico: può contenere errori di trascrizione, soprattutto in nomi, numeri e " +
  "termini inglesi. Se qualcosa di importante non è chiaro, chiedi conferma prima di agire.)";

/** Un messaggio dell'utente a Orion. Con { voice: true } è un messaggio vocale già trascritto. */
export async function chat(ctx, text, { voice = false } = {}) {
  if (busy) throw new Error(`${ASSISTANT_NAME} sta ancora rispondendo`);
  if (!hasCredentials()) throw new Error(MISSING_KEY);
  busy = true;
  const client = getClient();
  let prefix = "";
  if (lastInputTokens > MAX_INPUT_TOKENS) {
    prefix = recap();
    messages = [];
    lastSnapshot = null;
    lastInputTokens = 0;
    pushTranscript("system", "Conversazione molto lunga: riparto da capo tenendo un riassunto (palazzo e agenti restano invariati).");
  }
  pushTranscript("user", text, voice ? { voice: true } : undefined);
  const start = messages.length; // in caso di errore si torna a questa cronologia valida
  let lastGood = start; // fin qui la cronologia è completa (ultimo giro di strumenti concluso)
  messages.push({ role: "user", content: `${prefix}[${clockLine()}]\n${voice ? `${VOICE_NOTE}\n` : ""}${text}` });
  const snapshot = `Stato attuale del palazzo "${ctx.building().name}" (dal piano più alto):\n${describeBuilding(ctx.building(), ctx.agents())}`;
  const previousSnapshot = lastSnapshot;
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
        cache_control: { type: "ephemeral" }, // la parte già vista della conversazione costa molto meno
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      addUsage(MODEL, response.usage);
      const u = response.usage ?? {};
      lastInputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (response.stop_reason === "refusal") {
        throw new Error("richiesta rifiutata dal modello");
      }
      messages.push({ role: "assistant", content: response.content });

      const said = responseText(response.content);
      const toolUses = response.content.filter((b) => b.type === "tool_use");
      if (said) pushTranscript("assistant", said);
      for (const b of response.content.filter((x) => x.type === "server_tool_use")) {
        pushTranscript("tool", `${b.name}${b.input?.query ? ` → ${b.input.query}` : ""}`);
      }
      // Ricerca web lunga: si riprende rimandando la conversazione così com'è (il giro non è ancora concluso,
      // quindi lastGood resta all'ultimo giro completo).
      if (response.stop_reason === "pause_turn") continue;
      if (toolUses.length === 0) return said;

      if (response.stop_reason !== "tool_use") {
        // Risposta interrotta (troppo lunga) con strumenti a metà: ogni richiesta di strumento deve avere
        // una risposta, altrimenti la conversazione non è più valida.
        messages.push({ role: "user", content: toolUses.map((tu) => ({ type: "tool_result", tool_use_id: tu.id, content: INTERRUPTED, is_error: true })) });
        lastGood = messages.length;
        continue;
      }

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
      lastGood = messages.length;
    }
    throw new Error("troppi passaggi in una volta: scrivimi «continua» e riprendo da dove sono arrivato");
  } catch (err) {
    const message = friendlyError(err);
    pushTranscript("system", `Errore: ${message}`);
    if (err?.status === 400 && /signature|thinking|tool_use|tool_result|prefix/i.test(String(err.message))) {
      // La cronologia non è più accettata dal modello: si riparte da zero invece di restare bloccati.
      messages = [];
      lastSnapshot = null;
      pushTranscript("system", "Ho dovuto ricominciare la conversazione da capo: ripeti pure la richiesta.");
    } else if (lastGood > start && err?.status !== 400) {
      // Alcune operazioni sono già state fatte: tengo la cronologia fino all'ultimo giro concluso,
      // così con «continua» Orion sa cosa ha già creato.
      messages = messages.slice(0, lastGood);
    } else {
      messages = messages.slice(0, start);
      lastSnapshot = previousSnapshot;
    }
    throw new Error(message);
  } finally {
    busy = false;
    bus.emit("event", { type: "chat-status", busy: false });
  }
}
