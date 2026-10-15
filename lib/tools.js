// Strumenti che un agente può usare. Ogni agente abilita solo quelli elencati in `tools`.
// I dati e gli ordini dipendono dal piano dell'agente: portafoglio simulato oppure conto cTrader.
import { getQuote, getHistory } from "./market.js";
import { summary } from "./indicators.js";
import { readNotes, postNote, addCost } from "./store.js";
import { submitOrder, portfolioFor, tradingTarget } from "./broker.js";
import { readableRooms } from "./building.js";
import * as ctrader from "./ctrader/service.js";
import { calendarFor } from "./calendar.js";
import * as social from "./social/index.js";
import * as media from "./social/media.js";
import { generateImage } from "./social/imagegen.js";

const PERIODS = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1"];

/** Parametri del calendario economico (uguali per gli agenti e per Orion). */
export const CALENDAR_SCHEMA = {
  type: "object",
  properties: {
    giorni: {
      type: "string",
      enum: ["oggi", "domani", "ieri", "settimana", "7giorni"],
      description: "periodo (default oggi); settimana = da oggi a domenica (di sabato e domenica anche la settimana che arriva)",
    },
    valute: { type: "array", items: { type: "string" }, description: 'valute degli eventi, es. ["USD"] (default) o ["USD","EUR"]; ["TUTTE"] per tutte' },
    impatto_minimo: { type: "string", enum: ["alto", "medio", "basso"], description: "default medio" },
  },
};
export const CALENDAR_DESCRIPTION =
  "Calendario economico (dati di Forex Factory, aggiornati da soli al massimo ogni ora): eventi con giorno e ora italiana, " +
  "impatto, previsione, dato precedente e, appena esce, il dato uscito (USCITO).";

/**
 * Ricerca web di Anthropic: la eseguono i server di Claude (notizie e informazioni aggiornate, con le fonti).
 * Costa 10 $ ogni 1.000 ricerche, più i token dei risultati. Versione di base: funziona con tutti i modelli.
 */
export const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 3 };
const SERVER_TOOLS = { web_search: WEB_SEARCH_TOOL };

export const TOOL_DEFS = {
  get_quote: {
    description:
      "Ultimo prezzo e variazione giornaliera. Con cTrader collegato usa i nomi del broker (es. EURUSD, XAUUSD, US500); " +
      "altrimenti i ticker Yahoo (es. AAPL, ENI.MI, ^GSPC).",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
  get_indicators: {
    description:
      "Indicatori tecnici: SMA20/50, RSI14, volatilità annualizzata in % (stima), rendimenti % sulle ultime 5/20/60 candele " +
      "(return5d… con D1, return5_H1… con altri periodi). Periodo predefinito: giornaliero (D1).",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        period: { type: "string", enum: PERIODS, description: "solo per strumenti cTrader; default D1" },
      },
      required: ["symbol"],
    },
  },
  get_candles: {
    description: "Ultime candele (data, apertura, massimo, minimo, chiusura). Periodi M1…W1 disponibili per gli strumenti cTrader.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        period: { type: "string", enum: PERIODS },
        count: { type: "integer", minimum: 5, maximum: 200 },
      },
      required: ["symbol"],
    },
  },
  search_symbols: {
    description: "Cerca gli strumenti disponibili sul broker cTrader (per nome o descrizione, es. 'gold', 'EUR', 'Nasdaq').",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  get_calendar: {
    description: CALENDAR_DESCRIPTION,
    input_schema: CALENDAR_SCHEMA,
  },
  read_notes: {
    description: "Legge le ultime note pubblicate nella bacheca di una stanza.",
    input_schema: {
      type: "object",
      properties: {
        room: { type: "string", description: "id della stanza" },
        limit: { type: "integer", description: "quante note (max 30)" },
      },
      required: ["room"],
    },
  },
  post_note: {
    description: "Pubblica una nota nella bacheca della tua stanza, visibile agli altri agenti e all'utente.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        tags: { type: "array", items: { type: "string" }, description: "es. ticker, BUY, SELL, RISCHIO" },
      },
      required: ["text"],
    },
  },
  get_portfolio: {
    description: "Situazione del conto del tuo piano: liquidità o saldo, posizioni aperte, P&L (e quali posizioni hai aperto tu).",
    input_schema: { type: "object", properties: {} },
  },
  place_order: {
    description:
      "Apre una posizione a mercato sul conto del tuo piano. Portafoglio simulato: indica qty (pezzi); side sell vende pezzi che possiedi. " +
      "Conto cTrader: indica lots (lotti, es. 0.01) e sempre uno stop_loss_pct (quello predefinito si applica solo se l'utente lo ha " +
      "previsto in Sicurezza); side sell APRE una " +
      "nuova posizione in vendita (non chiude un acquisto: per chiudere usa close_position). Soggetto ai limiti di rischio e, " +
      "se previsto, all'approvazione dell'utente.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        side: { type: "string", enum: ["buy", "sell"] },
        qty: { type: "integer", minimum: 1, description: "solo portafoglio simulato" },
        lots: { type: "number", exclusiveMinimum: 0, description: "solo conto cTrader" },
        stop_loss_pct: { type: "number", exclusiveMinimum: 0, description: "distanza dello stop loss in % dal prezzo (cTrader)" },
        take_profit_pct: { type: "number", exclusiveMinimum: 0, description: "distanza del take profit in % dal prezzo (cTrader)" },
        reason: { type: "string", description: "motivazione sintetica" },
      },
      required: ["symbol", "side", "reason"],
    },
  },
  close_position: {
    description: "Chiude (tutta o in parte) una posizione cTrader che hai aperto tu. Usa get_portfolio per vedere i positionId.",
    input_schema: {
      type: "object",
      properties: {
        position_id: { type: "integer" },
        lots: { type: "number", exclusiveMinimum: 0, description: "per una chiusura parziale; senza = tutta" },
        reason: { type: "string" },
      },
      required: ["position_id", "reason"],
    },
  },
  social_status: {
    description:
      "Social collegati dall'utente (Instagram, Threads, LinkedIn, X): account, pubblicazione automatica o con approvazione, " +
      "post fatti oggi e massimo al giorno, ultimi post con il loro stato e link.",
    input_schema: { type: "object", properties: {} },
  },
  social_publish: {
    description:
      "Pubblica un post su un social collegato (o una risposta a un commento con reply_to). Di solito va prima in ✅ Approvazioni " +
      "e parte quando l'utente approva; se l'utente ha attivato la pubblicazione automatica parte subito (o all'ora publish_at). " +
      "Testo massimo: Instagram 2200, Threads 500, LinkedIn 3000, X 280 caratteri. Instagram vuole sempre almeno una foto o un video; " +
      "con 2 o più file è un carosello (Instagram fino a 10, Threads 20, LinkedIn 20 solo foto, X 4 foto o 1 video). " +
      "X costa 0,015 $ a post e 0,20 $ se il testo contiene un link. Non inventare dati né promesse: il post esce a nome dell'utente.",
    input_schema: {
      type: "object",
      properties: {
        network: { type: "string", enum: ["instagram", "threads", "linkedin", "x"] },
        text: { type: "string", description: "testo del post (didascalia), con eventuali hashtag" },
        media: { type: "array", items: { type: "string" }, description: "id dei file dell'archivio (media_list, create_graphic, generate_image), in ordine" },
        format: { type: "string", enum: ["post", "story"], description: "story = storia di Instagram (un solo file, senza testo)" },
        reply_to: { type: "string", description: "id del commento (Instagram) o del post (Threads, X) a cui rispondere" },
        publish_at: { type: "string", description: 'facoltativo: data e ora italiana di pubblicazione, es. "2026-10-16 18:30"' },
        reason: { type: "string", description: "perché questo post, in breve (lo legge l'utente)" },
      },
      required: ["network", "text", "reason"],
    },
  },
  social_stats: {
    description:
      "Statistiche dell'account e degli ultimi post (mi piace, commenti, visualizzazioni, copertura…) di Instagram, Threads o X. " +
      "LinkedIn non le fornisce. Su X ogni post letto costa 0,005 $: usala al massimo una o due volte al giorno.",
    input_schema: {
      type: "object",
      properties: { network: { type: "string", enum: ["instagram", "threads", "x"] }, limit: { type: "integer", minimum: 1, maximum: 20, description: "quanti post (default 10)" } },
      required: ["network"],
    },
  },
  social_comments: {
    description: "Commenti o risposte a un post (id da social_stats) su Instagram, Threads o X, con l'id per rispondere (social_publish con reply_to).",
    input_schema: {
      type: "object",
      properties: { network: { type: "string", enum: ["instagram", "threads", "x"] }, post_id: { type: "string" } },
      required: ["network", "post_id"],
    },
  },
  media_list: {
    description: "Archivio di foto e video: quelli caricati dall'utente, le grafiche e le immagini IA. Ogni file ha id, titolo, descrizione, misure e dove è già stato usato.",
    input_schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["image", "video"] }, limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
  },
  media_view: {
    description: "Guarda una foto dell'archivio (per capire cosa mostra e scrivere testi adatti). I video non si possono guardare: leggi titolo e descrizione.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  create_graphic: {
    description:
      "Crea una grafica (post, slide di un carosello, copertina) disegnandola in SVG; diventa un JPEG nell'archivio e restituisce il suo id. " +
      "Usa width/height e viewBox uguali al formato: square 1080×1080, portrait 1080×1350 (il migliore per il feed di Instagram), " +
      "story 1080×1920, landscape 1200×675 (X, LinkedIn). Caratteri: Montserrat, Inter, Bebas Neue, Playfair Display (font-weight 100–900). " +
      "Permessi: forme, testo, gradienti, filtri; per inserire una foto dell'archivio usa <image href=\"media:ID\" …>. Niente emoji né risorse esterne. " +
      "Il testo SVG non va a capo da solo: spezza le righe con più <text> o <tspan>. Margini di almeno 80 px, testo grande e leggibile sul telefono.",
    input_schema: {
      type: "object",
      properties: {
        svg: { type: "string" },
        format: { type: "string", enum: ["square", "portrait", "story", "landscape"] },
        title: { type: "string" },
        description: { type: "string", description: "cosa mostra (serve anche come testo alternativo)" },
      },
      required: ["svg", "format", "title"],
    },
  },
  generate_image: {
    description:
      "Crea un'immagine con l'intelligenza artificiale (Gemini) da una descrizione dettagliata in inglese o italiano (soggetto, stile, luce, " +
      "inquadratura, colori); con reference usa foto dell'archivio come base (es. il prodotto dell'utente su uno sfondo nuovo). " +
      "Costa circa 0,07 $ a immagine: usala per le immagini che contano, per testi e grafiche usa create_graphic. " +
      "Non funziona se l'utente non ha messo la chiave di Gemini. Niente persone reali riconoscibili, marchi altrui o contenuti ingannevoli.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        format: { type: "string", enum: ["square", "portrait", "story", "landscape"] },
        reference: { type: "array", items: { type: "string" }, description: "fino a 3 id di foto dell'archivio" },
        title: { type: "string" },
      },
      required: ["prompt", "format"],
    },
  },
};

const TRADING_TOOLS = new Set(["place_order", "close_position"]);

/** Strumenti abilitati: chi può aprire posizioni (place_order) può anche chiuderle (close_position). */
export function enabledTools(agent) {
  const set = new Set(agent.tools);
  if (agent.canTrade && set.has("place_order")) set.add("close_position");
  return set;
}

export function toolsFor(agent) {
  const enabled = [...enabledTools(agent)];
  return [
    ...enabled.filter((name) => TOOL_DEFS[name] && (!TRADING_TOOLS.has(name) || agent.canTrade)).map((name) => ({ name, ...TOOL_DEFS[name] })),
    ...enabled.filter((name) => SERVER_TOOLS[name]).map((name) => ({ ...SERVER_TOOLS[name] })), // eseguiti dai server di Claude
  ];
}

/** Conto cTrader del piano dell'agente (per dati e ordini), se il piano è collegato a cTrader. */
const accountOf = (agent) => {
  const t = tradingTarget(agent);
  return t.mode === "ctrader" ? t.accountId : undefined;
};

export async function runTool(agent, name, input, building) {
  if (!enabledTools(agent).has(name)) throw new Error(`Tool ${name} non abilitato per questo agente`);
  if (TRADING_TOOLS.has(name) && !agent.canTrade) throw new Error(`L'agente ${agent.name} non è autorizzato a fare trading`);
  const accountId = accountOf(agent);
  switch (name) {
    case "get_quote":
      return getQuote(input.symbol, { accountId });
    case "get_indicators": {
      const h = await getHistory(input.symbol, { accountId, period: input.period ?? "D1", count: 200 });
      return { symbol: h.symbol, source: h.source, period: h.period ?? "D1", ...summary(h.candles, h.period ?? "D1") };
    }
    case "get_candles": {
      const count = Math.min(Math.max(Number(input.count) || 50, 5), 200);
      const h = await getHistory(input.symbol, { accountId, period: input.period ?? "D1", count });
      const digits = (x) => Math.round(x * 100000) / 100000;
      return {
        symbol: h.symbol,
        source: h.source,
        period: h.period ?? "D1",
        columns: ["data", "apertura", "massimo", "minimo", "chiusura"],
        candles: h.candles.slice(-count).map((c) => [c.time ? new Date(c.time).toISOString().slice(0, 16) : c.date, digits(c.open), digits(c.high), digits(c.low), digits(c.close)]),
      };
    }
    case "search_symbols": {
      const id = accountId ?? ctrader.dataAccountId();
      if (!ctrader.isReady() || !id) throw new Error("cTrader non è collegato: per ora si usano i ticker Yahoo (es. AAPL, ENI.MI).");
      return ctrader.search(id, input.query);
    }
    case "get_calendar":
      return calendarFor(input);
    case "read_notes": {
      const visible = readableRooms(agent, building).map((r) => r.id);
      if (!visible.includes(input.room)) {
        throw new Error(`Non hai accesso alla stanza ${input.room} (stanza di un piano non collegato?). Accessibili: ${visible.join(", ")}`);
      }
      // Note molto lunghe accorciate: ogni carattere letto si paga (una nota lunga letta da molti agenti costa tanto).
      return readNotes(input.room, Math.min(input.limit ?? 10, 30)).map((n) => (n.text?.length > 2500 ? { ...n, text: `${n.text.slice(0, 2500)}… [nota accorciata]` } : n));
    }
    case "post_note":
      return postNote(agent.room, agent, input.text, input.tags ?? []);
    case "get_portfolio":
      return portfolioFor(agent);
    case "social_status":
      return social.statusForAgents();
    case "social_publish":
      return social.proposePost(agent, input);
    case "social_stats":
      return social.stats(String(input.network ?? ""), { limit: input.limit });
    case "social_comments":
      return social.comments(String(input.network ?? ""), input.post_id);
    case "media_list":
      return media.listMedia({ kind: input.kind, limit: Math.min(Math.max(Number(input.limit) || 30, 1), 100) }).map(({ src, thumb, ...m }) => m);
    case "media_view": {
      const { media: m, base64 } = await media.imageForModel(String(input.id ?? ""));
      // Il risultato contiene la foto: il modello la vede (vedi runner.js).
      return {
        toolContent: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
          { type: "text", text: JSON.stringify({ id: m.id, title: m.title, description: m.description, width: m.width, height: m.height }) },
        ],
      };
    }
    case "create_graphic": {
      const { src, thumb, ...m } = await media.createGraphic({ ...input, by: agent.name });
      return { ...m, message: "Grafica salvata nell'archivio: usa questo id in social_publish. Se vuoi controllarla, guardala con media_view." };
    }
    case "generate_image": {
      const { src, thumb, ...m } = await generateImage({ ...input, by: agent.name });
      addCost(m.cost);
      return m;
    }
    case "place_order":
      return submitOrder(agent, { ...input, action: "open" });
    case "close_position":
      if (!accountId) throw new Error("close_position vale solo per i piani collegati a cTrader; sul portafoglio simulato usa place_order con side sell.");
      return submitOrder(agent, { action: "close", positionId: input.position_id, lots: input.lots, reason: input.reason });
    default:
      throw new Error(`Tool sconosciuto: ${name}`);
  }
}
