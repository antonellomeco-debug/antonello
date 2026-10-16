// Assistente "regista" con cui parli dal pannello "Parla con …": conosce tutto l'universo (i palazzi con i loro
// piani), può far lavorare gli agenti, creare o modificare agenti, palazzi, piani, stanze e collegamenti tra piani.
import { getClient, hasCredentials, MISSING_KEY, friendlyError, responseText } from "./claude.js";
import { ALL_TOOLS } from "./config.js";
import { floorConnections } from "./building.js";
import { runAgent, isRunning } from "./runner.js";
import { getState, readNotes, bus, addUsage, log, costScope } from "./store.js";
import { costReport, setPalacePace, PACES } from "./costs.js";
import { portfolioValue } from "./broker.js";
import { runTool, CALENDAR_SCHEMA, CALENDAR_DESCRIPTION, WEB_SEARCH_TOOL } from "./tools.js";
import { calendarFor } from "./calendar.js";
import * as ctrader from "./ctrader/service.js";
import { getSafety } from "./safety.js";
import { clockLine } from "./schedule.js";
import { statusForAgents as socialStatusForAgents } from "./social/index.js";
import { listMedia } from "./social/media.js";
import { getSettings, updateSettings } from "./settings.js";

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME ?? "Orion";
// Velocità di Orion (⚙️ Impostazioni): modello e impegno nel ragionare. ASSISTANT_MODEL fissa il modello a mano.
export const SPEEDS = {
  veloce: { model: "claude-sonnet-5-5", effort: "low", label: "Veloce" },
  equilibrato: { model: "claude-opus-5-5", effort: "low", label: "Equilibrato" },
  accurato: { model: "claude-opus-5-5", effort: "medium", label: "Accurato" },
};
const DEFAULT_SPEED = "veloce";
export const getSpeed = () => (SPEEDS[getSettings().orionSpeed] ? getSettings().orionSpeed : DEFAULT_SPEED);
export function setSpeed(speed) {
  if (!SPEEDS[speed]) throw new Error(`Velocità: ${Object.keys(SPEEDS).join(", ")}`);
  updateSettings({ orionSpeed: speed });
  return { speed };
}
function modelConfig() {
  const sp = SPEEDS[getSpeed()];
  return { model: process.env.ASSISTANT_MODEL ?? sp.model, effort: sp.effort };
}
const MAX_STEPS = 15;
// Oltre questa dimensione la conversazione riparte (con un riassunto): una conversazione lunga rende ogni risposta
// più lenta, soprattutto dopo una pausa, quando la parte già letta non è più in memoria (cache).
const MAX_INPUT_TOKENS = 120_000;
// La parte già vista della conversazione resta in memoria un'ora (le pause tra un messaggio e l'altro sono spesso
// più lunghe dei 5 minuti normali): si rilegge molto più in fretta e costa un decimo.
const CACHE = { type: "ephemeral", ttl: "1h" };

let messages = []; // cronologia completa inviata al modello (append-only)
let transcript = []; // versione leggibile per l'interfaccia
let busy = false;
let lastSnapshot = null; // ultimo stato del palazzo già inviato al modello
let lastInputTokens = 0; // dimensione della conversazione all'ultima richiesta

const TOOLS = [
  {
    name: "list_agents",
    description:
      "Elenco BREVE di stanze e agenti: configurazione e stato, ma delle istruzioni solo l'inizio. Filtri facoltativi " +
      "palace, floor, room (id). Per le istruzioni complete di qualche agente usa get_agents.",
    input_schema: {
      type: "object",
      properties: {
        palace: { type: "string", description: "id del palazzo (facoltativo)" },
        floor: { type: "string", description: "id del piano (facoltativo)" },
        room: { type: "string", description: "id della stanza (facoltativo)" },
      },
    },
  },
  {
    name: "get_agents",
    description: "Configurazione COMPLETA (istruzioni comprese) di alcuni agenti, al massimo 10 per volta. Usala solo quando ti servono le istruzioni intere, per esempio per riscriverle.",
    input_schema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" }, description: "id degli agenti" } },
      required: ["ids"],
    },
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
    description: "Mostra l'universo: palazzi, i loro piani (con settore e livello), stanze di ogni piano e collegamenti tra piani.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "save_palace",
    description:
      "Crea un nuovo palazzo dell'universo (senza id) o rinomina/modifica un palazzo esistente (con id). Ogni palazzo è " +
      "un settore diverso della vita dell'utente (es. Investimenti, Social, Ricerche) e ha i suoi piani.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "solo per modificare un palazzo esistente" },
        name: { type: "string", description: "es. 'Palazzo Social'" },
        description: { type: "string", description: "di cosa si occupa il palazzo" },
        color: { type: "string", description: "colore esadecimale, es. #f06292 (facoltativo)" },
      },
    },
  },
  {
    name: "delete_palace",
    description: "Elimina un palazzo vuoto (prima vanno spostati o eliminati i suoi piani). Chiedi conferma all'utente prima di usarlo.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "save_floor",
    description:
      "Crea un nuovo piano (senza id) o modifica/sposta un piano esistente (con id). Ogni piano sta in un palazzo e gestisce " +
      "un settore (es. Crypto, Materie prime, Instagram). level = altezza nel suo palazzo (0 = piano terra).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "solo per modificare un piano esistente" },
        palace: { type: "string", description: "id del palazzo (obbligatorio per un piano nuovo quando ci sono più palazzi; per spostare un piano basta cambiarlo)" },
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
      "Collega due piani (anche di palazzi diversi: è così che i palazzi comunicano) o cambia il collegamento. direction " +
      "'both' = si leggono a vicenda; 'one-way' = le informazioni vanno da 'from' a 'to' (gli agenti di 'to' leggono le " +
      "bacheche di 'from'). active=false lo spegne senza cancellarlo.",
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
      "Crea un nuovo agente (configurazione completa) o modifica uno esistente: per modificarlo basta id e i SOLI campi da " +
      "cambiare (gli altri restano come sono; limits si unisce a quelli attuali). Campi: id (facoltativo per un nuovo agente: viene creato dal nome), name, avatar (emoji), room, " +
      "mode ('llm' con instructions, oppure 'rule' con strategy+params), everyMinutes, watchlist, readsFrom, tools " +
      `(${ALL_TOOLS.join(", ")}), canTrade, limits {maxOrderPct, maxPositionPct, onlyWatchlist, requireApproval}, model, effort, enabled, ` +
      "onlyOnNews (true = lavora solo se nelle stanze che legge ci sono note nuove: risparmia).",
    input_schema: {
      type: "object",
      properties: { agent: { type: "object", description: "nuovo agente: configurazione completa; agente esistente: id e campi da cambiare" } },
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
  {
    name: "get_costs",
    description:
      "Spesa del mese: totale, oggi, stima a fine mese, budget, spesa e ritmo di ogni palazzo, e gli agenti dal più costoso " +
      "(modello, ogni quanti minuti lavora, costo medio di un lavoro, stima al mese, consigli per risparmiare).",
    input_schema: { type: "object", properties: { top: { type: "integer", description: "quanti agenti elencare (default 15)" } } },
  },
  {
    name: "set_palace_pace",
    description:
      "Ritmo di un palazzo: normale, risparmio (gli agenti programmati lavorano la metà delle volte), minimo (un quarto) " +
      "o pausa (nessun lavoro programmato; a mano si possono ancora far lavorare). I budget li cambia solo l'utente da 💰 Spesa.",
    input_schema: {
      type: "object",
      properties: { palace: { type: "string", description: "id del palazzo" }, pace: { type: "string", enum: Object.keys(PACES) } },
      required: ["palace", "pace"],
    },
  },
  {
    name: "social_status",
    description:
      "Social collegati dall'utente (Instagram, Threads, LinkedIn, X): account, pubblicazione automatica o con approvazione, " +
      "post di oggi e massimo al giorno, ultimi post. Le immagini con l'IA (generate_image) sono attive solo con la chiave di Gemini.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "media_list",
    description: "Archivio di foto e video per i social (caricati dall'utente, grafiche e immagini IA degli agenti).",
    input_schema: { type: "object", properties: { kind: { type: "string", enum: ["image", "video", "audio"] }, limit: { type: "integer" } } },
  },
  WEB_SEARCH_TOOL, // eseguita dai server di Claude
];

function describeBuilding(b, agents = []) {
  const palaceName = (id) => b.palaces.find((p) => p.id === id)?.name ?? id;
  const floorName = (id) => {
    const f = b.floors.find((x) => x.id === id);
    return f ? `${f.name} (${palaceName(f.palace)})` : id;
  };
  const floorLine = (f) => {
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
    return `  - ${f.name} [${f.id}] livello ${f.level}${f.sector ? `, settore ${f.sector}` : ""}: ${rooms}${links ? ` | riceve/invia: ${links}` : " | non comunica con altri piani"}`;
  };
  const floorsText = b.palaces
    .map((p) => {
      const floors = b.floors.filter((f) => f.palace === p.id).slice().reverse();
      return `Palazzo ${p.name} [${p.id}]${p.description ? ` — ${p.description}` : ""}:\n${floors.map(floorLine).join("\n") || "  - nessun piano"}`;
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
const SYSTEM_PROMPT = `Sei ${ASSISTANT_NAME}, il regista di un universo virtuale di agenti AI che lavorano per l'utente.
Parli in italiano, in modo diretto e sintetico.

COME È FATTO L'UNIVERSO
L'universo contiene più palazzi; ogni palazzo è un settore diverso (per esempio Investimenti per analizzare i mercati e fare
trading, Social, Ricerche). Ogni palazzo ha più piani; ogni piano gestisce un argomento e contiene stanze, e in ogni stanza
lavorano agenti. Tu sei il regista di tutti i palazzi.
Gli agenti leggono la propria stanza e le stanze del proprio piano indicate in readsFrom.
Due piani comunicano solo se sono collegati (collegamento attivo): allora gli agenti di un piano leggono tutte le bacheche dell'altro.
I piani di palazzi diversi si collegano allo stesso modo: è così che i palazzi si scambiano le informazioni.
Un collegamento può essere nei due sensi ("both") o in un solo senso ("one-way": da 'from' verso 'to').

La situazione aggiornata ti arriva in messaggi "Stato attuale dell'universo"; se hai dubbi usa list_building.
Ogni messaggio dell'utente inizia, tra parentesi quadre, con il giorno e l'ora italiana del momento in cui lo scrive.
Gli agenti ricevono anche loro giorno e ora all'inizio di ogni lavoro; quelli programmati lavorano solo nell'orario
di lavoro scelto dall'utente in ⚙️ Impostazioni (fuori orario puoi comunque farli lavorare con run_agent).

Cosa puoi fare:
- spiegare cosa stanno facendo gli agenti e riassumere le bacheche;
- far lavorare un agente (run_agent);
- creare o modificare palazzi (save_palace), piani (save_floor, indicando il palazzo), stanze (save_room) e collegamenti
  tra piani, anche di palazzi diversi (set_link, delete_link);
- creare, modificare o eliminare agenti (save_agent, delete_agent). Per modificare un agente passa a save_agent solo id e i
  campi da cambiare (per esempio model, everyMinutes o una nuova versione di instructions): non serve rimandare il resto.
  list_agents dà l'elenco breve (anche di un solo palazzo, piano o stanza); get_agents le istruzioni complete, solo quando
  ti servono davvero (ogni testo letto si paga);
- controllare portafoglio e ordini in attesa di approvazione;
- leggere il calendario economico con orari italiani, previsioni e dati usciti (get_calendar); gli agenti possono
  averlo tra i loro strumenti (tool "get_calendar");
- cercare su internet notizie e informazioni aggiornate (web_search, con le fonti); anche gli agenti possono averla
  tra i loro strumenti (tool "web_search": costa 10 $ ogni 1.000 ricerche, più i token dei risultati);
- vedere il collegamento con il broker cTrader (get_broker_status) e far operare un piano sul portafoglio simulato
  o su un conto DEMO (set_floor_trading).
Quando l'utente chiede di creare un palazzo o un piano per un settore, proponi anche piani, stanze e agenti adatti e creali se
è d'accordo (o se l'ha già chiesto); proponi anche i collegamenti utili verso gli altri palazzi. Dopo una modifica, riassumi in
breve cosa hai creato e come sono collegati.
Prima di eliminare palazzi, piani, stanze o agenti (delete_palace, delete_floor, delete_room, delete_agent) chiedi conferma all'utente.
Social: l'utente può collegare i suoi account Instagram, Threads, LinkedIn e X dalla sezione 📣 Social (lo fa solo lui:
tu non puoi collegarli né scegliere la pubblicazione automatica). Un social non collegato funziona lo stesso «a mano»: i
post degli agenti vanno in Approvazioni e l'utente li pubblica con un tocco (📲 Condividi), ma senza risposte ai commenti,
thread né statistiche. Controlla con social_status. Gli strumenti per gli agenti:
social_status, social_publish (pubblica o propone un post: di solito va in ✅ Approvazioni), social_stats (statistiche:
Instagram, Threads, X; non LinkedIn), social_comments, media_list e media_view (archivio di foto e video caricati dall'utente),
create_graphic (grafiche disegnate in SVG, gratis), create_video (reel e video montati dal nostro server: clip e foto,
schermate di testo, voce narrante italiana con sottotitoli parola per parola, titoli animati, transizioni, effetti e musica:
gratis; dallo agli agenti che preparano i contenuti visivi), stock_search e stock_add (clip e foto di repertorio vere da
Pexels, gratis, se l'utente ha messo la chiave: dalli a chi monta i video), generate_image (immagini con l'IA di Gemini, ~0,07 $ l'una, se l'utente
ha messo la chiave). Dai social_publish solo agli agenti che devono pubblicare (es. un editore o un community manager), gli
altri preparano idee, testi e grafiche e li scrivono nella bacheca. Su X ogni post costa 0,015 $ (0,20 $ con un link) e
ogni post letto 0,005 $: agenti di X con social_stats al massimo una o due volte al giorno.
SPESA: ogni lavoro di un agente costa (modello, lunghezza di ciò che legge e scrive, ricerche web). Prezzi indicativi per
milione di token (entrata/uscita): Haiku 0,10/0,50 $, Sonnet 2/10 $, Opus 4/20 $ (Haiku costa circa 40 volte meno di Opus).
Quando crei agenti: Haiku con effort "low" per i compiti di routine (raccogliere, riassumere, pubblicare, controllare),
Sonnet per scrittura e strategia, Opus solo se l'utente lo chiede; everyMinutes il più alto possibile (ogni ora o meno spesso,
salvo motivi veri); onlyOnNews true per gli agenti che lavorano solo su ciò che scrivono gli altri (editori, riassunti,
capi che decidono sulle note), mai per chi cerca dati nuovi da solo (web_search, prezzi, statistiche); web_search solo a chi serve.
Con get_costs vedi chi spende di più e proponi risparmi concreti; con set_palace_pace metti un palazzo a ritmo ridotto o in
pausa. I budget del mese li imposta solo l'utente nella sezione 💰 Spesa.
Gli agenti non hanno accesso ad altri account privati dell'utente (email, messaggi privati…): possono leggere ciò che è
pubblico con web_search. Se un compito richiederebbe un accesso che non c'è, dillo chiaramente invece di far finta.

Regole:
- Ogni piano (di solito quelli del palazzo degli investimenti) opera sul portafoglio SIMULATO oppure su un conto cTrader
  (demo o reale): controlla con get_broker_status. Gli agenti degli altri palazzi in genere non devono fare ordini.
  Non puoi approvare ordini (lo fa solo l'utente dal pannello Approvazioni), né collegare conti REALI, né cambiare
  STOP e limiti di sicurezza: se servono, spiega all'utente come farlo dalla sezione 🔌 Broker.
- Sui conti cTrader gli ordini si danno in lotti (lots) e con uno stop loss; i nomi degli strumenti sono quelli del broker.
- Quando crei o modifichi un agente con canTrade, lascia requireApproval a true salvo richiesta esplicita.
- Non inventare dati di mercato: usa gli strumenti. Se un dato ha source "demo", dillo.
- Non dare consigli finanziari personalizzati come certezze: presenta analisi e rischi.`;

/** Un agente in breve per Orion: tutto tranne le istruzioni intere (con 60 agenti sarebbero decine di migliaia di parole). */
function agentBrief(a) {
  const { instructions = "", params, ...rest } = a;
  const text = String(instructions);
  return {
    ...rest,
    ...(params && Object.keys(params).length ? { params } : {}),
    instructions: text.length > 160 ? `${text.slice(0, 160)}… [${text.length} caratteri: intere con get_agents]` : text,
  };
}

async function runTool_(ctx, name, input) {
  switch (name) {
    case "list_agents": {
      const b = ctx.building();
      const palaceOf = (floorId) => b.floors.find((f) => f.id === floorId)?.palace;
      const rooms = ctx.rooms().filter(
        (r) => (!input.room || r.id === input.room) && (!input.floor || r.floor === input.floor) && (!input.palace || palaceOf(r.floor) === input.palace),
      );
      const inRooms = new Set(rooms.map((r) => r.id));
      return {
        rooms: rooms.map((r) => ({ id: r.id, name: r.name, floor: r.floor })),
        agents: ctx.agents().filter((a) => inRooms.has(a.room)).map((a) => ({ ...agentBrief(a), running: isRunning(a.id) })),
      };
    }
    case "get_agents": {
      const ids = [].concat(input.ids ?? []).map(String).slice(0, 10);
      const all = ctx.agents();
      return ids.map((id) => all.find((a) => a.id === id) ?? { id, error: "agente inesistente" });
    }
    case "list_building":
      return ctx.building();
    case "delete_agent":
      if (isRunning(input.id)) throw new Error("l'agente sta lavorando: riprova quando ha finito");
      if (!ctx.agents().some((a) => a.id === input.id)) throw new Error(`agente ${input.id} inesistente`);
      ctx.deleteAgent(input.id);
      return { deleted: input.id };
    case "save_palace":
      return { saved: ctx.savePalace(input) };
    case "delete_palace":
      ctx.deletePalace(input.id);
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
      const raw = input.agent ?? {};
      // Agente esistente: si cambiano solo i campi passati (Orion non deve riscrivere ogni volta le istruzioni intere).
      const old = raw.id ? ctx.agents().find((a) => a.id === raw.id) : null;
      const agent = ctx.saveAgent(old ? { ...old, ...raw, limits: { ...old.limits, ...(raw.limits ?? {}) } } : raw);
      log(agent.id, "info", `configurazione salvata da ${ASSISTANT_NAME}`);
      return { saved: agentBrief(agent) };
    }
    case "read_notes":
      // Come per gli agenti: le note molto lunghe si accorciano (restano nella cronologia e si rileggono a ogni passaggio).
      return readNotes(input.room, Math.min(input.limit ?? 10, 30)).map((n) => (n.text?.length > 2500 ? { ...n, text: `${n.text.slice(0, 2500)}… [nota accorciata]` } : n));
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
    case "social_status":
      return socialStatusForAgents();
    case "get_costs": {
      const r = costReport(ctx.agents(), ctx.building());
      const n = Math.min(Math.max(Number(input.top) || 15, 1), 60);
      const usd = (x) => Math.round(x * 100) / 100;
      return {
        mese: r.month, spesa_mese: usd(r.total), oggi: usd(r.today), stima_fine_mese: usd(r.projection), budget_mese: r.budget,
        palazzi: r.palaces.map((p) => ({ id: p.id, nome: p.name, spesa_mese: usd(p.usd), budget: p.budget, ritmo: p.pace, stima_mese: usd(p.monthlyEstimate), agenti: p.agents })),
        altre_spese: Object.fromEntries(Object.entries(r.other).map(([k, v]) => [k, usd(v)])),
        agenti: r.agents.slice(0, n).map((a) => ({
          id: a.id, nome: a.name, palazzo: a.palace, modello: a.model, effort: a.effort, ogni_minuti: a.everyMinutes, solo_con_novita: a.onlyOnNews,
          spesa_mese: usd(a.usdMonth), lavori_mese: a.runsMonth, costo_medio_lavoro: Math.round(a.perRun * 1000) / 1000, stima_mese: usd(a.monthlyEstimate), consigli: a.tips,
        })),
      };
    }
    case "set_palace_pace":
      return setPalacePace(String(input.palace ?? ""), String(input.pace ?? ""), ctx.building());
    case "media_list":
      return listMedia({ kind: input.kind, limit: Math.min(Math.max(Number(input.limit) || 30, 1), 100) }).map(({ src, thumb, ...m }) => m);
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
    floors: ctx.building().floors.map((f) => ({ id: f.id, name: f.name, palace: f.palace, trading: f.trading ?? { mode: "paper" } })),
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
export function chat(ctx, text, opts) {
  return costScope.run({ kind: "orion" }, () => chatInner(ctx, text, opts));
}

async function chatInner(ctx, text, { voice = false } = {}) {
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
  const snapshot = `Stato attuale dell'universo "${ctx.building().name}" (palazzi, piani dal più alto):\n${describeBuilding(ctx.building(), ctx.agents())}`;
  const previousSnapshot = lastSnapshot;
  if (snapshot !== lastSnapshot) {
    messages.push({ role: "system", content: snapshot }); // messaggio di sistema in coda: non modifica la cronologia
    lastSnapshot = snapshot;
  }
  bus.emit("event", { type: "chat-status", busy: true });

  try {
    const { model, effort } = modelConfig();
    for (let step = 0; step < MAX_STEPS; step++) {
      // In diretta: il testo di Orion arriva all'app mentre lo scrive (evento chat-delta), non solo alla fine.
      bus.emit("event", { type: "chat-delta", reset: true });
      const stream = client.beta.messages.stream({
        model,
        max_tokens: 16000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: CACHE }],
        tools: TOOLS,
        messages,
        output_config: { effort },
        cache_control: CACHE,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      stream.on("text", (delta) => bus.emit("event", { type: "chat-delta", delta }));
      const response = await stream.finalMessage();
      addUsage(model, response.usage);
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
