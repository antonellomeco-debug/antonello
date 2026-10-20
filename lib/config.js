// Carica e salva la configurazione degli agenti: un file JSON per agente in data/agents/.
import fs from "node:fs";
import path from "node:path";
import { AGENTS_DIR } from "./paths.js";
import { PRICES, MODELS, EFFORTS } from "./models.js";
import { appointmentErrors } from "./schedule.js";

export const ID_PATTERN = /^[a-z0-9_-]+$/;
export const STRATEGY_NAME = /^[A-Za-z0-9_-]+$/;

export const ALL_TOOLS = [
  "get_quote", "get_indicators", "get_candles", "search_symbols", "get_calendar", "get_costs", "web_search",
  "read_notes", "post_note", "get_portfolio", "place_order", "close_position", "my_portfolio", "send_signal",
  "company_financials", "fund_holdings", "ipo_calendar", "earnings_calendar", "company_news", "trade_journal", "week_notes", "weekly_report",
  "social_status", "social_publish", "social_stats", "social_comments", "social_inbox", "media_list", "media_view", "create_graphic", "create_video", "create_motion_video", "stock_search", "stock_add", "generate_image",
];

const DEFAULTS = {
  enabled: true,
  mode: "llm",
  avatar: "🤖",
  everyMinutes: 0, // 0 = solo avvio manuale
  watchlist: [],
  readsFrom: [],
  tools: ["get_quote", "get_indicators", "read_notes", "post_note"],
  canTrade: false,
  limits: { maxOrderPct: 10, maxPositionPct: 20, onlyWatchlist: true, requireApproval: true },
  // Di partenza il modello più economico (circa 40 volte meno di Opus) e poco ragionamento: per i compiti di routine
  // basta; per scrittura o strategia si sceglie Sonnet, Opus solo se serve davvero.
  model: "claude-haiku-5-5",
  effort: "low",
  onlyOnNews: false, // true = quando tocca a lui lavora solo se nelle stanze che legge ci sono note nuove
  instructions: "",
  strategy: null,
  params: {},
};

export function loadAgents() {
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => normalize(JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), "utf8")), f));
}

export function normalize(raw, file = "") {
  const agent = { ...DEFAULTS, ...raw, limits: { ...DEFAULTS.limits, ...(raw.limits ?? {}) } };
  agent.id ||= path.basename(file, ".json");
  agent.name ||= agent.id;
  return agent;
}

export function validate(agent, rooms) {
  const errors = [];
  if (!ID_PATTERN.test(agent.id ?? "")) errors.push("id: solo minuscole, numeri, - e _");
  if (!rooms.some((r) => r.id === agent.room)) errors.push(`room "${agent.room}" inesistente`);
  if (!["llm", "rule"].includes(agent.mode)) errors.push('mode deve essere "llm" o "rule"');
  if (agent.mode === "rule" && !agent.strategy) errors.push("le regole richiedono una strategy");
  else if (agent.mode === "rule" && !STRATEGY_NAME.test(agent.strategy)) errors.push("strategy: solo il nome di un file in strategies/ (lettere, numeri, - e _)");
  if (agent.mode === "llm" && !agent.instructions?.trim()) errors.push("scrivi le instructions dell'agente");
  const bad = (agent.tools ?? []).filter((t) => !ALL_TOOLS.includes(t));
  if (bad.length) errors.push(`tool sconosciuti: ${bad.join(", ")}`);
  if (!Array.isArray(agent.watchlist)) errors.push("watchlist deve essere una lista");
  // Limiti di spesa: solo modelli con un prezzo noto e niente agenti che partono ogni 1-4 minuti.
  if (agent.mode === "llm" && !Object.hasOwn(PRICES, agent.model ?? "")) errors.push(`model "${agent.model}" sconosciuto: usa ${MODELS.join(", ")}`);
  if (agent.mode === "llm" && !EFFORTS.includes(agent.effort)) errors.push(`effort deve essere ${EFFORTS.join(", ")}`);
  const every = Number(agent.everyMinutes ?? 0);
  if (!Number.isFinite(every) || every < 0) errors.push("everyMinutes: un numero di minuti (0 = solo avvio manuale)");
  else if (every > 0 && every < 5) errors.push("everyMinutes: 0 (solo avvio manuale) oppure almeno 5 minuti");
  errors.push(...appointmentErrors(agent));
  return errors;
}

export function saveAgent(agent) {
  const file = path.join(AGENTS_DIR, `${agent.id}.json`);
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(agent, null, 2) + "\n");
  fs.renameSync(`${file}.tmp`, file);
}

export function deleteAgent(id) {
  if (!ID_PATTERN.test(id)) throw new Error("id non valido");
  fs.rmSync(path.join(AGENTS_DIR, `${id}.json`), { force: true });
}
