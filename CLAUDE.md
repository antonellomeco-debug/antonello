# Note per Claude (passaggio di consegne)

Questo file viene letto in automatico da Claude Code all'inizio di ogni sessione: riassume il progetto,
le decisioni prese e a che punto siamo. Aggiornalo quando cambia qualcosa di importante.

## L'utente

- Antonello, italiano, usa un **Mac** e **non è un programmatore**: rispondi in italiano, con passi numerati
  semplici, niente gergo. Prima di cose difficili da annullare chiedi conferma.
- Avvia il programma con l'icona **Avvia Agenti** sulla Scrivania (oppure `npm start`) e si aggiorna con il
  pulsante **🔄 Aggiorna** dell'app, che scarica l'ultima versione da GitHub (repository
  `antonellomeco-debug/antonello`, ramo predefinito: `claude/sharp-mccarthy-231pjj`; l'aggiornamento legge
  `commits/HEAD`, cioè il ramo predefinito). Le modifiche fatte su altri rami arrivano all'utente solo dopo
  l'unione nel ramo predefinito.
  Ogni push su quel ramo arriva quindi all'utente: pubblica solo codice provato (`npm test` verde).
- Broker: **FP Markets**, piattaforma **cTrader**, per ora **conto demo**. Budget per i servizi ~10 €/mese.

## Il progetto

App locale (Node 22, Express 5, three.js) che imita l'interfaccia di "Ivot": un **palazzo** 3D di agenti IA
per analizzare i mercati e fare trading. Ogni **piano** è un settore, con **stanze** e **agenti**; i piani si
possono **collegare** (anche in un solo senso) per scambiarsi le informazioni. **Orion** è il regista con cui
si parla in chat e che può creare/modificare piani, stanze, agenti e collegamenti.

- Agenti `llm` (Claude con strumenti, `lib/runner.js` + `lib/tools.js`) o `rule` (strategie JS in `strategies/`).
- Approvazioni: gli agenti propongono ordini, l'utente sceglie "Fallo per me" o "Scarta".
- Dati utente in `data/` (mai toccata dagli aggiornamenti); valori iniziali in `defaults/`.
- Struttura dei file e dettagli: `README.md`. Guida per l'utente: `GUIDA-MAC.md` (Parte 4 = cTrader).

## cTrader (ultima grande funzione)

- `lib/ctrader/`: protocollo Open API (protobuf su TLS 5035), connessione, OAuth, servizio (conti, prezzi,
  candele, posizioni, ordini). File `.proto` ufficiali in `lib/ctrader/proto/`.
- Ogni piano opera su `trading: {mode:"paper"}` oppure `{mode:"ctrader", accountId}` (`lib/broker.js`).
- Sicurezza (`lib/safety.js`, modificabile solo dall'interfaccia): STOP, limiti, perdita massima del giorno
  (blocca il conto fino al giorno UTC dopo), stop loss predefinito, conto **reale bloccato** finché l'utente
  non scrive "SOLDI VERI". Orion e gli agenti non possono collegare conti reali né cambiare la sicurezza.
- I server veri di cTrader **non sono raggiungibili dal container cloud**: si prova con il finto server
  `test/helpers/fake-ctrader.js` (test in `test/ctrader.test.js` e `test/broker.test.js`).
- Pagina di accesso usata: `https://id.ctrader.com/my/settings/openapi/grantingaccess/` (documentazione
  ufficiale 2026), scambio del codice su `https://openapi.ctrader.com/apps/token`. Redirect URI:
  `http://localhost:3000/ctrader/callback`.

## Orario di lavoro, calendario, giorno e ora (13 ottobre 2026)

- `lib/schedule.js`: orario di lavoro degli agenti programmati in ora italiana (`Europe/Rome`, con l'ora legale),
  salvato in `data/settings.json` (chiave `schedule`), di partenza lun–ven 07:30–22:30, attivo. Fuori orario lo
  scheduler di `server.js` non avvia agenti; al passaggio fuori orario → in orario svuota `lastRun`, così tutti
  ripartono come all'apertura. **Chiusura del venerdì** (di partenza 21:45): `closeAgentPositionsEverywhere()`
  in `lib/broker.js` (usata anche dallo STOP) chiude le posizioni con etichetta `agenti` su tutti i conti
  collegati, riprova ogni minuto finché ne resta qualcuna. Interfaccia: ⚙️ Impostazioni → 🕒 Orario; avviso
  "⏸ Fuori orario" nell'Ufficio (`/api/stats` → `schedule`, `/api/schedule` GET/PUT).
- Giorno e ora: `firstMessage()` in `lib/runner.js` mette "Adesso è lunedì 19/10/2026, ore 07:45 (ora italiana;
  … UTC)." all'inizio di ogni lavoro (anche con un compito); Orion riceve la stessa riga tra [ ] in ogni
  messaggio dell'utente.
- `lib/calendar.js` + strumento `get_calendar` (agenti e Orion): calendario Forex Factory con cache di 60 minuti in
  `data/calendar.json`. Fonti in ordine: copia QuarkFX su raw.githubusercontent.com (21 giorni, con i dati usciti,
  orari UTC), la stessa su jsDelivr, file ufficiale `nfs.faireconomy.media/ff_calendar_thisweek.json` (orari di
  New York con il fuso). Dal container sono bloccati jsDelivr e faireconomy: si prova solo la copia su GitHub
  (con `NODE_USE_ENV_PROXY=1`).
- Notizie dal web: strumento `web_search` (agenti e Orion) = ricerca web di Anthropic eseguita dai server di Claude
  (`WEB_SEARCH_TOOL` in `lib/tools.js`, tipo `web_search_20250305` per andare con tutti i modelli, `max_uses` 5).
  `stop_reason: "pause_turn"` → si rimanda la conversazione così com'è (runner e Orion). Costo: 10 $ ogni 1.000
  ricerche (`usage.server_tool_use.web_search_requests`, sommato in `addUsage`). Se l'organizzazione l'ha
  disattivata, `friendlyError` rimanda a platform.claude.com/settings/capabilities. Test: `test/websearch.test.js`
  (finto server dell'API di Claude via `ANTHROPIC_BASE_URL`).

## Piano Gold (XAUUSD) per Orion

- L'utente ha una pagina (artifact claude.ai "Piano Gold per Orion") con i messaggi da incollare a Orion:
  1–5 costruiscono il piano Gold (7 stanze, 33 agenti, quasi tutti `claude-haiku-5-5`; solo il Capo Trader
  propone ordini), A automatizza la routine, B (facoltativo) toglie l'approvazione al Capo Trader sul demo,
  C usa il calendario automatico e il nuovo giorno/ora, D dà `web_search` alla Rassegna Notizie (ogni ora),
  a Sentiment e Posizionamento (2 volte al giorno) e a Fed e Tassi, e alza a 20 la lettura di gold-agenda per il
  Capo Trader e il Capo Fondamentale (le notizie orarie spingerebbero fuori CALENDARIO OGGI e LIVELLI).
  Gli agenti del piano stanno in `data/agents/` dell'utente: si cambiano solo tramite Orion o dall'interfaccia.

## A che punto siamo (13 ottobre 2026)

- L'utente ha aperto il conto demo e sta **registrando l'app** su openapi.ctrader.com/apps. Nel modulo deve
  spuntare solo **"Access your accounts and trade"** e lasciare vuoto il sito web; poi aspettare lo stato
  **Active** (1–3 giorni lavorativi).
- Prossimi passi: incollare Client ID e Secret in 🔌 Broker → Collega cTrader → assegnare i piani al conto
  demo → provare con le approvazioni attive. Al primo collegamento vero possono emergere differenze rispetto al
  finto server: chiedere all'utente il messaggio d'errore esatto (mai il Secret).
- Da verificare con il broker: che il conto sia di tipo **hedging** (i conti netting sono rifiutati).

## Come lavorare

- Test: `npm test` (devono passare tutti prima di ogni push).
- Prova dell'interfaccia: avviare il server con `AGENTI_DATA_DIR` in una cartella temporanea e
  `MARKET_MODE=demo`; per cTrader usare il finto server (variabili `CTRADER_TLS=0`, `CTRADER_DEMO_HOST`,
  `CTRADER_LIVE_HOST`, `CTRADER_PORT`, `CTRADER_AUTH_URL`, `CTRADER_TOKEN_URL`).
- Per fermare processi usare `pgrep -f "^node "`: un'espressione che compare nel proprio comando ferma anche la shell.
- Dal container, Node raggiunge GitHub solo con `NODE_USE_ENV_PROXY=1`.
- Modello Claude usato dagli agenti e da Orion: `claude-opus-5-5`. Orion: il prompt di sistema resta fisso,
  lo stato del palazzo arriva come messaggio `system` in coda (cronologia solo in aggiunta).
