# 🏢 Ufficio Agenti — borsa (simulazione e broker cTrader)

> 🍎 **Non sei pratico di programmazione? Segui la [guida passo passo per Mac](GUIDA-MAC.md).**

Un **palazzo** virtuale in 3D di agenti che analizzano i mercati. Il palazzo ha più **piani**: ogni piano gestisce un settore (es. Azioni, Crypto) e contiene **stanze**, isole sospese attorno a una colonna centrale. In cima c'è il **regista** (Orion). Ogni agente siede alla sua scrivania, lavora da solo (su richiesta o a intervalli) e pubblica i risultati nella **bacheca** della stanza. Gli altri agenti leggono quelle bacheche, così il lavoro passa da una stanza all'altra. I piani **collegati** si scambiano informazioni.

Cosa trovi nell'interfaccia:

- **Ufficio**: il palazzo in 3D. Con l'ascensore scegli un piano o tutto il palazzo; trascini per girare. L'etichetta di un agente (nome e stato) compare passando il mouse sopra di lui; i fumetti con le note appaiono da soli sul piano in primo piano. Clicchi una scrivania per aprire la scheda dell'agente, clicchi il nome di una stanza per avvicinarti. In alto ci sono i numeri dell'ufficio e il valore del portafoglio.
- **Palazzo**: crei e modifichi piani e stanze, e decidi quali piani comunicano tra loro.
- **Parla con Orion**: chat con il regista. Puoi chiedergli cosa succede, far lavorare gli agenti, oppure **creare e modificare agenti, piani, stanze e collegamenti descrivendoli a parole**.
- **Approvazioni**: gli agenti *propongono* gli ordini e tu scegli "Fallo per me" o "Scarta".
- **Broker**: colleghi un conto **cTrader** (demo o reale), scegli su quale conto opera ogni piano e gestisci le protezioni (STOP, limiti, perdita massima del giorno).
- **⚙️ Impostazioni**: chiave di Claude, **orario di lavoro degli agenti** (giorni e ore in cui lo scheduler li fa partire, chiusura delle posizioni il venerdì sera) e aggiornamenti.
- **Bacheca**, **Portafoglio**, **Attività**.

> ⚠️ **Simulazione per default.** Finché non colleghi un piano a un conto cTrader, gli ordini sono eseguiti su un portafoglio virtuale (`paper trading`). Il conto reale è bloccato finché non lo sblocchi tu. Non è una consulenza finanziaria.

## Avvio

Serve [Node.js](https://nodejs.org) 20 o più recente.

```bash
npm install
npm start              # apre da solo il browser su http://localhost:3000
npm run collegamento   # (solo Mac) crea sulla Scrivania l'icona "Avvia Agenti"
```

La chiave di Claude serve solo per gli agenti in modalità `llm` e per la chat. Si inserisce dall'app in **⚙️ Impostazioni**: viene verificata e salvata solo sul tuo computer, in `data/settings.json`. In alternativa puoi impostare la variabile `ANTHROPIC_API_KEY`.

Variabili facoltative:

- `PORT` (default 3000)
- `HOST` (default `127.0.0.1`: l'app è raggiungibile solo da questo computer)
- `OPEN_BROWSER=0` (non apre il browser all'avvio)
- `INITIAL_CASH` (default 100000)
- `MARKET_MODE=demo` (prezzi simulati, utile offline)
- `ASSISTANT_NAME` (default Orion)
- `ASSISTANT_MODEL` (default claude-opus-5-5)
- `CALENDAR_URLS` (fonti del calendario economico separate da virgole; servono ai test) e `CALENDAR_TTL_MIN` (default 60: ogni quanto riscaricarlo)

La spesa API mostrata nell'ufficio è una stima calcolata dai token usati.

I prezzi arrivano da Yahoo Finance (ticker come `AAPL`, `ENI.MI`, `^GSPC`). Se il servizio non risponde, l'app usa prezzi simulati e li segnala come `demo`.

## Il palazzo: piani, stanze e collegamenti

Il palazzo si trova in `data/building.json`. Si modifica dall'app (sezione **🏗️ Palazzo**) o chiedendo a Orion. Al primo avvio di una nuova installazione viene copiato da [`defaults/building.json`](defaults/building.json). Chi arriva dalla versione senza piani (con `rooms.json` e `agents/` nella cartella del programma, oppure con un vecchio `data/state.json`) trova invece tutte le stanze su un unico piano: così gli agenti continuano a leggere le stesse stanze di prima. La cartella `agents/` viene importata e poi rinominata in `agents-importati`.

| Piano | Settore | Stanze |
|---|---|---|
| 1° Piano · Azioni | Azioni e indici | Sala Ricerca, Analisi Tecnica, Risk Room, Trading Desk |
| Piano Terra · Direzione | Coordinamento | Direzione |

Collegamento di partenza: **1° Piano → Piano Terra**, in un solo senso. La Direzione legge il lavoro del piano Azioni, ma non viceversa.

Cosa può leggere un agente (`read_notes`):

- la propria stanza;
- le stanze del proprio piano elencate in `readsFrom`;
- **tutte** le stanze dei piani collegati che mandano informazioni al suo piano.

Ogni collegamento ha tre proprietà:

- `direction`: `"both"` (si leggono a vicenda) oppure `"one-way"` (da `from` verso `to`);
- `active`: si può spegnere senza cancellarlo;
- è unico per ogni coppia di piani.

## Programmare un agente

Ogni agente è un file JSON in `data/agents/`; quelli di partenza vengono copiati da [`defaults/agents/`](defaults/agents). Puoi modificarlo a mano oppure dall'interfaccia: clicca un agente nel palazzo, o usa **+ Nuovo agente**. Esistono due modalità.

### 1. Modalità `llm`: descrivi il compito a parole

```json
{
  "id": "trader",
  "name": "Trader",
  "avatar": "💼",
  "room": "trading",
  "mode": "llm",
  "everyMinutes": 0,
  "watchlist": ["AAPL", "MSFT", "ENI.MI"],
  "readsFrom": ["ricerca", "analisi", "rischio"],
  "tools": ["get_quote", "get_indicators", "read_notes", "post_note", "get_portfolio", "place_order"],
  "canTrade": true,
  "limits": { "maxOrderPct": 5, "maxPositionPct": 15, "onlyWatchlist": true },
  "model": "claude-opus-5-5",
  "effort": "high",
  "instructions": "Leggi le note delle altre stanze e decidi se comprare o vendere…"
}
```

Claude esegue le `instructions` usando solo gli strumenti abilitati in `tools`:

| Strumento | Cosa fa |
|---|---|
| `get_quote` | Ultimo prezzo e variazione (con cTrader: bid/ask del broker) |
| `get_indicators` | SMA20/50, RSI14, volatilità annualizzata, rendimenti su 5/20/60 candele (`return5d`… con D1, `return5_H1`… con altri periodi); con cTrader anche su candele M1…W1 |
| `get_candles` | Ultime candele (con cTrader: periodi M1, M5, M15, M30, H1, H4, D1, W1) |
| `search_symbols` | Cerca gli strumenti disponibili sul broker cTrader |
| `get_calendar` | Calendario economico (Forex Factory) con giorno e ora italiana, impatto, previsione, dato precedente e dato uscito; filtri per periodo (`oggi`, `domani`, `ieri`, `settimana`, `7giorni`), valute e impatto minimo |
| `web_search` | Cerca su internet notizie e informazioni aggiornate, con le fonti (la ricerca la fanno i server di Claude: 10 $ ogni 1.000 ricerche più i token dei risultati, al massimo 5 ricerche per lavoro) |
| `read_notes` | Legge la propria stanza, le stanze del proprio piano scelte in `readsFrom` e tutte quelle dei piani collegati che mandano informazioni al suo piano |
| `post_note` | Pubblica nella bacheca della propria stanza |
| `get_portfolio` | Liquidità o saldo, posizioni, P&L del conto del suo piano |
| `place_order` | Ordine sul conto del suo piano: simulato (`qty`) oppure cTrader (`lots`, `stop_loss_pct`, `take_profit_pct`); richiede `canTrade: true` |
| `close_position` | Chiude (anche in parte) una posizione cTrader aperta dallo stesso agente; è sempre disponibile per chi ha `place_order` |

`effort` (`low` … `max`) regola quanto a fondo ragiona il modello: più è alto, più l'analisi è accurata e più costa.

### 2. Modalità `rule`: una strategia in JavaScript

```json
{ "id": "tecnico_sma", "room": "analisi", "mode": "rule",
  "strategy": "sma_cross", "params": { "fast": 20, "slow": 50 },
  "everyMinutes": 60, "watchlist": ["AAPL", "MSFT"] }
```

Le strategie si trovano in [`strategies/`](strategies). Quelle già incluse sono `sma_cross`, `rsi_reversion` e `risk_monitor`. Per scriverne una tua, copia [`strategies/_template.js`](strategies/_template.js): ricevi un `ctx` con dati di mercato, indicatori, bacheche, il conto del piano (simulato o cTrader) e gli ordini, soggetti ad approvazioni e a Broker → Sicurezza. Questa modalità non richiede una chiave API e non ha costi.

### Campi comuni

- `everyMinutes`: lo scheduler esegue l'agente ogni N minuti (`0` = solo a mano), solo nell'**orario di lavoro** (vedi sotto).
- `enabled`: se `false`, lo scheduler lo ignora.
- `limits.maxOrderPct` / `limits.maxPositionPct`: percentuale massima del portafoglio per un singolo ordine e per un singolo titolo (solo portafoglio simulato; sui conti cTrader valgono i limiti di Broker → Sicurezza).
- `limits.onlyWatchlist`: l'agente può operare solo sui titoli della sua watchlist.
- `limits.requireApproval` (default `true`): ogni ordine finisce in **Approvazioni** e parte solo con il tuo ok. Con `false` l'agente esegue da solo sul conto del suo piano, sempre entro le regole di **Broker → Sicurezza**.

### Orario di lavoro, giorno e ora

- **Orario di lavoro** (`lib/schedule.js`, salvato in `data/settings.json`, si cambia da **⚙️ Impostazioni**): lo scheduler fa partire gli agenti solo nei giorni e nelle ore scelti, in ora italiana (di partenza dal lunedì al venerdì, 07:30–22:30). Quando l'orario ricomincia, tutti gli agenti programmati ripartono come all'apertura del programma. Fuori orario Orion risponde e i pulsanti ▶ funzionano.
- **Chiusura del venerdì**: dall'ora scelta (di partenza le 21:45) il programma chiude le posizioni aperte dagli agenti su tutti i conti cTrader e riprova ogni minuto finché ne resta qualcuna.
- **Giorno e ora**: il primo messaggio di ogni lavoro di un agente (anche con un compito) e ogni messaggio a Orion iniziano con giorno della settimana, data e ora italiana.

### Calendario economico

`lib/calendar.js` scarica il calendario di Forex Factory al massimo una volta ogni ora e lo salva in `data/calendar.json`, così resta disponibile anche se la fonte per un po' non risponde (lo strumento lo segnala con un `avviso`). Fonti, in ordine: la copia pubblica su GitHub del progetto QuarkFX (tre settimane, con i dati usciti), la stessa su jsDelivr, il file ufficiale `ff_calendar_thisweek.json`. Gli orari sono convertiti in ora italiana.

### Notizie dal web

Lo strumento `web_search` (anche per Orion) usa la ricerca web di Anthropic: la eseguono i server di Claude, quindi non serve un altro abbonamento né un'altra chiave. Un agente con `web_search` tra i suoi strumenti e un `everyMinutes` trova e pubblica da solo le notizie (per esempio sull'oro) senza che l'utente le incolli. Ogni ricerca costa 1 centesimo di dollaro più i token dei risultati e viene sommata nella stima dei costi. Se l'organizzazione Anthropic ha disattivato la ricerca web, l'errore spiega come riattivarla (platform.claude.com/settings/capabilities). Le ricerche lunghe possono fermarsi a metà (`stop_reason: "pause_turn"`): il programma rimanda la conversazione così com'è e la ricerca riprende. Test: `test/websearch.test.js`, con un finto server dell'API di Claude.

## Broker cTrader e sicurezza

Il collegamento usa la [cTrader Open API](https://help.ctrader.com/open-api/) (protocollo Protobuf su TLS, porta 5035; accesso OAuth). I passi per l'utente sono nella [guida per Mac](GUIDA-MAC.md#parte-4--collegare-il-broker-ctrader-conto-demo).

- **Dati**: se cTrader è collegato e lo strumento esiste sul conto "Dati", prezzi e candele arrivano dal broker (`source: "ctrader-demo"` / `"ctrader-live"`); altrimenti Yahoo Finance, con fallback a dati demo.
- **Un conto per piano**: ogni piano ha `trading: { mode: "paper" }` oppure `{ mode: "ctrader", accountId }`. Gli agenti operano sul conto del piano della loro stanza. Le posizioni aperte dagli agenti hanno l'etichetta `agenti:<id>`; un agente può chiudere solo le proprie.
- **Approvazioni**: ogni proposta ricorda il conto di destinazione; se nel frattempo il piano è passato a un altro conto, l'ordine non parte.
- **Sicurezza** (`data/safety.json`, modificabile solo dall'interfaccia): STOP, lotti massimi per ordine, posizioni aperte e ordini al giorno per conto, perdita massima del giorno (controllata ogni minuto, depositi e prelievi esclusi: attiva lo STOP e blocca quel conto fino al giorno UTC successivo), stop loss predefinito su ogni ordine. Gli ordini di uno stesso conto passano uno alla volta, e STOP, blocco del conto reale e conto del piano si ricontrollano appena prima dell'invio.
- Solo conti **HEDGED**: sui conti netting gli ordini degli agenti si mescolerebbero con le posizioni dell'utente.
- **Conto reale**: bloccato finché l'utente non scrive `SOLDI VERI` in Broker → Sicurezza. Orion e gli agenti non possono collegare piani a conti reali né cambiare le regole di sicurezza.
- Credenziali e token stanno in `data/ctrader.json` (permessi 600). I token si rinnovano da soli.

Test: `test/ctrader.test.js` e `test/broker.test.js` usano un finto server cTrader (`test/helpers/fake-ctrader.js`) che parla lo stesso protocollo.

## Aggiornamenti

**⚙️ Impostazioni → Aggiornamenti → Aggiorna ora** fa tutto in automatico:

1. scarica da GitHub l'ultima versione (`antonellomeco-debug/antonello`, oppure il repository indicato in `UPDATE_REPO`);
2. sostituisce i file del programma, dopo averne salvato una copia in `data/backup/`;
3. esegue `npm install` se sono cambiate le librerie;
4. si riavvia da solo.

La cartella `data/` non viene mai toccata. Il riavvio automatico funziona quando il programma è avviato con `npm start` (cioè `start.js`) o con l'icona sulla Scrivania. Se la cartella è un checkout git, l'aggiornamento dall'app è disattivato: usa `git pull`.

## Struttura

```
start.js            avvia il server e lo riavvia dopo un aggiornamento
server.js           API REST, eventi live (SSE), scheduler
lib/building.js     palazzo: piani, stanze, collegamenti, chi può leggere cosa
lib/office.js       stato condiviso e modifiche (usato da interfaccia e Orion)
lib/config.js       configurazione e validazione degli agenti
lib/market.js       prezzi (cTrader, oppure Yahoo Finance + fallback demo)
lib/indicators.js   indicatori tecnici
lib/broker.js       dove opera ogni piano, portafoglio virtuale, ordini su cTrader, approvazioni
lib/safety.js       STOP, limiti, perdita massima del giorno, blocco del conto reale
lib/ctrader/        cTrader Open API: protocollo, connessione, accesso OAuth, conti/prezzi/ordini
lib/runner.js       esecuzione agenti (Claude con strumenti, oppure strategia JS)
lib/schedule.js     orario di lavoro degli agenti, chiusura del venerdì, giorno e ora italiana
lib/calendar.js     calendario economico (Forex Factory) con cache in data/calendar.json
lib/tools.js        strumenti disponibili agli agenti (compresa la ricerca web di Claude)
lib/orchestrator.js il regista con cui parli in chat
lib/claude.js       client Claude condiviso, verifica della chiave, errori in italiano
lib/updater.js      aggiornamento dall'app
lib/store.js        stato persistente (data/state.json)
lib/settings.js     impostazioni salvate dall'app (data/settings.json)
lib/paths.js        percorsi del progetto
public/office3d.js  palazzo 3D (three.js)
public/             interfaccia
defaults/           palazzo e agenti di partenza
strategies/         strategie JavaScript
scripts/            icona di avvio per Mac
data/               i tuoi dati (creata al primo avvio, mai toccata dagli aggiornamenti)
```

Test: `npm test`.
