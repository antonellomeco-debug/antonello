# 🏢 Ufficio Agenti — borsa (paper trading)

> 🍎 **Non sei pratico di programmazione? Segui la [guida passo passo per Mac](GUIDA-MAC.md).**

Un **palazzo** virtuale in 3D di agenti che analizzano i mercati. Il palazzo ha più **piani**: ogni piano gestisce un settore (es. Azioni, Crypto) e contiene **stanze**, isole sospese attorno a una colonna centrale. In cima c'è il **regista** (Orion). Ogni agente siede alla sua scrivania, lavora da solo (su richiesta o a intervalli) e pubblica i risultati nella **bacheca** della stanza. Gli altri agenti leggono quelle bacheche, così il lavoro passa da una stanza all'altra. I piani **collegati** si scambiano informazioni.

Cosa trovi nell'interfaccia:

- **Ufficio**: il palazzo in 3D. Con l'ascensore scegli un piano o tutto il palazzo; trascini per girare. Clicchi una scrivania per aprire la scheda dell'agente, clicchi il nome di una stanza per avvicinarti. In alto ci sono i numeri dell'ufficio e il valore del portafoglio.
- **Palazzo**: crei e modifichi piani e stanze, e decidi quali piani comunicano tra loro.
- **Parla con Orion**: chat con il regista. Puoi chiedergli cosa succede, far lavorare gli agenti, oppure **creare e modificare agenti, piani, stanze e collegamenti descrivendoli a parole**.
- **Approvazioni**: gli agenti *propongono* gli ordini e tu scegli "Fallo per me" o "Scarta".
- **Bacheca**, **Portafoglio**, **Attività**.

> ⚠️ **Solo simulazione.** Gli ordini sono eseguiti su un portafoglio virtuale (`paper trading`): nessun ordine reale viene inviato a un broker. Non è una consulenza finanziaria.

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

La spesa API mostrata nell'ufficio è una stima calcolata dai token usati.

I prezzi arrivano da Yahoo Finance (ticker come `AAPL`, `ENI.MI`, `^GSPC`). Se il servizio non risponde, l'app usa prezzi simulati e li segnala come `demo`.

## Il palazzo: piani, stanze e collegamenti

Il palazzo si trova in `data/building.json`. Si modifica dall'app (sezione **🏗️ Palazzo**) o chiedendo a Orion. Al primo avvio viene copiato da [`defaults/building.json`](defaults/building.json):

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
| `get_quote` | Ultimo prezzo e variazione |
| `get_indicators` | SMA20/50, RSI14, volatilità, rendimenti 5/20/60 giorni |
| `read_notes` | Legge la bacheca della propria stanza e di quelle in `readsFrom` |
| `post_note` | Pubblica nella bacheca della propria stanza |
| `get_portfolio` | Liquidità, posizioni, P&L |
| `place_order` | Ordine simulato; richiede `canTrade: true` e rispetta i `limits` |

`effort` (`low` … `max`) regola quanto a fondo ragiona il modello: più è alto, più l'analisi è accurata e più costa.

### 2. Modalità `rule`: una strategia in JavaScript

```json
{ "id": "tecnico_sma", "room": "analisi", "mode": "rule",
  "strategy": "sma_cross", "params": { "fast": 20, "slow": 50 },
  "everyMinutes": 60, "watchlist": ["AAPL", "MSFT"] }
```

Le strategie si trovano in [`strategies/`](strategies). Quelle già incluse sono `sma_cross`, `rsi_reversion` e `risk_monitor`. Per scriverne una tua, copia [`strategies/_template.js`](strategies/_template.js): ricevi un `ctx` con dati di mercato, indicatori, bacheche, portafoglio e ordini simulati. Questa modalità non richiede una chiave API e non ha costi.

### Campi comuni

- `everyMinutes`: lo scheduler esegue l'agente ogni N minuti (`0` = solo a mano).
- `enabled`: se `false`, lo scheduler lo ignora.
- `limits.maxOrderPct` / `limits.maxPositionPct`: percentuale massima del portafoglio per un singolo ordine e per un singolo titolo.
- `limits.onlyWatchlist`: l'agente può operare solo sui titoli della sua watchlist.
- `limits.requireApproval` (default `true`): ogni ordine finisce in **Approvazioni** e parte solo con il tuo ok. Con `false` l'agente esegue da solo, sempre e solo sul portafoglio simulato.

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
lib/market.js       prezzi (Yahoo Finance + fallback demo)
lib/indicators.js   indicatori tecnici
lib/broker.js       portafoglio virtuale, limiti di rischio, approvazioni
lib/runner.js       esecuzione agenti (Claude con strumenti, oppure strategia JS)
lib/tools.js        strumenti disponibili agli agenti
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
