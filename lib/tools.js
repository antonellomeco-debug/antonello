// Strumenti che un agente può usare. Ogni agente abilita solo quelli elencati in `tools`.
// I dati e gli ordini dipendono dal piano dell'agente: portafoglio simulato oppure conto cTrader.
import { getQuote, getHistory, longHistory } from "./market.js";
import { SYSTEM_NAMES, backtest as runBacktest, saveBacktest, describeSystems } from "./systems.js";
import { getSchedule } from "./schedule.js";
import * as ideas from "./ideas.js";
import { summary } from "./indicators.js";
import { readNotes, postNote, addCost, isRequestNote, requestProblem } from "./store.js";
import { submitOrder, portfolioFor, tradingTarget } from "./broker.js";
import { readableRooms } from "./building.js";
import * as ctrader from "./ctrader/service.js";
import { calendarFor } from "./calendar.js";
import * as social from "./social/index.js";
import * as media from "./social/media.js";
import { generateImage } from "./social/imagegen.js";
import { createVideo } from "./social/video.js";
import { createMotionVideo } from "./social/motion.js";
import { searchStock, addStock } from "./social/stock.js";
import { spendingReport, PERIODS as COST_PERIODS } from "./costs.js";
import { office } from "./office.js";
import * as holdings from "./holdings.js";
import * as marketdata from "./marketdata.js";
import { tradeJournal } from "./journal.js";
import { createReport, spesaHtml, operazioniHtml, INCLUDES as REPORT_INCLUDES } from "./reports.js";
import { palaceOfAgent } from "./costs.js";
import { assertHumanText, textsOf } from "./style.js";
import { buzz } from "./buzz.js";
import { readFeeds, readPage } from "./reader.js";
import { createDiagram } from "./social/diagram.js";

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
  get_costs: {
    description:
      "Spese della piattaforma (sola lettura): totale del periodo, spesa giorno per giorno, palazzi (spesa, budget, ritmo, stima del " +
      "mese), agenti dal più costoso (modello, ogni quanti minuti lavora, costo medio di un lavoro, stima al mese, consigli), altre voci " +
      "(chat di Orion, post programmati), abbonamenti e servizi a pagamento segnati dall'utente in 💰 Spesa, caratteri usati dalle voci " +
      "dei video. Gli importi della piattaforma sono in dollari. Con palace vedi solo un palazzo.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", enum: Object.keys(COST_PERIODS), description: Object.entries(COST_PERIODS).map(([k, v]) => `${k} = ${v}`).join("; ") + " (default mese)" },
        palace: { type: "string", description: "id del palazzo (vuoto = tutti)" },
        top: { type: "integer", description: "quanti agenti elencare (default 15, max 60)" },
      },
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
    description:
      "Pubblica una nota nella bacheca della tua stanza, visibile agli altri agenti e all'utente. Per fare una DOMANDA all'utente " +
      "usa l'etichetta RICHIESTA: gli arriva una notifica e la sua risposta compare nella bacheca della tua stanza (nota RISPOSTA " +
      "DELL'UTENTE). Solo per cose che SOLO LUI può darti o decidere (una foto, un documento, una scelta personale): UNA domanda " +
      "breve e precisa con il punto di domanda, al massimo 600 caratteri, senza riepiloghi. MAI per errori, limiti di post, doppioni, " +
      "ritardi o verifica dei dati: quelli li risolvi tu (correggi, togli il dato non verificato, rimanda o scarta il post); una " +
      "domanda così viene bloccata. " +
      "Un report sulle spese per l'utente (settimanale o mensile) va con l'etichetta REPORT SPESE: gli arriva una notifica e lo legge in 💰 Spesa.",
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
  my_portfolio: {
    description:
      "Il portafoglio VERO dell'utente (azioni che compra e vende lui con la sua banca): profilo d'investimento (capitale, rischio, " +
      "orizzonte, mercati e settori preferiti), azioni possedute con quantità, prezzo medio, prezzo di oggi, risultato, peso, stop loss " +
      "e obiettivo, operazioni chiuse, segnali in attesa e gli ultimi decisi (scartati o eseguiti). Ticker come su Yahoo Finance.",
    input_schema: { type: "object", properties: {} },
  },
  send_signal: {
    description:
      "Manda all'utente un SEGNALE in ✅ Approvazioni: comprare (buy) o vendere (sell) un'azione del suo portafoglio vero. Non parte " +
      "nessun ordine: l'utente decide, compra o vende lui e scrive quante azioni e a che prezzo. Solo quando l'analisi è completa e " +
      "convincente. buy: stop_loss obbligatorio (sotto il prezzo), target (sopra), entry_min/entry_max (fascia d'ingresso), " +
      "suggested_pct obbligatorio (quanto del capitale: il programma blocca oltre il peso massimo per azione del profilo, 8/12/15% con " +
      "rischio basso/medio/alto, contando quello che l'utente ha già), horizon, risks obbligatorio (perché potresti sbagliarti), sources " +
      "(fonti con data dei numeri usati). Al massimo 3 segnali d'acquisto a settimana in tutto. sell: solo azioni che l'utente possiede " +
      "(position_id da my_portfolio), sell_pct per vendere una parte. reason: tesi in breve con numeri e date. Ticker Yahoo (AAPL, ENI.MI).",
    input_schema: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["buy", "sell"] },
        symbol: { type: "string", description: "ticker come su Yahoo Finance, es. AAPL, MSFT, ENI.MI, ISP.MI, ASML.AS" },
        reason: { type: "string", description: "perché, in 3–8 righe: dati, valutazione, livelli, rischi, fonti con data" },
        stop_loss: { type: "number", description: "buy: prezzo di uscita se va male (nella valuta del titolo)" },
        target: { type: "number", description: "buy: prezzo obiettivo" },
        entry_min: { type: "number", description: "buy: fascia d'ingresso, minimo" },
        entry_max: { type: "number", description: "buy: fascia d'ingresso, massimo" },
        suggested_pct: { type: "number", description: "buy (obbligatorio): % del capitale dell'utente da investire in questa azione" },
        risks: { type: "string", description: "buy (obbligatorio): perché potresti sbagliarti, i 2–3 rischi principali e cosa ti farebbe cambiare idea" },
        sources: { type: "array", items: { type: "string" }, description: "fonti dei numeri usati, ognuna con la data (es. «10-Q Apple, 31/07/2026»)" },
        horizon: { type: "string", enum: holdings.HORIZONS, description: "breve = settimane, medio = mesi, lungo = anni" },
        position_id: { type: "string", description: "sell: position_id da my_portfolio" },
        sell_pct: { type: "number", description: "sell: % della posizione da vendere (default 100)" },
      },
      required: ["side", "symbol", "reason"],
    },
  },
  company_financials: {
    description:
      "Bilanci UFFICIALI di una società quotata negli USA dalla SEC (documenti 10-K e 10-Q): ricavi, utile operativo e netto, EPS, " +
      "flusso di cassa operativo e libero, capex (ultimi 4 anni e 5 trimestri), cassa, debito, patrimonio netto, azioni in circolazione, " +
      "con documento e data. Gratis: usalo PRIMA di web_search per questi numeri. Non vale per le società europee.",
    input_schema: { type: "object", properties: { ticker: { type: "string", description: "ticker USA, es. AAPL, MSFT, BRK-B" } }, required: ["ticker"] },
  },
  fund_holdings: {
    description:
      "Cosa possiede un grande investitore secondo l'ultimo 13F alla SEC (azioni USA a fine trimestre, depositato fino a 45 giorni dopo): " +
      `principali titoli con il peso e cosa è cambiato rispetto al trimestre prima. Fondi già noti: ${Object.keys(marketdata.FUNDS).join(", ")}; ` +
      "per altri serve il cik. Mostra cosa avevano, non cosa hanno oggi.",
    input_schema: {
      type: "object",
      properties: {
        fund: { type: "string", description: "nome del fondo, es. «berkshire hathaway»" },
        cik: { type: "string", description: "in alternativa: numero CIK alla SEC" },
        top: { type: "integer", description: "quanti titoli (default 15, max 40)" },
      },
    },
  },
  ipo_calendar: {
    description: "Calendario delle IPO (Finnhub, soprattutto USA): quotazioni in arrivo nelle prossime settimane e appena fatte, con data, borsa, prezzo e dimensione.",
    input_schema: {
      type: "object",
      properties: { days_ahead: { type: "integer", description: "giorni avanti (default 42)" }, days_back: { type: "integer", description: "giorni indietro (default 28)" } },
    },
  },
  earnings_calendar: {
    description: "Calendario dei risultati trimestrali (Finnhub): data, prima o dopo la borsa, EPS e ricavi stimati e, quando escono, quelli veri. Con symbol per un titolo, senza per tutto il mercato.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string" }, days_ahead: { type: "integer", description: "default 14" }, days_back: { type: "integer", description: "default 7" } },
    },
  },
  company_news: {
    description: "Notizie recenti di una società (Finnhub, soprattutto USA): titolo, fonte, data, riassunto, link. Più economico di web_search per seguire un titolo.",
    input_schema: { type: "object", properties: { symbol: { type: "string" }, days: { type: "integer", description: "default 7, max 30" } }, required: ["symbol"] },
  },
  backtest: {
    description:
      "Banco di prova: prova uno o più sistemi di trading in codice sui prezzi passati (cTrader: H1, H4, D1; azioni ed ETF di Yahoo: " +
      "solo D1), con spread e costi. Dà operazioni, % vinte, guadagno medio in R, fattore di profitto, perdita massima, rendimento " +
      "rischiando risk_pct% per operazione, confronto con «comprare e tenere» e il VERDETTO (SUPERATO / BOCCIATO / POCHI DATI), che " +
      "controlla anche l'ultimo 30% dei dati. I sistemi a regole (strategy «sistema») operano solo dove la prova è SUPERATA. " +
      `Sistemi: ${SYSTEM_NAMES.join(", ")} (system «elenco» = descrizione e parametri di ognuno; «tutti» = tutti). Le prove si salvano.`,
    input_schema: {
      type: "object",
      properties: {
        system: { type: "string", enum: [...SYSTEM_NAMES, "tutti", "elenco"] },
        symbols: { type: "array", items: { type: "string" }, description: "mercati, al massimo 8 (es. XAUUSD, EURUSD, US500, SPY)" },
        period: { type: "string", enum: ["H1", "H4", "D1"], description: "default H4 sul broker, D1 per Yahoo" },
        bars: { type: "integer", minimum: 300, maximum: 8000, description: "candele da provare, default 3000" },
        params: { type: "object", description: "parametri del sistema diversi da quelli predefiniti (vedi «elenco»)" },
        risk_pct: { type: "number", description: "% del conto rischiata per operazione nel calcolo del rendimento, default 0.5" },
        cost_pct: { type: "number", description: "costi per lato in % del prezzo (commissioni), default 0.01 sul broker e 0.1 per Yahoo" },
        flat_weekend: { type: "boolean", description: "chiudere tutto il venerdì sera come fa il programma; di partenza come l'impostazione «chiusura del venerdì» dell'utente" },
      },
      required: ["system"],
    },
  },
  ideas: {
    description:
      "💡 Idee dell'utente per i contenuti: testi, link, foto, video e documenti, ognuno con il PERCHÉ (argomenti nuovi da usare, " +
      "uno stile che gli piace da cui prendere spunto, un formato da provare, cose da evitare). Senza id: l'elenco delle idee ancora " +
      "da usare (filtra con network). Con id: l'idea intera. Con id e file_id: guardi la foto, i fotogrammi del video (con il parlato " +
      "trascritto) o leggi il documento (from per le pagine dopo). Gratis.",
    input_schema: {
      type: "object",
      properties: {
        network: { type: "string", enum: ["instagram", "linkedin", "threads", "x", "youtube"], description: "solo le idee per questo social (e quelle per tutti)" },
        status: { type: "string", enum: ["da_usare", "usate", "tutte"], description: "default da_usare" },
        id: { type: "string" },
        file_id: { type: "string" },
        from: { type: "integer", description: "per i documenti lunghi: carattere da cui continuare" },
      },
    },
  },
  idea_used: {
    description: "Segna che hai usato un'idea dell'utente e cosa ne hai fatto (lo vede nella sezione 💡 Idee). finished true = l'idea è esaurita.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, note: { type: "string", description: "cosa hai fatto, es. «Reel di martedì sul bando, stile del video d'esempio»" }, finished: { type: "boolean" } },
      required: ["id", "note"],
    },
  },
  trade_journal: {
    description:
      "Diario delle operazioni: operazioni chiuse sul conto cTrader (demo) con agente, motivi, durata e netto; vendite del portafoglio vero " +
      "con il risultato; segnali per agente (proposti, approvati, scartati, risultato). Per capire chi guadagna e quali abitudini costano.",
    input_schema: { type: "object", properties: { days: { type: "integer", enum: [7, 30, 90], description: "default 30" } } },
  },
  week_notes: {
    description:
      "Note della settimana di TUTTE le stanze di un palazzo (di partenza il tuo), divise per piano e stanza, dalla più recente: per scrivere " +
      "il report settimanale anche sui piani che non leggi. Ogni nota è accorciata a 700 caratteri; con floor vedi un piano solo.",
    input_schema: {
      type: "object",
      properties: {
        palace: { type: "string", description: "id del palazzo (default il tuo)" },
        floor: { type: "string", description: "id di un piano (facoltativo)" },
        days: { type: "integer", description: "default 7, max 14" },
        per_room: { type: "integer", description: "note per stanza, default 8, max 20" },
      },
    },
  },
  weekly_report: {
    description:
      "Crea il REPORT SETTIMANALE in PDF per l'utente e glielo manda per email (se l'ha impostata in 📄 Report); resta anche in 📄 Report " +
      "nell'app. Passi solo i contenuti, l'impaginazione la fa il programma. Scrivi in italiano semplice, con numeri veri presi dagli " +
      "strumenti (mai inventati): summary = sintesi della settimana in 4-8 righe; kpis = fino a 8 numeri chiave (label, value, change come " +
      "«+12%» o «-3», note); sections = le parti del report (title, text con righe vuote tra i paragrafi e righe «- » per gli elenchi, " +
      "bullets, table {columns, rows}); next_week = cosa farete la prossima settimana, azioni concrete; for_user = cosa serve dall'utente. " +
      "include aggiunge tabelle con i dati veri della piattaforma: «spesa» (spesa del palazzo negli ultimi 7 giorni) e «operazioni» " +
      "(operazioni chiuse sul conto cTrader). Un report per volta: se l'hai già fatto nelle ultime 6 ore serve replace: true.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "es. «Report settimanale – Palazzo Investimenti»" },
        period: { type: "string", description: "facoltativo: di partenza «Settimana dal … al …»" },
        summary: { type: "string" },
        kpis: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, change: { type: "string" }, note: { type: "string" } }, required: ["label", "value"] } },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              text: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              table: { type: "object", properties: { columns: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array", items: {} } } } },
            },
            required: ["title"],
          },
        },
        next_week: { type: "array", items: { type: "string" } },
        for_user: { type: "array", items: { type: "string" } },
        include: { type: "array", items: { type: "string", enum: REPORT_INCLUDES } },
        email: { type: "boolean", description: "default true (manda l'email se è impostata)" },
        replace: { type: "boolean", description: "rifà il report delle ultime 6 ore (lo sostituisce)" },
      },
      required: ["title", "summary", "sections", "next_week"],
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
  read_feeds: {
    description:
      "Ultime notizie dai feed RSS (gratis, senza chiavi): titolo, data, link e sommario, le più recenti prima. feeds = nomi delle fonti " +
      "pronte (ansa-economia, sole24ore-economia, sole24ore-finanza, sole24ore-norme-tributi, invitalia, mimit, gazzetta-ufficiale, " +
      "agenzia-entrate) oppure indirizzi di feed RSS/Atom; va bene anche la pagina principale di un sito se dichiara il suo feed. " +
      "query = parole da cercare nel titolo o nel sommario (es. \"bando incentivi credito\"). Risultati tenuti 15 minuti. " +
      "Per leggere una notizia per intero usa read_page con il suo link. Costa meno di web_search: usalo prima.",
    input_schema: {
      type: "object",
      properties: {
        feeds: { type: "array", items: { type: "string" }, description: "da 1 a 8 fonti (nomi o indirizzi)" },
        query: { type: "string", description: "facoltativo: parole da cercare (basta una)" },
        days: { type: "integer", minimum: 1, maximum: 60, description: "notizie degli ultimi giorni (default 7)" },
        limit: { type: "integer", minimum: 1, maximum: 40, description: "quante notizie (default 15)" },
      },
      required: ["feeds"],
    },
  },
  read_page: {
    description:
      "Legge una pagina web o un PDF (bando, decreto, articolo, comunicato) e restituisce il testo pulito senza menu e pubblicità, con " +
      "titolo, data di pubblicazione se c'è e i link ai documenti (PDF, allegati, moduli, FAQ). Gratis. Per i testi lunghi arriva un pezzo " +
      "alla volta (max_chars, poi from = continua_da). Usalo per controllare cifre, scadenze e requisiti sulla fonte originale prima di " +
      "scriverli in un post. Non apre pagine che richiedono il login né indirizzi interni.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "indirizzo https:// della pagina o del PDF" },
        max_chars: { type: "integer", minimum: 1000, maximum: 20000, description: "caratteri di testo (default 8000)" },
        from: { type: "integer", minimum: 0, description: "da quale carattere continuare (continua_da della risposta precedente)" },
      },
      required: ["url"],
    },
  },
  web_buzz: {
    description:
      "Ascolta la rete: cosa dice la gente negli ultimi giorni (fino a 30) su un argomento, da fonti pubbliche e GRATUITE. " +
      "reddit = discussioni con punti e commenti (archivio pubblico; per l'Italia indica subreddits come ItaliaPersonalFinance, italy, " +
      "commercialisti, Italia; senza subreddits cerca nei titoli di tutto Reddit, meglio in inglese); polymarket = probabilità che " +
      "le scommesse con soldi veri danno a un evento (Fed, elezioni, prezzi, aziende: in inglese, es. \"Fed rate cut\", \"gold price\"); " +
      "hackernews = tecnologia, IA e startup (in inglese); stocktwits = umore dei trader su un simbolo (symbol: AAPL, NVDA, BTC.X); " +
      "youtube = video più visti sull'argomento (solo se YouTube è collegato; massimo 20 ricerche al giorno in tutto). " +
      "Senza sources usa reddit, polymarket, hackernews (+ stocktwits con symbol, + youtube se collegato). Risultati tenuti 30 minuti. " +
      "Sono opinioni, non fatti: usali per trovare temi caldi e capire l'umore, poi verifica i numeri su fonti ufficiali.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "argomento, poche parole (es. \"bandi startup\", \"gold price\", \"ECB rate\")" },
        sources: { type: "array", items: { type: "string", enum: ["reddit", "polymarket", "hackernews", "stocktwits", "youtube"] } },
        subreddits: { type: "array", items: { type: "string" }, description: "facoltativo, al massimo 3 (senza r/)" },
        symbol: { type: "string", description: "per stocktwits: il simbolo (AAPL, TSLA, BTC.X)" },
        days: { type: "integer", minimum: 1, maximum: 30, description: "ultimi giorni (default 30)" },
        limit: { type: "integer", minimum: 1, maximum: 15, description: "risultati per fonte (default 8)" },
      },
    },
  },
  social_status: {
    description:
      "Social collegati dall'utente (Instagram, Threads, LinkedIn, X, YouTube): account, pubblicazione automatica o con approvazione, " +
      "post fatti oggi e massimo al giorno, ultimi post con il loro stato e link.",
    input_schema: { type: "object", properties: {} },
  },
  social_publish: {
    description:
      "Pubblica un post su un social collegato (o una risposta a un commento con reply_to). Di solito va prima in ✅ Approvazioni " +
      "e parte quando l'utente approva; se l'utente ha attivato la pubblicazione automatica parte subito (o all'ora publish_at). " +
      "Testo massimo: Instagram 2200, Threads 500, LinkedIn 3000, X 280 caratteri; YouTube = UN video con title (100) e text = descrizione (5000). " +
      "Instagram vuole sempre almeno una foto o un video; " +
      "con 2 o più file è un carosello (Instagram fino a 10, Threads 20, LinkedIn 20 solo foto, X 4 foto o 1 video). " +
      "X costa 0,015 $ a post e 0,20 $ se il testo contiene un link. Non inventare dati né promesse: il post esce a nome dell'utente. " +
      "Sullo stesso social ogni contenuto esce UNA volta: lo stesso testo (o quasi) o lo stesso file vengono rifiutati (su un altro social vanno bene). " +
      "I post dello stesso social escono distanziati (vedi distanza_tra_i_post in social_status): distribuiscili nella giornata con publish_at; " +
      "se uno è troppo vicino a un altro l'app lo sposta da sola più avanti. " +
      "Se il social non è collegato il post va in Approvazioni e lo pubblica l'utente a mano con un tocco (solo post singoli, " +
      "niente reply_to): prepara tutto pronto da incollare.",
    input_schema: {
      type: "object",
      properties: {
        network: { type: "string", enum: ["instagram", "threads", "linkedin", "x", "youtube"] },
        text: { type: "string", description: "testo del post (didascalia), con eventuali hashtag; su YouTube la descrizione del video" },
        title: { type: "string", description: "solo YouTube: titolo del video (massimo 100 caratteri; se manca si usa la prima riga del testo)" },
        thumbnail: { type: "string", description: "solo YouTube, facoltativo: id della miniatura (create_graphic format youtube_thumb), usata nei video lunghi; gli Shorts non la usano" },
        media: { type: "array", items: { type: "string" }, description: "id dei file dell'archivio (media_list, create_graphic, generate_image), in ordine" },
        format: { type: "string", enum: ["post", "story"], description: "story = storia di Instagram (un solo file, senza testo)" },
        reply_to: { type: "string", description: "id del commento (Instagram, YouTube) o del post (Threads, X) a cui rispondere" },
        publish_at: { type: "string", description: 'facoltativo: data e ora italiana di pubblicazione, es. "2026-10-16 18:30"' },
        reason: { type: "string", description: "perché questo post, in breve (lo legge l'utente)" },
      },
      required: ["network", "text", "reason"],
    },
  },
  social_stats: {
    description:
      "Statistiche dell'account e degli ultimi post (mi piace, commenti, visualizzazioni, copertura…) di Instagram, Threads, X o YouTube (iscritti, visualizzazioni, mi piace e commenti dei video, più i numeri di YouTube Studio degli ultimi 28 giorni: " +
      "minuti guardati, durata media, percentuale guardata, iscritti guadagnati, fonti di traffico e, quando Google li dà, clic sulle miniature). " +
      "LinkedIn non le fornisce. Su X ogni post letto costa 0,005 $: usala al massimo una o due volte al giorno.",
    input_schema: {
      type: "object",
      properties: { network: { type: "string", enum: ["instagram", "threads", "x", "youtube"] }, limit: { type: "integer", minimum: 1, maximum: 20, description: "quanti post (default 10)" } },
      required: ["network"],
    },
  },
  social_comments: {
    description: "Commenti o risposte a un post (id da social_stats) su Instagram, Threads, X o YouTube, con l'id per rispondere (social_publish con reply_to).",
    input_schema: {
      type: "object",
      properties: { network: { type: "string", enum: ["instagram", "threads", "x", "youtube"] }, post_id: { type: "string" } },
      required: ["network", "post_id"],
    },
  },
  social_inbox: {
    description:
      "Commenti NUOVI sotto i post recenti (Instagram, Threads, X, YouTube) a cui non ha ancora risposto nessuno: ognuno con comment_id, " +
      "il post a cui si riferisce, chi l'ha scritto e il testo. I commenti mostrati non tornano la volta dopo (salvo include_seen) e " +
      "quelli già risposti nemmeno. Per rispondere: social_publish con reply_to = comment_id. Su X leggere costa 0,005 $ a commento.",
    input_schema: {
      type: "object",
      properties: {
        network: { type: "string", enum: ["instagram", "threads", "x", "youtube"] },
        days: { type: "integer", minimum: 1, maximum: 14, description: "post degli ultimi giorni da controllare (default 7, X al massimo 3)" },
        include_seen: { type: "boolean", description: "anche i commenti già mostrati e non risposti" },
      },
      required: ["network"],
    },
  },
  media_list: {
    description:
      "Archivio di foto, video e musiche: quelli caricati dall'utente, le grafiche, le immagini IA e i video montati. Ogni file ha id, " +
      "titolo, descrizione, misure (e durata dei video) e dove è già stato usato. Le musiche (kind audio) servono solo per create_video.",
    input_schema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["image", "video", "audio"] }, limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
  },
  media_view: {
    description: "Guarda una foto dell'archivio (per capire cosa mostra e scrivere testi adatti). Dei video montati con create_video vedi la copertina; gli altri video e le musiche non si possono guardare: leggi titolo e descrizione.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  create_graphic: {
    description:
      "Crea una grafica (post, slide di un carosello, copertina) disegnandola in SVG; diventa un JPEG nell'archivio e restituisce il suo id. " +
      "Usa width/height e viewBox uguali al formato: square 1080×1080, portrait 1080×1350 (il migliore per il feed di Instagram), " +
      "story 1080×1920, landscape 1200×675 (X, LinkedIn), banner_x 1500×500 e banner_linkedin 1584×396 (copertine dei profili: " +
      "tieni testo e logo al centro, i bordi vengono coperti dalla foto profilo), youtube_thumb 1280×720 (miniatura di un video YouTube), " +
      "banner_youtube 2560×1440 (copertina del canale: testo e logo SOLO nella fascia centrale di 1546×423, il resto si vede solo sulla TV). Caratteri: Sora (titoli di Venturo), Inter, Montserrat, Bebas Neue, Playfair Display (font-weight 100–900). " +
      "Permessi: forme, testo, gradienti, filtri; per inserire una foto dell'archivio usa <image href=\"media:ID\" …>. Niente emoji né risorse esterne. " +
      "Il testo SVG non va a capo da solo: spezza le righe con più <text> o <tspan>. Margini di almeno 80 px, testo grande e leggibile sul telefono.",
    input_schema: {
      type: "object",
      properties: {
        svg: { type: "string" },
        format: { type: "string", enum: ["square", "portrait", "story", "landscape", "banner_x", "banner_linkedin", "youtube_thumb", "banner_youtube"] },
        title: { type: "string" },
        description: { type: "string", description: "cosa mostra (serve anche come testo alternativo)" },
      },
      required: ["svg", "format", "title"],
    },
  },
  create_diagram: {
    description:
      "Disegna un DIAGRAMMA pulito con i colori e i caratteri di Venturo (gratis): passi la struttura in JSON, il server fa il disegno " +
      "e lo mette nell'archivio come una grafica (id da usare in social_publish, anche come slide di un carosello). Tipi: process = passi " +
      "numerati (2–7: label e text), timeline = date (2–8: date, label, text), funnel = imbuto (2–6: label, value), compare = due colonne " +
      "(left e right con title e items, 1–6 punti; focus sul lato da evidenziare), quadrant = matrice 2×2 (items con label, x e y da 0 a 100, " +
      "x_label, y_label, quadrants = 4 nomi in quest'ordine: alto-sinistra, alto-destra, basso-sinistra, basso-destra), bars = barre " +
      "(2–10: label, value numerico; unit es. \"%\", \"€\", \"mld €\"), cycle = ciclo (3–6 tappe; center = testo al centro). " +
      "focus: true su 1 o al massimo 2 elementi (colore d'accento: la cosa da guardare). Testi brevi: titolo con il numero o la promessa, " +
      "etichette di poche parole. Sempre source per i dati. page (es. \"3/8\") per le slide di un carosello. Più chiaro di un SVG disegnato a mano.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["process", "timeline", "funnel", "compare", "quadrant", "bars", "cycle"] },
        title: { type: "string", description: "massimo 90 caratteri" },
        subtitle: { type: "string" },
        kicker: { type: "string", description: "parola sopra il titolo (es. GUIDA, DATI, BANDO)" },
        items: { type: "array", items: { type: "object" }, description: "elementi del diagramma (vedi i tipi)" },
        left: { type: "object", description: "solo compare: { title, items: [testi], focus }" },
        right: { type: "object", description: "solo compare: { title, items: [testi], focus }" },
        x_label: { type: "string" },
        y_label: { type: "string" },
        quadrants: { type: "array", items: { type: "string" } },
        unit: { type: "string" },
        center: { type: "string" },
        source: { type: "string", description: "fonte e data dei dati" },
        page: { type: "string", description: "numero della slide, es. 2/8" },
        theme: { type: "string", enum: ["chiaro", "notte"] },
        format: { type: "string", enum: ["portrait", "square", "story", "landscape"], description: "portrait 1080×1350 (default, carosello Instagram), square, story, landscape (X, LinkedIn)" },
        description: { type: "string", description: "cosa mostra (testo alternativo)" },
      },
      required: ["type", "title"],
    },
  },
  create_video: {
    description:
      "Monta un video (reel, storia o video per il feed) e lo mette nell'archivio: restituisce l'id da usare in social_publish. È gratis " +
      "(lo monta il nostro server, in qualche decina di secondi). Ogni schermata (slides) ha uno sfondo: media = clip o foto dell'archivio " +
      "(anche di repertorio: stock_search e stock_add; riempie lo schermo, tagliata al centro; per le clip start = secondo da cui partire), " +
      "svg = schermata disegnata come in create_graphic, oppure niente sfondo = solo testo su colore (background). Sopra puoi mettere: " +
      "headline = titolo grande animato (poche parole; le parole tra *asterischi* escono nel colore d'accento), headline_anim (pop, slide, " +
      "typewriter, fade), headline_position (top o center), overlay_svg = grafica trasparente; voice = la frase che la voce narrante " +
      "italiana dice durante la schermata (la schermata dura quanto la frase, i sottotitoli grandi parola per parola sono automatici). " +
      "motion sulle immagini: punch (scatto in avanti), zoom_in, zoom_out, pan_left, pan_right, none. transition: mix (cambia a ogni stacco), " +
      "fade, slideleft, zoomin, fadewhite, ecc. Musica: music = id di una musica dell'archivio (si abbassa da sola quando parla la voce). " +
      "Massimo 30 schermate e 90 secondi. Formati: story 1080×1920 (Reels, storie: il migliore), portrait 1080×1350, square, landscape 1280×720. " +
      "COME SI FA UN VIDEO CHE TIENE INCOLLATI: 1) i primi 2 secondi decidono tutto: domanda forte, numero sorprendente o promessa concreta, " +
      "detti dalla voce e scritti nel headline; 2) cambia immagine ogni 1,5–3 secondi: una frase breve per schermata (8–15 parole), mai due " +
      "schermate uguali di fila, alterna clip vere, foto e schermate di testo; 3) apri un «anello» (\"il terzo errore è il più grave\") e " +
      "chiudilo solo alla fine; 4) numeri e parole chiave nel headline, con *accento*; 5) ultima schermata: invito a seguire o commentare. " +
      "Scrivi la voce come si parla (frasi corte, niente sigle difficili, numeri in cifre). Niente emoji, niente dati inventati, niente promesse di guadagno.",
    input_schema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["story", "portrait", "square", "landscape"] },
        slides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              media: { type: "string", description: "id di una clip o foto dell'archivio (sfondo)" },
              svg: { type: "string", description: "schermata disegnata (sfondo, in alternativa a media)" },
              background: { type: "string", description: "colore #RRGGBB per le schermate di solo testo" },
              headline: { type: "string", description: "titolo animato, poche parole; *parola* = colore d'accento" },
              headline_anim: { type: "string", enum: ["pop", "slide", "typewriter", "fade"] },
              headline_position: { type: "string", enum: ["top", "center"] },
              voice: { type: "string", description: "frase detta dalla voce narrante durante questa schermata" },
              overlay_svg: { type: "string", description: "grafica sopra lo sfondo, con sfondo trasparente" },
              seconds: { type: "number", description: "durata minima; con voice dura almeno quanto la frase" },
              motion: { type: "string", enum: ["punch", "zoom_in", "zoom_out", "pan_left", "pan_right", "none"] },
              start: { type: "number", description: "solo per le clip: secondo da cui partire" },
            },
          },
        },
        transition: { type: "string", enum: ["mix", "fade", "fadeblack", "fadewhite", "slideleft", "slideup", "smoothleft", "circleopen", "dissolve", "zoomin", "hblur", "radial", "none"] },
        music: { type: "string", description: "id di una musica dell'archivio (facoltativa)" },
        music_volume: { type: "number", description: "0–1 (di solito non serve)" },
        accent: { type: "string", description: "colore d'accento #RRGGBB per parole evidenziate e barra (quello del brand)" },
        captions: { type: "boolean", description: "sottotitoli della voce (predefinito: sì)" },
        progress_bar: { type: "boolean", description: "barra di avanzamento in alto (predefinito: sì)" },
        sfx: { type: "boolean", description: "effetti sonori ai cambi e ai titoli (predefinito: sì)" },
        voice_speed: { type: "number", description: "velocità della voce 0.85–1.3 (predefinito 1.08)" },
        title: { type: "string" },
        description: { type: "string", description: "di cosa parla il video (testo alternativo, lo legge anche l'utente)" },
      },
      required: ["format", "slides", "title"],
    },
  },
  create_motion_video: {
    description:
      "Crea un VIDEO ANIMATO DI LIVELLO PROFESSIONALE (motion graphics come le grandi testate economiche: grafici che crescono, numeri " +
      "che scorrono, testi in movimento, tendine tra le scene, logo e colori di Venturo) e lo mette nell'archivio: restituisce l'id da usare " +
      "in social_publish. È gratis (lo disegna il nostro server in 1–3 minuti). PREFERISCILO a create_video per Reel e Shorts di dati, notizie, " +
      "spiegazioni e liste; usa create_video solo per montare clip e foto vere. Non scrivi grafica: descrivi le scene (scenes) e il motore usa " +
      "modelli di marca. Ogni scena ha type e i suoi campi, più: voice = la frase detta dalla voce narrante in quella scena (la scena dura quanto " +
      "la frase; sottotitoli parola per parola automatici), kicker = etichetta piccola sopra (es. «BANDI · NOVEMBRE»), source = fonte del dato " +
      "(scritta in piccolo: OBBLIGATORIA per ogni numero), seconds = durata se non c'è voce. TIPI: " +
      "hook {text (max 90 caratteri: la frase d'aggancio), highlight: [parole da evidenziare]}; " +
      "number {value, prefix, suffix (es. \" mld €\", \"%\"), decimals, label}; " +
      "bars {title, items: [{label, value}] max 7, unit, highlight (label della barra da evidenziare)}; " +
      "line {title, points: [{label, value}] 2–12, unit}; donut {value 0–100, label}; " +
      "compare {title, left: {label, value (testo breve, es. \"6,2%\"), note}, right: {...}}; " +
      "list {title, items: [testi] max 5, ordered}; statement {text max 140, author}; " +
      "media {media = id di foto o clip dell'archivio (anche stock_add), text = titolo sopra, start = secondo di partenza della clip}; " +
      "news {text, ticker = riga che scorre, kicker (predefinito ULTIM'ORA)}; timeline {title, items: [{when, text}] max 5}; " +
      "cta {text (es. \"Mandalo a chi sta aprendo un'attività\"), sub (es. \"Newsletter gratuita · link in bio\")}. " +
      "Massimo 20 scene e 90 secondi. theme: notte (blu, predefinito), chiaro, verde. transition: mix (tendine che cambiano), wipe, fade. " +
      "REGOLE: scena 1 = hook con il gancio (numero shock, domanda con soldi in gioco, errore da evitare) scritto e detto nei primi 2 secondi; " +
      "una scena ogni 2–4 secondi, frasi di voce brevi (8–15 parole) scritte come si parla; alterna tipi diversi; ultima scena = cta che " +
      "spinge a inviare il video («Mandalo a…»); 20–40 secondi per le notizie, 45–75 per le spiegazioni. Dati solo veri, con source; niente " +
      "promesse di guadagno né consigli su singoli titoli. Se la voce è quella clonata dell'utente, nella didascalia del post scrivi «Voce generata con IA».",
    input_schema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["story", "portrait", "square", "landscape"], description: "story 1080×1920 per Reel, storie e Shorts (il migliore)" },
        theme: { type: "string", enum: ["notte", "chiaro", "verde"] },
        accent: { type: "string", description: "colore d'accento #RRGGBB (di solito non serve: c'è quello del tema)" },
        transition: { type: "string", enum: ["mix", "wipe", "fade"] },
        scenes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["hook", "number", "bars", "line", "donut", "compare", "list", "statement", "media", "news", "timeline", "cta"] },
              voice: { type: "string" }, kicker: { type: "string" }, source: { type: "string" }, seconds: { type: "number" },
              text: { type: "string" }, highlight: { type: "array", items: { type: "string" } },
              value: {}, prefix: { type: "string" }, suffix: { type: "string" }, decimals: { type: "integer" }, label: { type: "string" },
              title: { type: "string" }, unit: { type: "string" },
              items: { type: "array", items: {} }, points: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "number" } } } },
              left: { type: "object" }, right: { type: "object" }, ordered: { type: "boolean" }, author: { type: "string" },
              media: { type: "string" }, start: { type: "number" }, ticker: { type: "string" }, sub: { type: "string" },
            },
            required: ["type"],
          },
        },
        music: { type: "string", description: "id di una musica dell'archivio (facoltativa: si abbassa da sola sotto la voce)" },
        music_volume: { type: "number" },
        captions: { type: "boolean", description: "sottotitoli della voce (predefinito: sì)" },
        voice_speed: { type: "number", description: "0.85–1.3 (predefinito 1.06)" },
        title: { type: "string" },
        description: { type: "string", description: "di cosa parla il video" },
      },
      required: ["format", "scenes", "title"],
    },
  },
  stock_search: {
    description:
      "Cerca clip video o foto di repertorio vere su Pixabay e/o Pexels (gratis, uso libero anche commerciale) e te ne mostra le anteprime: guardale e " +
      "scegli quelle adatte, poi scaricale con stock_add. Cerca in inglese con parole concrete (es. \"business meeting\", \"stock market " +
      "screen\", \"entrepreneur laptop night\", \"handshake office\", \"milan skyline\"). orientation portrait per i reel, landscape " +
      "per X e LinkedIn orizzontali (le clip si adattano comunque al formato, tagliate al centro). Funziona solo se l'utente ha messo " +
      "la chiave di Pixabay o di Pexels.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", enum: ["video", "photo"] },
        orientation: { type: "string", enum: ["portrait", "landscape", "square"] },
        limit: { type: "integer", minimum: 1, maximum: 8 },
      },
      required: ["query"],
    },
  },
  stock_add: {
    description: "Scarica nell'archivio una clip o foto trovata con stock_search (id pv…, pp…, xv…, xp…) e restituisce l'id dell'archivio da usare in create_video o nei post. Se l'hai già scaricata restituisce quella.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
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

// Chi prepara o pubblica contenuti riceve da solo gli strumenti delle 💡 Idee dell'utente.
const CONTENT_TOOLS = ["social_publish", "social_status", "social_stats", "create_graphic", "create_diagram", "create_video", "create_motion_video", "generate_image"];

/** Strumenti abilitati: chi può aprire posizioni (place_order) può anche chiuderle (close_position). */
export function enabledTools(agent) {
  const set = new Set(agent.tools);
  if (agent.canTrade && set.has("place_order")) set.add("close_position");
  if (CONTENT_TOOLS.some((t) => set.has(t))) {
    set.add("ideas");
    set.add("idea_used");
  }
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

/** Strumento backtest: ogni sistema su ogni mercato, risultati in breve (le operazioni restano nell'archivio delle prove). */
async function backtestTool(input, accountId) {
  if (input.system === "elenco") return { sistemi: describeSystems() };
  const systems = input.system === "tutti" ? SYSTEM_NAMES : [input.system];
  if (!systems.every((x) => SYSTEM_NAMES.includes(x))) throw new Error(`Sistema sconosciuto: ${input.system}. Usa ${SYSTEM_NAMES.join(", ")}, «tutti» o «elenco».`);
  const symbols = [...new Set((Array.isArray(input.symbols) ? input.symbols : [input.symbol]).filter(Boolean).map((x) => String(x).toUpperCase()))].slice(0, 8);
  if (!symbols.length) throw new Error("Indica i mercati in symbols (es. [\"XAUUSD\", \"US500\"]).");
  const bars = Math.min(Math.max(Number(input.bars) || 3000, 300), 8000);
  const riskPct = Math.min(Math.max(Number(input.risk_pct) || 0.5, 0.05), 2);
  const results = [];
  for (const symbol of symbols) {
    let h;
    let period = input.period;
    try {
      try {
        h = await longHistory(symbol, { accountId, period: period ?? "H4", bars });
        period = h.period;
      } catch (err) {
        if (period || !/solo per gli strumenti del broker/.test(err.message)) throw err;
        period = "D1"; // azione o ETF di Yahoo: solo giornaliero
        h = await longHistory(symbol, { accountId, period, bars });
      }
    } catch (err) {
      results.push({ mercato: symbol, errore: err.message });
      continue;
    }
    if (h.candles.length < 300) {
      results.push({ mercato: symbol, errore: `solo ${h.candles.length} candele: troppo poche per una prova seria` });
      continue;
    }
    const onBroker = String(h.source).startsWith("ctrader");
    const costPct = input.cost_pct != null ? Math.max(0, Number(input.cost_pct)) : onBroker ? 0.01 : 0.1;
    // Sul broker la chiusura del venerdì (se è attiva) chiude tutte le posizioni degli agenti: la prova fa lo stesso.
    const flatWeekend = onBroker && (input.flat_weekend ?? getSchedule().fridayClose?.enabled !== false);
    for (const system of systems) {
      const r = runBacktest(h.candles, system, input.params ?? {}, { spread: h.spread ?? 0, costPct, riskPct, flatWeekend });
      const saved = saveBacktest({ ...r, symbol: h.symbol ?? symbol, period, source: h.source, spread: h.spread ?? null, costPct, riskPct, flatWeekend });
      results.push({
        sistema: system,
        mercato: saved.symbol,
        periodo: period,
        dati: `${r.from} → ${r.to} (${r.candles} candele, ${h.source}${flatWeekend ? ", tutto chiuso il venerdì sera" : ""})`,
        operazioni: r.trades,
        vinte_pct: r.winRate,
        guadagno_medio_R: r.expectancyR,
        fattore_profitto: r.profitFactor,
        totale_R: r.totalR,
        perdita_max_R: r.maxDrawdownR,
        [`rendimento_pct_rischiando_${riskPct}`]: r.returnPct,
        all_anno_pct: r.yearlyPct ?? null,
        perdita_max_pct: r.maxDrawdownPct,
        comprare_e_tenere_pct: r.buyHoldPct,
        ultimo_30pct_dati: { operazioni: r.outSample.trades, guadagno_medio_R: r.outSample.expectancyR, fattore_profitto: r.outSample.profitFactor },
        verdetto: `${r.verdict.esito}: ${r.verdict.motivo}`,
        id_prova: saved.id,
      });
    }
  }
  return { risultati: results, nota: "Prove sul passato con costi stimati: non garantiscono i risultati futuri. Opera solo con i sistemi SUPERATI, e ripeti la prova ogni mese." };
}

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
    case "get_costs":
      return spendingReport(office.agents(), building ?? office.building(), { period: input.period || "mese", palace: input.palace || null, top: input.top });
    case "read_notes": {
      const visible = readableRooms(agent, building).map((r) => r.id);
      if (!visible.includes(input.room)) {
        throw new Error(`Non hai accesso alla stanza ${input.room} (stanza di un piano non collegato?). Accessibili: ${visible.join(", ")}`);
      }
      // Note molto lunghe accorciate: ogni carattere letto si paga (una nota lunga letta da molti agenti costa tanto).
      return readNotes(input.room, Math.min(input.limit ?? 10, 30)).map((n) => (n.text?.length > 2500 ? { ...n, text: `${n.text.slice(0, 2500)}… [nota accorciata]` } : n));
    }
    case "post_note": {
      const tags = input.tags ?? [];
      const problem = isRequestNote(input.text, tags) ? requestProblem(input.text) : null;
      const note = postNote(agent.room, agent, input.text, tags);
      return problem ? { ...note, avviso: `Domanda NON inviata all'utente: ${problem}. La nota resta solo in bacheca.` } : note;
    }
    case "get_portfolio":
      return portfolioFor(agent);
    case "my_portfolio":
      return holdings.forAgents();
    case "send_signal":
      return holdings.proposeSignal(agent, input);
    case "company_financials":
      return marketdata.companyFinancials(String(input.ticker ?? ""));
    case "fund_holdings":
      return marketdata.fundHoldings(input);
    case "ipo_calendar":
      return marketdata.ipoCalendar(input);
    case "earnings_calendar":
      return marketdata.earningsCalendar(input);
    case "company_news":
      return marketdata.companyNews(input);
    case "trade_journal":
      return tradeJournal(input);
    case "backtest":
      return backtestTool(input, accountId);
    case "ideas":
      return ideas.ideasTool(input);
    case "idea_used":
      return ideas.markUsed(input, { by: agent.name });
    case "week_notes":
      return weekNotes(agent, input, building ?? office.building());
    case "weekly_report": {
      const b = building ?? office.building();
      const palaceId = palaceOfAgent(agent, b);
      const palace = b.palaces.find((p) => p.id === palaceId) ?? null;
      const include = new Set((Array.isArray(input.include) ? input.include : []).filter((x) => REPORT_INCLUDES.includes(x)));
      const auto = {};
      if (include.has("spesa")) auto.spesa = spesaHtml(spendingReport(office.agents(), b, { period: "settimana", palace: palaceId, top: 12 }));
      if (include.has("operazioni")) auto.operazioni = operazioniHtml(await tradeJournal({ days: 7 }));
      const r = await createReport(agent, input, { palace: palace && { id: palace.id, name: palace.name }, auto });
      const mail = r.email.status === "sent" ? `inviato per email a ${r.email.to}` : r.email.status === "failed" ? `email NON partita: ${r.email.error}` : "email non impostata dall'utente: il report è solo in 📄 Report";
      return { id: r.id, file: r.type, pagine: r.type === "pdf" ? "PDF" : "pagina HTML (Chrome non disponibile)", email: mail, message: `Report salvato in 📄 Report, ${mail}.` };
    }
    case "web_buzz":
      return buzz(input);
    case "read_feeds":
      return readFeeds(input);
    case "read_page":
      return readPage(input);
    case "social_status":
      return social.statusForAgents();
    case "social_publish":
      // Testi con i segni tipici dell'IA: la prima volta si fanno riscrivere (vedi lib/style.js).
      assertHumanText(agent.id, input.text, "Il post");
      return social.proposePost(agent, input);
    case "social_stats":
      return social.stats(String(input.network ?? ""), { limit: input.limit });
    case "social_comments":
      return social.comments(String(input.network ?? ""), input.post_id);
    case "social_inbox":
      return social.inbox(String(input.network ?? ""), { days: input.days, includeSeen: Boolean(input.include_seen) });
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
    case "create_diagram": {
      assertHumanText(agent.id, textsOf(input), "Il diagramma");
      const { src, thumb, ...m } = await createDiagram(input, { by: agent.name });
      return { ...m, message: "Diagramma salvato nell'archivio: usa questo id in social_publish. Se vuoi controllarlo, guardalo con media_view." };
    }
    case "create_video": {
      assertHumanText(agent.id, textsOf(input), "Il video");
      const { src, thumb, ...m } = await createVideo({ ...input, by: agent.name });
      return { ...m, message: "Video salvato nell'archivio: usa questo id in social_publish (un video va da solo nel post). Puoi controllarne la copertina con media_view." };
    }
    case "create_motion_video": {
      assertHumanText(agent.id, textsOf(input), "Il video");
      const { src, thumb, ...m } = await createMotionVideo({ ...input, by: agent.name });
      return { ...m, message: "Video animato salvato nell'archivio: usa questo id in social_publish (un video va da solo nel post). Puoi controllarne la copertina con media_view." };
    }
    case "stock_search": {
      const { items, previews } = await searchStock({ ...input });
      if (!items.length) return { items: [], message: "Nessun risultato: prova con altre parole (in inglese, concrete)." };
      // Le anteprime si guardano: ognuna è seguita dal suo id (vedi runner.js per i risultati con immagini).
      const content = [];
      for (const p of previews) {
        const it = items.find((x) => x.id === p.id);
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.base64 } });
        content.push({ type: "text", text: `${it.id}: ${it.title || "senza titolo"}${it.seconds ? ` (${it.seconds} s)` : ""}` });
      }
      content.push({ type: "text", text: JSON.stringify({ items, message: "Scarica quelle che usi con stock_add (id)." }) });
      return { toolContent: content };
    }
    case "stock_add": {
      const { src, thumb, ...m } = await addStock(String(input.id ?? ""), { by: agent.name });
      return { ...m, message: m.already ? "Era già nell'archivio: usa questo id." : "Scaricato nell'archivio: usa questo id in create_video (media) o nei post." };
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

/** Note recenti di tutte le stanze di un palazzo (per i report settimanali), accorciate. */
function weekNotes(agent, input, b) {
  const palace = input.palace ? String(input.palace) : palaceOfAgent(agent, b);
  if (!b.palaces.some((p) => p.id === palace)) throw new Error(`il palazzo "${palace}" non esiste: ${b.palaces.map((p) => p.id).join(", ")}`);
  const days = Math.min(Math.max(Number(input.days) || 7, 1), 14);
  const perRoom = Math.min(Math.max(Number(input.per_room) || 8, 1), 20);
  const since = Date.now() - days * 86_400_000;
  const floors = b.floors.filter((f) => f.palace === palace && (!input.floor || f.id === input.floor));
  if (input.floor && !floors.length) throw new Error(`il piano "${input.floor}" non è nel palazzo ${palace}`);
  let budget = 45_000; // caratteri: oltre si smette (ogni carattere letto si paga)
  const out = [];
  for (const f of floors) {
    for (const r of b.rooms.filter((x) => x.floor === f.id)) {
      const notes = readNotes(r.id, perRoom).filter((n) => Date.parse(n.at) >= since).reverse();
      if (!notes.length) continue;
      const list = [];
      for (const n of notes) {
        const text = n.text?.length > 700 ? `${n.text.slice(0, 700)}…` : String(n.text ?? "");
        if (budget - text.length < 0) break;
        budget -= text.length;
        list.push({ at: n.at, agente: n.agentName, testo: text, ...(n.tags?.length ? { tags: n.tags } : {}) });
      }
      if (list.length) out.push({ piano: f.name, stanza: r.name, id: r.id, note: list });
    }
  }
  return { palazzo: palace, giorni: days, stanze: out, ...(budget <= 0 ? { nota: "elenco accorciato: chiedi un piano per volta con floor" } : {}) };
}
