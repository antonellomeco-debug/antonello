# Note per Claude (passaggio di consegne)

Questo file viene letto in automatico da Claude Code all'inizio di ogni sessione: riassume il progetto,
le decisioni prese e a che punto siamo. Aggiornalo quando cambia qualcosa di importante.

## L'utente

- Antonello, italiano, usa un **Mac** e **non è un programmatore**: rispondi in italiano, con passi numerati
  semplici, niente gergo. Prima di cose difficili da annullare chiedi conferma.
- Avvia il programma con l'icona **Avvia Agenti** sulla Scrivania (oppure `npm start`) e si aggiorna con il
  pulsante **🔄 Aggiorna** dell'app, che scarica l'ultima versione da GitHub (repository
  `antonellomeco-debug/antonello`, ramo predefinito: oggi è `claude/sharp-mccarthy-231pjj`, l'unico ramo).
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
