# 🏢 Ufficio Agenti — borsa (paper trading)

Un ufficio virtuale con **stanze** e **agenti** che analizzano i mercati. Ogni agente siede alla scrivania della sua stanza, lavora da solo (su richiesta o a intervalli) e pubblica i risultati nella **bacheca** della stanza. Gli altri agenti leggono quelle bacheche, così il lavoro passa da una stanza all'altra.

> ⚠️ **Solo simulazione.** Gli ordini sono eseguiti su un portafoglio virtuale (`paper trading`): nessun ordine reale viene inviato a un broker. Non è una consulenza finanziaria.

## Avvio

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # serve solo per gli agenti in modalità "llm"
npm start                              # http://localhost:3000
```

Variabili facoltative: `PORT` (default 3000), `INITIAL_CASH` (default 100000), `MARKET_MODE=demo` (prezzi simulati, utile offline).

I prezzi arrivano da Yahoo Finance (ticker come `AAPL`, `ENI.MI`, `^GSPC`). Se il servizio non risponde, l'app usa prezzi simulati e li segnala come `demo`.

## Le stanze

Sono definite in [`rooms.json`](rooms.json). `x`, `y`, `w`, `h` indicano la posizione sulla pianta, che è una griglia di 4 colonne.

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

## Struttura

```
server.js          API REST, eventi live (SSE), scheduler
lib/market.js      prezzi (Yahoo Finance + fallback demo)
lib/indicators.js  indicatori tecnici
lib/broker.js      portafoglio virtuale e limiti di rischio
lib/runner.js      esecuzione agenti (Claude con strumenti, oppure strategia JS)
lib/tools.js       strumenti disponibili agli agenti
lib/store.js       stato persistente in data/state.json
public/            interfaccia (pianta dell'ufficio, bacheca, portafoglio, editor)
agents/            un file JSON per agente
strategies/        strategie JavaScript
```

Test: `npm test`.
