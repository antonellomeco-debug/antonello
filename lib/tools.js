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
import { createVideo } from "./social/video.js";
import { createMotionVideo } from "./social/motion.js";
import { searchStock, addStock } from "./social/stock.js";
import { spendingReport, PERIODS as COST_PERIODS } from "./costs.js";
import { office } from "./office.js";

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
      "(informazioni, foto, documenti che solo lui ha) usa l'etichetta RICHIESTA: la domanda gli arriva in ✅ Approvazioni e la sua " +
      "risposta compare nella bacheca della tua stanza (nota RISPOSTA DELL'UTENTE). Una domanda chiara per nota, senza ripeterla. " +
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
      "X costa 0,015 $ a post e 0,20 $ se il testo contiene un link. Non inventare dati né promesse: il post esce a nome dell'utente. " +
      "Se il social non è collegato il post va in Approvazioni e lo pubblica l'utente a mano con un tocco (solo post singoli, " +
      "niente reply_to): prepara tutto pronto da incollare.",
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
  social_inbox: {
    description:
      "Commenti NUOVI sotto i post recenti (Instagram, Threads, X) a cui non ha ancora risposto nessuno: ognuno con comment_id, " +
      "il post a cui si riferisce, chi l'ha scritto e il testo. I commenti mostrati non tornano la volta dopo (salvo include_seen) e " +
      "quelli già risposti nemmeno. Per rispondere: social_publish con reply_to = comment_id. Su X leggere costa 0,005 $ a commento.",
    input_schema: {
      type: "object",
      properties: {
        network: { type: "string", enum: ["instagram", "threads", "x"] },
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
      "tieni testo e logo al centro, i bordi vengono coperti dalla foto profilo). Caratteri: Montserrat, Inter, Bebas Neue, Playfair Display (font-weight 100–900). " +
      "Permessi: forme, testo, gradienti, filtri; per inserire una foto dell'archivio usa <image href=\"media:ID\" …>. Niente emoji né risorse esterne. " +
      "Il testo SVG non va a capo da solo: spezza le righe con più <text> o <tspan>. Margini di almeno 80 px, testo grande e leggibile sul telefono.",
    input_schema: {
      type: "object",
      properties: {
        svg: { type: "string" },
        format: { type: "string", enum: ["square", "portrait", "story", "landscape", "banner_x", "banner_linkedin"] },
        title: { type: "string" },
        description: { type: "string", description: "cosa mostra (serve anche come testo alternativo)" },
      },
      required: ["svg", "format", "title"],
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
    case "create_video": {
      const { src, thumb, ...m } = await createVideo({ ...input, by: agent.name });
      return { ...m, message: "Video salvato nell'archivio: usa questo id in social_publish (un video va da solo nel post). Puoi controllarne la copertina con media_view." };
    }
    case "create_motion_video": {
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
