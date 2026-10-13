// Strumenti che un agente può usare. Ogni agente abilita solo quelli elencati in `tools`.
// I dati e gli ordini dipendono dal piano dell'agente: portafoglio simulato oppure conto cTrader.
import { getQuote, getHistory } from "./market.js";
import { summary } from "./indicators.js";
import { readNotes, postNote } from "./store.js";
import { submitOrder, portfolioFor, tradingTarget } from "./broker.js";
import { readableRooms } from "./building.js";
import * as ctrader from "./ctrader/service.js";
import { calendarFor } from "./calendar.js";

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
};

const TRADING_TOOLS = new Set(["place_order", "close_position"]);

/** Strumenti abilitati: chi può aprire posizioni (place_order) può anche chiuderle (close_position). */
export function enabledTools(agent) {
  const set = new Set(agent.tools);
  if (agent.canTrade && set.has("place_order")) set.add("close_position");
  return set;
}

export function toolsFor(agent) {
  return [...enabledTools(agent)]
    .filter((name) => TOOL_DEFS[name] && (!TRADING_TOOLS.has(name) || agent.canTrade))
    .map((name) => ({ name, ...TOOL_DEFS[name] }));
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
      return readNotes(input.room, Math.min(input.limit ?? 10, 30));
    }
    case "post_note":
      return postNote(agent.room, agent, input.text, input.tags ?? []);
    case "get_portfolio":
      return portfolioFor(agent);
    case "place_order":
      return submitOrder(agent, { ...input, action: "open" });
    case "close_position":
      if (!accountId) throw new Error("close_position vale solo per i piani collegati a cTrader; sul portafoglio simulato usa place_order con side sell.");
      return submitOrder(agent, { action: "close", positionId: input.position_id, lots: input.lots, reason: input.reason });
    default:
      throw new Error(`Tool sconosciuto: ${name}`);
  }
}
