# 🏢 Ufficio Agenti — borsa (simulazione e broker cTrader)

> 🍎 **Non sei pratico di programmazione? Segui la [guida passo passo per Mac](GUIDA-MAC.md).**
> ☁️📱 **Programma sempre acceso e app sul telefono: [guida Railway + iPhone](GUIDA-CLOUD.md).**

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

Serve [Node.js](https://nodejs.org) 22.

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
- `APP_PASSWORD` (chiede una password per entrare; obbligatoria sul server, vedi sotto)

La spesa API mostrata nell'ufficio è una stima calcolata dai token usati.

I prezzi arrivano da Yahoo Finance (ticker come `AAPL`, `ENI.MI`, `^GSPC`). Se il servizio non risponde, l'app usa prezzi simulati e li segnala come `demo`.

## L'universo: palazzi, piani, stanze e collegamenti

L'app è un **universo** di palazzi: ogni palazzo è un settore diverso (per esempio *Palazzo Investimenti* per i mercati, *Palazzo Social*, *Palazzo Ricerche*) e ha i suoi piani, stanze e agenti. Orion è il regista di tutto l'universo. Nell'Ufficio la barra in alto sceglie cosa guardare: **🌌 Universo** (ogni palazzo è una torre, con i collegamenti tra palazzi; toccando una torre si entra) oppure un palazzo (i suoi piani in 3D, come prima). La scelta resta su ogni dispositivo.

Tutto si trova in `data/building.json` (nome storico): `name` è il nome dell'universo, `palaces` l'elenco dei palazzi (`id`, `name`, `description`, `color`) e ogni piano ha il suo `palace`. I file di prima, con un solo palazzo, diventano da soli un universo con un palazzo che contiene tutti i piani (il nome di partenza «Il mio palazzo» diventa «Palazzo Investimenti», un nome scelto dall'utente resta). Un palazzo si elimina solo da vuoto e mai l'ultimo; i livelli dei piani contano dentro il loro palazzo. I palazzi **comunicano con i collegamenti tra piani**, che possono unire piani di palazzi diversi, con le stesse regole qui sotto. API: `POST/PUT/DELETE /api/palaces`, i piani accettano `palace`. Orion ha `save_palace` e `delete_palace`; gli agenti sanno in quale palazzo lavorano.

Si modifica dall'app (sezione **🌌 Universo**) o chiedendo a Orion. Al primo avvio di una nuova installazione viene copiato da [`defaults/building.json`](defaults/building.json). Chi arriva dalla versione senza piani (con `rooms.json` e `agents/` nella cartella del programma, oppure con un vecchio `data/state.json`) trova invece tutte le stanze su un unico piano: così gli agenti continuano a leggere le stesse stanze di prima. La cartella `agents/` viene importata e poi rinominata in `agents-importati`.

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

### Spesa e risparmio

Sezione **💰 Spesa**: spesa del mese (Claude, ricerche web, immagini IA, post su X) per palazzo e per agente, stima a
fine mese, consigli per ogni agente. **Budget del mese** generale e per palazzo: raggiunto il tetto, gli agenti
programmati si fermano fino al mese dopo (Orion e i lavori a mano restano). **Ritmo** di ogni palazzo: normale, risparmio
(metà dei lavori), minimo (un quarto), pausa. Nella scheda dell'agente **Solo con novità** (`onlyOnNews`): quando tocca a
lui lavora solo se altri hanno scritto nelle stanze che legge. Orion vede la spesa con `get_costs` e può cambiare il
ritmo (`set_palace_pace`), non i budget. Dettagli in `lib/costs.js`.

### Velocità di Orion

Orion risponde **in diretta**: il testo arriva all'app mentre lo scrive (`client.beta.messages.stream`, eventi SSE
`chat-delta`). In ⚙️ Impostazioni → **⚡ Velocità di Orion**: Veloce (Claude Sonnet 5.5, ragiona poco; predefinita),
Equilibrato (Opus 5.5, ragiona poco), Accurato (Opus 5.5, ragiona di più). La conversazione resta in memoria (cache) per
un'ora e riparte con un riassunto oltre 120.000 token, così le risposte restano rapide anche dopo una pausa.

### Messaggi vocali a Orion

Nella chat il pulsante 🎤 registra un messaggio vocale (➤ lo manda, ✕ lo annulla, al massimo 2 minuti). L'app prende l'audio grezzo del microfono (`public/recorder.js` con l'AudioWorklet `public/pcm-worklet.js`, che funziona anche nell'app installata sull'iPhone, dove il riconoscimento vocale del browser non è affidabile) e manda un WAV a 16 kHz mono a `POST /api/chat/voice`. Il server lo trascrive **da sé** (`lib/voice.js`): Whisper large-v3-turbo int8 con [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (`sherpa-onnx-node`), senza servizi esterni né chiavi, in un processo a parte (`lib/voice-worker.js`) che occupa circa 1,7 GB solo mentre lavora e si chiude dopo 3 minuti senza messaggi. Le trascrizioni passano una per volta; i messaggi oltre 28 s si dividono nelle pause; le frasi che Whisper inventa sul silenzio («Sottotitoli… Amara.org») si tolgono. Il testo arriva a Orion come messaggio dell'utente con `voice: true` e un avviso di trascrizione automatica (può chiedere conferma su nomi e numeri).

- **Modello**: alla prima richiesta (`POST /api/voice/prepare`, con conferma nell'app) si scaricano 564 MB da GitHub (impronta SHA-256 controllata) e con `tar` si estraggono 3 file (~1 GB) in `<dati>/models/whisper-turbo/`. Stato in `GET /api/voice` e con l'evento `voice` (`missing`, `downloading`, `extracting`, `ready`, `error`, `unsupported`). La cartella `models/` non entra nelle copie dei dati. Sul server serve `bzip2` (nel `Dockerfile`); sul Mac `tar` lo gestisce da sé (librerie native: macOS 14+ su Apple Silicon, 15+ su Intel). Variabili: `VOICE_THREADS` (thread, al massimo 4), `VOICE_IDLE_MS`.
- **Risposte a voce** (`public/speech.js`): con 🔊 acceso (scelta di ogni dispositivo) le risposte ai messaggi vocali si leggono con le voci italiane del dispositivo (`speechSynthesis`, gratis), a frasi brevi e senza i simboli del formato. Sull'iPhone la voce si sblocca con il tocco su ➤.
- Test: `test/voice.test.js` con un finto motore (`test/helpers/fake-sherpa.cjs`, variabile `VOICE_ENGINE`) e un finto archivio del modello (`VOICE_MODEL_URL`, `VOICE_MODEL_SHA256`).

## Social: Instagram, Threads, LinkedIn e X

Sezione **📣 Social** dell'app. L'utente crea una volta l'app di sviluppatore di ogni social (guida passo passo dentro la
sezione), incolla Client ID e Secret e preme **Collega** (OAuth; ritorno su `<indirizzo>/social/callback`, che passa anche
senza accesso se porta lo `state` appena creato). Instagram e Threads funzionano solo dal server online: vogliono un
indirizzo https e scaricano foto e video da lì.

- **API usate** (`lib/social/networks.js`): Instagram API con accesso Instagram (account professionale, senza Pagina
  Facebook; `graph.instagram.com`, contenitore → stato → `media_publish`; foto solo JPEG, feed tra 4:5 e 1,91:1: le foto
  3:4 dell'iPhone si ritagliano in una copia nascosta), Threads (`graph.threads.net/v1.0`), LinkedIn «Share on LinkedIn»
  (`/rest/posts`, `/rest/images`, `/rest/videos`; intestazione `LinkedIn-Version` = due mesi fa, con ripiego sui mesi
  prima; testo «little text» con i simboli protetti; niente statistiche né commenti per i profili personali) e X API v2
  (OAuth 2 con PKCE, caricamento a pezzi `/2/media/upload/*`; a consumo: 0,015 $ a post, 0,20 $ con un link, 0,005 $ a
  post letto, sommati alla spesa con `addCost`). Codici d'accesso: X si rinnova ogni 2 ore (il codice di rinnovo cambia e
  si salva subito), Instagram e Threads prima dei 60 giorni (controllo ogni ora), LinkedIn va ricollegato dopo 60 giorni.
- **Pagina aziendale di LinkedIn** (📣 Social → LinkedIn → 🏢 Pagina aziendale, solo dall'interfaccia): con `pageId`
  (numero o indirizzo `linkedin.com/company/<numero>/admin/…`) ogni `social_publish` su LinkedIn crea due post, profilo e
  pagina (`page`, `pageName`; o solo pagina con `pageOnly`), ognuno con la sua approvazione e il suo massimo al giorno.
  Sulla pagina si pubblica con `author: urn:li:organization:<numero>` solo se l'accesso comprende `w_organization_social`
  (prodotto «Community Management API», da far approvare a LinkedIn; casella `pageApi` → si chiede il permesso al
  ricollegamento, permessi concessi salvati in `account.scopes`); altrimenti il post della pagina è «a mano»
  (🏢 Apri la pagina: testo copiato e pagina di amministrazione aperta; 📲 Salva i file).
- **Post** (`lib/social/index.js`, dati in `<dati>/social.json`, file con permessi 600): `social_publish` crea un post
  `pending` con un'approvazione `kind: "post"` in ✅ Approvazioni; con la pubblicazione **automatica** (si attiva solo
  dall'interfaccia, per ogni social) parte subito. `publish_at` (ora italiana) → `scheduled`, pubblicato dal giro di ogni
  30 secondi. Stati: pending, scheduled, publishing, published, failed, rejected, cancelled, uncertain (chiusura o rete
  persa a metà). Massimo di post al giorno per social (0 = fermo; le risposte hanno un tetto a parte di 30). Thread su X e
  Threads: `reply_to` = `post_id` di un proprio post, anche non ancora uscito (la risposta aspetta il post precedente).
- **Archivio** (`lib/social/media.js`, `<dati>/media/`, fuori dalle copie dei dati): caricamento grezzo `POST /api/media`
  (foto fino a 40 MB → JPEG con `sharp`, anteprima; video MP4/MOV fino a 500 MB così come sono; controllo dello spazio
  libero), indirizzi pubblici `/m/<codice casuale>.<estensione>` senza accesso (servono a Meta).
- **Grafiche** (`create_graphic`): SVG scritto dall'agente → JPEG con `sharp`/librsvg nei formati square, portrait, story,
  landscape; caratteri inclusi in `assets/fonts/` (Montserrat, Inter, Bebas Neue, Playfair Display, licenza OFL) con un
  `fonts.conf` creato all'avvio; niente script, DOCTYPE, risorse esterne; `media:ID` inserisce una foto dell'archivio.
  `media_view` manda la foto all'agente come immagine. **Immagini IA** (`generate_image`, `lib/social/imagegen.js`):
  Gemini con la chiave dell'utente (`geminiKey` in `settings.json`), modelli `gemini-3.1-flash-image-preview` poi
  `gemini-2.5-flash-image`, circa 0,07 $ a immagine.
- **Video montati** (`create_video`, `lib/social/video.js`): schermate con sfondo clip/foto dell'archivio, SVG oppure solo
  colore; `headline` animato (pop, slide, typewriter, fade; `*parola*` nel colore d'accento) e sottotitoli parola per parola
  della voce, entrambi in un file ASS disegnato da libass (caratteri copiati in una cartella di lavoro, ffmpeg con `cwd`);
  `voice` = frase della voce narrante (la schermata dura quanto la frase); movimenti punch/zoom/pan (zoompan), transizioni
  `xfade` (anche `mix`, 0,35 s), barra di avanzamento, "whoosh" e "pop" generati con lavfi, musica dell'archivio
  (MP3/M4A/AAC/WAV, `kind: "audio"`, mai da sola in un post) abbassata sotto la voce con `sidechaincompress`; formati
  story 1080×1920, portrait, square, landscape 1280×720; massimo 30 schermate e 90 s; un montaggio per volta.
- **Voce narrante** (`lib/social/tts.js` + `tts-worker.js`): Piper `it_IT-paola-medium` di sherpa-onnx (65 MB da GitHub alla
  prima richiesta, SHA-256 fissato, in `<dati>/models/tts-paola/`), una frase per volta per conoscerne la durata; tempi delle
  parole stimati in proporzione alle lettere. Prove: `TTS_ENGINE` (finto in `test/helpers/fake-sherpa.cjs`), `TTS_MODEL_URL`.
- **Voce di Google** (`lib/social/googletts.js`, scheda «🎙️ Voce dei video» in 📣 Social): chiave `googleTtsKey` (Cloud
  Text-to-Speech, header `x-goog-api-key`), elenco delle voci `it-IT` chiesto a Google (`googleVoices`, prima le Chirp 3 HD),
  scelta in `videoVoice` ("local" = Piper), ascolto di prova (`POST /api/social/voice/preview`, CSP `media-src blob:`).
  Caratteri contati in `ttsUsage` per mese: oltre 950.000 (gratis fino a 1 milione) o se Google non risponde si usa la voce
  del server. `speakingRate` rifiutato da una voce → si riprova senza. Audio in comune: `lib/social/wav.js`.
- **Repertorio** (`lib/social/stock.js`, strumenti `stock_search` con le anteprime da guardare e `stock_add`): Pixabay
  (`pixabayKey`, chiave nell'indirizzo, video senza filtro di orientamento: si mettono prima quelli adatti) e/o Pexels
  (`pexelsKey`), chiavi gratuite dell'utente nella scheda di 📣 Social; con due chiavi i risultati si alternano; ricerche
  ricordate 24 ore; file MP4 col lato lungo fino a 2048, nell'archivio con `origin: "stock"` e `source: "pixabay:<id>"` o
  `"pexels:<id>"` (non si riscarica). Dal container Pixabay e Pexels non sono raggiungibili: finto server. ffmpeg: `FFMPEG_PATH`, poi il pacchetto facoltativo `ffmpeg-static`
  (scarica il programma da GitHub all'installazione), poi quello del sistema. Copertina (`thumb`) visibile con `media_view`.
  Test: `test/video.test.js`.
- Test: `test/social.test.js` e `test/social-server.test.js` con il finto server `test/helpers/fake-social.js`
  (`SOCIAL_API_BASE`, che risponde come i quattro social e Gemini e scarica davvero i file come Meta).

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

## Sul server (Railway)

Lo stesso programma gira anche su un server, sempre acceso, e si usa dal telefono come app installata (PWA). I passi per l'utente sono nella [guida Railway + iPhone](GUIDA-CLOUD.md); il `Dockerfile` prepara l'immagine (Node 22, `HOST=0.0.0.0`, `UPDATER=off`, `TRUST_PROXY=1`, `CMD node start.js`).

- **Modalità server**: si attiva quando c'è un indirizzo pubblico: `PUBLIC_URL`, altrimenti `https://` + `RAILWAY_PUBLIC_DOMAIN` (Railway), altrimenti `RENDER_EXTERNAL_URL`. I dati stanno in `AGENTI_DATA_DIR`, altrimenti nel volume di Railway (`RAILWAY_VOLUME_MOUNT_PATH`), altrimenti in `data/`. Senza volume l'app mostra un avviso.
- **Password** (`lib/auth.js`): obbligatoria in modalità server o con `HOST` non locale; `APP_PASSWORD` di almeno 10 caratteri (scrypt). Senza, ogni pagina tranne `/healthz` mostra come impostarla. Sessioni di 60 giorni rinnovate a ogni uso, salvate (solo l'impronta) in `data/auth.json`; cambiando la password le vecchie sessioni decadono. Tentativi sbagliati rallentati (e limitati per indirizzo con `TRUST_PROXY`). Le operazioni delicate (sblocco del conto reale, azzeramento, importazione dei dati) chiedono di nuovo la password.
- **Protezioni** (`lib/guard.js`): controllo di `Host` e `Origin`, Content-Security-Policy, HSTS su https, niente cache per `/api`. Pubblici solo `/login`, `/login.js`, `/healthz`, `/api/session`, `/api/login`, `/api/logout`, manifest, icone, service worker e pagina offline.
- **cTrader**: l'indirizzo di ritorno diventa `<PUBLIC_URL>/ctrader/callback` (va aggiunto tra i Redirect URIs dell'app su openapi.ctrader.com). Il collegamento usa un parametro `state` monouso: il ritorno funziona anche senza sessione (app installata sull'iPhone, che ha cookie separati da Safari) solo se `state` coincide.
- **Dati** (`lib/backup.js`): ⚙️ Impostazioni → 💾 Dati esporta uno zip (`GET /api/backup`: agenti, palazzo, stato, impostazioni, sicurezza, cTrader) e lo reimporta (`POST /api/backup`, solo file noti, applicato al riavvio da `lib/boot.js`, con copia di sicurezza in `data/backup/`). Serve anche a portare i dati dal Mac al server.
- **Robustezza**: `GET /healthz`; allo spegnimento (SIGTERM) niente nuovi lavori, attesa fino a 8 s degli ordini già inviati e salvataggio (su Railway impostare `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`); file scritti in modo atomico; approvazioni rimaste "in esecuzione" segnate come incerte all'avvio. Aggiornamenti dall'app disattivati (`UPDATER=off`): arrivano con un nuovo deploy dal ramo principale. I test girano su GitHub Actions (`.github/workflows/test.yml`), così Railway può aspettarli (**Wait for CI**).
- **Telefono**: barra in basso a 5 schede, sezione «Altro», finestre a tutto schermo, palazzo 3D leggero e fermo quando non si vede, tocco per il nome degli agenti; `manifest.webmanifest`, icone in `public/icons/`, `sw.js` (solo pagina offline, niente copie di app e API).

## Aggiornamenti

**⚙️ Impostazioni → Aggiornamenti → Aggiorna ora** fa tutto in automatico:

1. scarica da GitHub l'ultima versione (`antonellomeco-debug/antonello`, oppure il repository indicato in `UPDATE_REPO`);
2. sostituisce i file del programma, dopo averne salvato una copia in `data/backup/`;
3. esegue `npm install` se sono cambiate le librerie;
4. si riavvia da solo.

La cartella `data/` non viene mai toccata. Il riavvio automatico funziona quando il programma è avviato con `npm start` (cioè `start.js`) o con l'icona sulla Scrivania. Se la cartella è un checkout git, l'aggiornamento dall'app è disattivato: usa `git pull`. Sul server l'aggiornamento dall'app è spento: le versioni nuove arrivano da GitHub.

## Struttura

```
start.js            avvia il server e lo riavvia dopo un aggiornamento
server.js           API REST, eventi live (SSE), scheduler
lib/building.js     universo: palazzi, piani, stanze, collegamenti, chi può leggere cosa
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
lib/voice.js        messaggi vocali: modello Whisper (scarico, estrazione) e trascrizione
lib/voice-worker.js processo a parte che trascrive (sherpa-onnx)
lib/social/         social: accesso e pubblicazione (networks.js), post e approvazioni (index.js),
                    archivio di foto e video e grafiche (media.js), immagini IA (imagegen.js)
assets/fonts/       caratteri per le grafiche degli agenti (licenza OFL)
lib/claude.js       client Claude condiviso, verifica della chiave, errori in italiano
lib/updater.js      aggiornamento dall'app (spento sul server)
lib/env.js          modalità Mac o server: indirizzo pubblico, cartella dei dati, password
lib/auth.js         accesso con password e sessioni
lib/guard.js        protezioni: Host, Origin, intestazioni di sicurezza, pagina «imposta la password»
lib/backup.js       esporta e importa i dati (zip); lib/boot.js li applica all'avvio
lib/files.js        scrittura atomica dei file
lib/models.js       modelli e prezzi indicativi di Claude
lib/store.js        stato persistente (data/state.json)
lib/settings.js     impostazioni salvate dall'app (data/settings.json)
lib/paths.js        percorsi del progetto
public/office3d.js  palazzo 3D (three.js)
public/recorder.js  registrazione dei messaggi vocali (con pcm-worklet.js); speech.js legge le risposte
public/social.js    sezione 📣 Social e schede dei post da approvare
public/             interfaccia
defaults/           palazzo e agenti di partenza
strategies/         strategie JavaScript
scripts/            icona di avvio per Mac
Dockerfile          immagine per il server (Railway)
data/               i tuoi dati (creata al primo avvio, mai toccata dagli aggiornamenti)
```

Test: `npm test`.
