# 🏢 Ufficio Agenti — borsa (paper trading)

> 🍎 **Non sei pratico di programmazione? Segui la [guida passo passo per Mac](GUIDA-MAC.md).**

Un ufficio virtuale in 3D con **stanze** e **agenti** che analizzano i mercati. Ogni stanza è un'isola sospesa attorno a un nucleo centrale, il **regista** (Orion). Ogni agente siede alla sua scrivania, lavora da solo (su richiesta o a intervalli) e pubblica i risultati nella **bacheca** della stanza. Gli altri agenti leggono quelle bacheche, così il lavoro passa da una stanza all'altra.

Cosa trovi nell'interfaccia:

- **Ufficio**: scena 3D da girare trascinando. Clicchi una scrivania per aprire la scheda dell'agente, clicchi il nome di una stanza per avvicinarti. In alto ci sono i numeri dell'ufficio e il valore del portafoglio.
- **Parla con Orion**: chat con il regista. Puoi chiedergli cosa succede, far lavorare gli agenti, oppure **creare e modificare agenti descrivendoli a parole**.
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

## Le stanze

Sono definite in [`rooms.json`](rooms.json): ognuna diventa un'isola del colore indicato, disposte in cerchio attorno al nucleo. Puoi aggiungerne o toglierne.

| Stanza | Ruolo |
|---|---|
| Sala Ricerca | Macro, indici, regime di mercato |
| Analisi Tecnica | Segnali quantitativi (SMA, RSI, …) |
| Risk Room | Stop-loss, concentrazione, liquidità |
| Trading Desk | Decide ed esegue gli ordini (simulati) |
| Direzione | Report di sintesi per te |

## Programmare un agente

Ogni agente è un file JSON in [`agents/`](agents). Puoi modificarlo a mano oppure dall'interfaccia: clicca un agente sulla pianta, o usa **+ Nuovo agente**. Esistono due modalità.

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

## Struttura

```
server.js          API REST, eventi live (SSE), scheduler
lib/market.js      prezzi (Yahoo Finance + fallback demo)
lib/indicators.js  indicatori tecnici
lib/broker.js      portafoglio virtuale e limiti di rischio
lib/runner.js      esecuzione agenti (Claude con strumenti, oppure strategia JS)
lib/tools.js       strumenti disponibili agli agenti
lib/orchestrator.js il regista con cui parli in chat
lib/claude.js      client Claude condiviso e verifica della chiave
lib/settings.js    impostazioni salvate dall'app (data/settings.json)
scripts/           icona di avvio per Mac
lib/store.js       stato persistente in data/state.json
public/office3d.js scena 3D (three.js)
public/            interfaccia (ufficio, approvazioni, bacheca, portafoglio, chat, editor)
agents/            un file JSON per agente
strategies/        strategie JavaScript
```

Test: `npm test`.
