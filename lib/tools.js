// Strumenti che un agente può usare. Ogni agente abilita solo quelli elencati in `tools`.
import { getQuote, getHistory } from "./market.js";
import { summary } from "./indicators.js";
import { readNotes, postNote } from "./store.js";
import { portfolioValue, submitOrder } from "./broker.js";

export const TOOL_DEFS = {
  get_quote: {
    description: "Ultimo prezzo e variazione giornaliera di un titolo (es. AAPL, ENI.MI, ^GSPC).",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker Yahoo Finance" } },
      required: ["symbol"],
    },
  },
  get_indicators: {
    description: "Indicatori tecnici su dati giornalieri: SMA20/50, RSI14, volatilità annualizzata, rendimenti 5/20/60 giorni.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
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
    description: "Stato del portafoglio virtuale: liquidità, posizioni, P&L, ultimi trade.",
    input_schema: { type: "object", properties: {} },
  },
  place_order: {
    description: "Esegue un ordine SIMULATO (paper trading) a prezzo di mercato. Soggetto ai limiti di rischio.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        side: { type: "string", enum: ["buy", "sell"] },
        qty: { type: "integer", minimum: 1 },
        reason: { type: "string", description: "motivazione sintetica" },
      },
      required: ["symbol", "side", "qty", "reason"],
    },
  },
};

export function toolsFor(agent) {
  return agent.tools
    .filter((name) => name !== "place_order" || agent.canTrade)
    .map((name) => ({ name, ...TOOL_DEFS[name] }));
}

export async function runTool(agent, name, input) {
  if (!agent.tools.includes(name)) throw new Error(`Tool ${name} non abilitato per questo agente`);
  switch (name) {
    case "get_quote":
      return getQuote(input.symbol);
    case "get_indicators": {
      const h = await getHistory(input.symbol);
      return { symbol: h.symbol, source: h.source, ...summary(h.candles) };
    }
    case "read_notes": {
      const visible = [agent.room, ...agent.readsFrom];
      if (!visible.includes(input.room)) throw new Error(`Non hai accesso alla stanza ${input.room}. Accessibili: ${visible.join(", ")}`);
      return readNotes(input.room, Math.min(input.limit ?? 10, 30));
    }
    case "post_note":
      return postNote(agent.room, agent, input.text, input.tags ?? []);
    case "get_portfolio":
      return portfolioValue();
    case "place_order":
      return submitOrder(agent, input);
    default:
      throw new Error(`Tool sconosciuto: ${name}`);
  }
}
