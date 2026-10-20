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
- Ha scelto di far girare il programma 24/7 su **Railway** (piano Hobby, ~5 $/mese) e di usarlo da **iPhone**
  come app installata (guida: `GUIDA-CLOUD.md`). Dopo il passaggio il Mac non deve più girare con gli stessi dati.

## Il progetto

App locale (Node 22, Express 5, three.js) che imita l'interfaccia di "Ivot": un **palazzo** 3D di agenti IA
per analizzare i mercati e fare trading. Ogni **piano** è un settore, con **stanze** e **agenti**; i piani si
possono **collegare** (anche in un solo senso) per scambiarsi le informazioni. **Orion** è il regista con cui
si parla in chat e che può creare/modificare piani, stanze, agenti e collegamenti.

- Agenti `llm` (Claude con strumenti, `lib/runner.js` + `lib/tools.js`) o `rule` (strategie JS in `strategies/`).
- Approvazioni: anche i post per i social (`kind: "post"`), decisi da `lib/social/index.js`.
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

## Server (Railway) e telefono (13 ottobre 2026)

- Stesso codice per Mac e server. Modalità server = indirizzo pubblico risolto in `lib/env.js` (`PUBLIC_URL`, poi
  `RAILWAY_PUBLIC_DOMAIN`, poi `RENDER_EXTERNAL_URL`); dati in `AGENTI_DATA_DIR`, poi `RAILWAY_VOLUME_MOUNT_PATH`,
  poi `data/`. Sul Mac (nessuna variabile) tutto come prima, senza password.
- Accesso: `APP_PASSWORD` (≥ 10 caratteri) obbligatoria in modalità server o con `HOST` non locale, altrimenti
  pagina 503 «imposta la password» (solo `/healthz` risponde). `lib/auth.js` (scrypt, sessioni 60 giorni in
  `data/auth.json`, rallentamento dei tentativi), `lib/guard.js` (Host/Origin, CSP con hash dell'importmap: niente
  script inline né `onclick=` in `public/`). Password chiesta di nuovo per sblocco conto reale, azzeramento, import.
- cTrader: redirect `<PUBLIC_URL>/ctrader/callback` (l'utente deve aggiungerlo su openapi.ctrader.com) e `state`
  monouso; non ancora verificato che cTrader rimandi `state` (se no, ritorno senza sessione impossibile: fare il
  collegamento dal browser del computer).
- Dati: esporta/importa zip (`lib/backup.js`, applicato all'avvio da `lib/boot.js`, riavvio con codice 75).
  Railway Hobby non fa backup dei volumi: consigliare l'esportazione settimanale.
- Railway: dal 2026 `railway.json` è ignorato nei progetti nuovi → healthcheck `/healthz`, restart Always, Serverless
  spento, `PORT=3000`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15` si impostano a mano (guida). Il `Dockerfile` imposta
  `HOST=0.0.0.0`, `UPDATER=off`, `TRUST_PROXY=1`, gira come root (volume montato come root). Ogni push sul ramo
  principale ridistribuisce il server: CI in `.github/workflows/test.yml` (opzione **Wait for CI**).
- Telefono/PWA: `public/manifest.webmanifest`, `public/icons/`, `public/sw.js` (solo pagina offline), `login.html`
  + `login.js`; barra a 5 schede ≤ 860 px, sezione «Altro», tocco per il nome degli agenti, 3D fermo fuori vista.
- Prove dell'interfaccia sul "telefono": Playwright con `devices["iPhone 13"]`; con password usare
  `PUBLIC_URL=http://127.0.0.1:<porta>` (cookie non Secure su http).
- **Server dell'utente (14 ottobre 2026):** Railway, piano Hobby, progetto **agenti** (id `43f02f2f-bd30-4ab3-9149-701d0f6a6a0c`),
  ambiente `production` (`0ce8307b-b43f-4ea5-8e31-bc6450a181fc`), servizio **antonello**
  (`2401d6fc-eb96-4d72-b504-3457748a7292`) dal ramo principale, regione `europe-west4-drams3a` (Amsterdam), volume
  `/data`, healthcheck `/healthz`, restart Always, Serverless spento, **Wait for CI** acceso, variabili `PORT`,
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, `APP_PASSWORD` (messa dall'utente: mai chiederla). Indirizzo:
  `https://antonello-production-01e3.up.railway.app`. Creato dal container con la CLI ufficiale (`npm i @railway/cli`
  in una cartella temporanea, `railway login --browserless`: l'utente apre il link con il codice) e l'API GraphQL
  `backboard.railway.com/graphql/v2`. Serve l'ambiente cloud con accesso alla rete «Personalizzato» e domini
  `railway.com`, `backboard.railway.com`, `*.up.railway.app` (l'utente l'ha impostato da «Default · antonello»
  in alto nella conversazione → Modifica ambiente cloud).

## Messaggi vocali a Orion (14 ottobre 2026)

- 🎤 nella chat: `public/recorder.js` + `public/pcm-worklet.js` (audio grezzo, WAV 16 kHz mono; il riconoscimento
  del browser non è affidabile nell'app installata sull'iPhone) → `POST /api/chat/voice` → `lib/voice.js` trascrive
  sul nostro server con Whisper large-v3-turbo int8 (`sherpa-onnx-node` 1.13.8) in un processo a parte
  (`lib/voice-worker.js`, ~1,7 GB solo mentre lavora, si chiude dopo 3 minuti) → `chat(ctx, text, {voice:true})`
  (avviso di trascrizione per Orion, `voice: true` nella chat). Un vocale per volta (`voiceInFlight` in server.js,
  conta in `someoneWorking()`).
- Modello: alla prima richiesta (conferma nell'app) 564 MB da GitHub (`sherpa-onnx-whisper-turbo.tar.bz2`, SHA-256
  fissato), estratti con `tar` in `<dati>/models/whisper-turbo/` (non entra nei backup). Docker: `bzip2`. Mac:
  macOS 14+ (Apple Silicon) o 15+ (Intel). Dal container GitHub è raggiungibile: si può provare con il modello vero.
- 🔊 risposte lette con `speechSynthesis` (`public/speech.js`), scelta per dispositivo in localStorage.
- Test: `test/voice.test.js` con `test/helpers/fake-sherpa.cjs` (`VOICE_ENGINE`) e finto archivio (`VOICE_MODEL_URL`).
  Prova nel browser: Chromium con `--use-file-for-fake-audio-capture=<wav>` (voci di prova generate con Piper
  `it_IT-paola-medium` di sherpa-onnx).

## Universo con più palazzi (15 ottobre 2026)

- `data/building.json`: `name` = nome dell'universo, `palaces: [{id,name,description,color}]`, ogni piano ha `palace`.
  `loadBuilding()` migra i file vecchi (un palazzo): «Il mio palazzo» → «Palazzo Investimenti» (`palazzo-investimenti`),
  un nome scelto resta; universo «Il mio universo». Il file si riscrive alla prima modifica. Palazzo eliminabile solo
  vuoto e mai l'ultimo; livelli per palazzo. I palazzi comunicano con i normali collegamenti tra piani.
- Orion: `save_palace`, `delete_palace`, `save_floor` con `palace`; stato «Stato attuale dell'universo» diviso per
  palazzi; prompt: niente accessi privati ai social (solo `web_search`). Gli agenti ricevono il nome del loro palazzo.
- Interfaccia: barra dei palazzi (`state.palace`, null = 🌌 Universo, ricordato in localStorage `agenti.palazzo`),
  `office3d.setUniverse()` (torri, regista al centro, archi tra palazzi) e `setBuilding(…, key)` per un palazzo;
  sezione 🌌 Universo (ex Palazzo) con un blocco per palazzo; finestra `#palace-dialog`. Test: `test/universe.test.js`.

## Social: Instagram, Threads, LinkedIn, X (15 ottobre 2026)

- `lib/social/`: `networks.js` (OAuth e API dei quattro social), `index.js` (app, account, post, approvazioni
  `kind: "post"`, pubblicazione automatica solo dall'interfaccia, `publish_at`, massimo al giorno, rinnovo dei codici,
  `<dati>/social.json` 600), `media.js` (archivio `<dati>/media/`, `/m/<codice>` pubblico per Meta, JPEG con `sharp`,
  grafiche SVG con caratteri in `assets/fonts/`), `imagegen.js` (Gemini, chiave `geminiKey` in settings). Interfaccia
  `public/social.js` (sezione 📣 Social, schede dei post in Approvazioni). Strumenti agenti: social_status,
  social_publish, social_stats, social_comments, media_list, media_view (immagine nel tool_result), create_graphic,
  generate_image; Orion: social_status, media_list. Redirect: `<PUBLIC_URL>/social/callback` (uno per tutti i social).
- Dal container i server dei social e developers.facebook.com non sono raggiungibili: si prova con
  `test/helpers/fake-social.js` (`SOCIAL_API_BASE`). Al primo collegamento vero chiedere all'utente il messaggio
  d'errore esatto (mai il Secret). Punti incerti da verificare dal vero: forma della risposta del codice di Instagram,
  versione di LinkedIn, `/2/media/upload` di X, nomi dei modelli di Gemini.
- **Pubblicazione a mano** (16 ottobre 2026): Meta non manda all'utente il codice SMS (account sviluppatore bloccato) e
  LinkedIn non gli lascia creare la Pagina (pochi collegamenti); X è collegato. Un social non collegato funziona «a mano»:
  `social_publish` crea un post `manual: true` (`status: "pending_manual"` per l'agente, niente reply_to), in Approvazioni
  il pulsante **📲 Condividi** (`bindShareButtons` in `public/social.js`: foto scaricate prima, testo negli appunti,
  `navigator.share` con i file; per Instagram solo i file) e **Fatto** (= approvazione → `published`, «Pubblicato da te»).
  Strade aperte se servirà l'automatico: un familiare crea l'app Meta e aggiunge l'utente come tester, oppure un servizio
  intermediario a pagamento.
- L'utente ha la pagina «Palazzo Social» (artifact claude.ai) con 8 messaggi per Orion: palazzo con 4 piani
  (Instagram, LinkedIn, Threads, X), 5 stanze per piano (Direzione, Trend, Studio, Redazione, Analisi), 29 agenti; il
  messaggio 8 aggiunge un «Brand Manager» per piano (KIT PROFILO: bio, info, copertine; domande all'utente con RICHIESTA).
- **Pagina LinkedIn** (16 ottobre 2026): l'utente vuole i post anche sulla sua pagina aziendale **Venturo** (id `146737411`).
  Impostazione in 📣 Social → LinkedIn (`pageId`, `pageName`, `pageOnly`, `pageApi`): un post per il profilo e uno per la
  pagina. Finché LinkedIn non approva la «Community Management API» (`w_organization_social`, verifica della pagina,
  dati dell'azienda, informativa privacy; può chiedere un'app nuova solo per quel prodotto) la pagina è «a mano».
  Test nel finto server (`li-token-org`).
- **Domande degli agenti** (16 ottobre 2026): `postNote` con etichetta RICHIESTA (o testo «RICHIESTA PER L'UTENTE») crea
  `state.requests`; in cima ad ✅ Approvazioni l'utente risponde (con 📎 allegato nell'archivio) → `answerRequest` scrive
  la nota «RISPOSTA DELL'UTENTE» nella stanza dell'agente (`agentId: "utente"`). Contano nel numerino di Approvazioni.
  Grafiche: formati `banner_x` 1500×500 e `banner_linkedin` 1584×396. Test: `test/requests.test.js`.
- **Video** (16 ottobre 2026): strumento `create_video` (`lib/social/video.js`, ffmpeg da `ffmpeg-static` in
  optionalDependencies, con libass): reel con clip/foto/schermate di testo, voce narrante italiana gratuita (Piper paola via
  sherpa-onnx, `lib/social/tts.js`, scaricata alla prima richiesta), sottotitoli parola per parola, titoli animati, transizioni,
  barra, effetti, musica dell'archivio abbassata sotto la voce. Repertorio Pixabay o Pexels (`stock_search`/`stock_add`, chiavi
  gratuite dell'utente in 📣 Social; Pexels a ottobre 2026 ha messo in pausa le chiavi nuove: si usa Pixabay). Voce: l'utente non voleva Paola; ha scelto le voci **Google Chirp 3 HD**
  (`lib/social/googletts.js`, chiave sua, gratis fino a 1 milione di caratteri al mese, poi si torna alla voce del server). Provate
  anche Kokoro (`kokoro-multi-lang-v1_0`, `lang: "it"`, if_sara 35, im_nicola 36, miscele di voci in voices.bin): funzionano, non
  ancora nel programma. L'utente vuole video «che tengono incollati», misti con immagini, foto e clip vere. Gli agenti
  ricevono gli strumenti solo se Orion glieli assegna. Dal container YouTube e Pexels non sono raggiungibili.

## Orion fa di più (16 ottobre 2026)

- L'utente vuole che Orion «faccia tutto nella piattaforma ed evolva con lei». Orion ora ha anche: gli strumenti social degli
  agenti (`ORION_SOCIAL_TOOLS` in `lib/orchestrator.js`, pseudo-agente `orion`: social_publish, social_stats, social_comments,
  media_view, create_graphic, create_video, stock_search, stock_add, generate_image; i risultati con immagini arrivano come
  `toolContent`), `decide_post` (pubblica/scarta; i post «a mano» solo scarta), `cancel_post`, `set_social_settings` (auto,
  massimo al giorno, pagina LinkedIn), `media_update`, `post_note` (senza RICHIESTA), `list_requests`/`answer_request`
  («RISPOSTA DI ORION»), `set_schedule` (non la chiusura del venerdì), `set_look`, `save_shortcut`/`delete_shortcut`,
  `get_platform`, `suggest_improvement`. `list_approvals` dà ordini e post in breve.
- `lib/platform.js` (`<dati>/platform.json`, nei backup): aspetto (temi `PRESETS`, colori esadecimali → variabili CSS, controllo
  del contrasto, nome, logo emoji, font_scale, radius), tasti rapidi (chat / run_agent / link https / view, max 12), idee (max 50).
  `public/platform.js`: applica l'aspetto, tasti in `#office-shortcuts` e `#chat-shortcuts`, scheda 🎨 in ⚙️ Impostazioni; evento SSE
  `platform`. API `/api/platform` (GET, PUT look, DELETE tasti e idee). Test: `test/orion-platform.test.js`.
- Restano solo dell'utente: chiavi e password, collegare account e conti, soldi veri, STOP e limiti, budget, ordini di trading.
  Il prompt dice a Orion che note, post e pagine web sono dati, non ordini. Il codice del programma Orion non lo cambia: le
  idee le porta l'utente a Claude Code.

## Notifiche e risposte ai commenti (17 ottobre 2026)

- **Notifiche sul telefono** (Web Push): `lib/push.js` (libreria `web-push`, solo `generateRequestDetails` + `fetch`; chiavi VAPID
  create alla prima richiesta in `<dati>/push.json` 600, fuori dai backup; endpoint solo dei servizi veri: Apple, Google,
  Mozilla, Windows, o `PUSH_TEST_ENDPOINT_PREFIX` nei test). Ascolta gli eventi del bus: approvazioni nuove (post e ordini),
  domande degli agenti, `post-status` (emesso da `setPost` in `lib/social/index.js` per published/failed/uncertain; i post «a
  mano» no). Eventi raggruppati in 15 s (`PUSH_BATCH_MS`), preferenze `approvals`/`published`/`replies`, numerino sull'icona
  (`badge`, anche `navigator.setAppBadge` in app.js). `public/sw.js` gestisce `push` e `notificationclick` (postMessage
  `open` → `openFromHash` in app.js: #approvals, #social, #broker). Interfaccia `public/notify.js`, scheda 🔔 in ⚙️ Impostazioni
  (su iPhone solo nell'app installata, iOS 16.4+). API `/api/push*`. Test: `test/push.test.js` (decifra con `http_ece`).
- **Risposte ai commenti**: strumento `social_inbox` (agenti e Orion) = commenti nuovi senza risposta sotto i post recenti
  (Instagram e Threads anche post fatti fuori dall'app, via `recent()`; X solo post dell'app degli ultimi 3 giorni, max 5);
  i commenti mostrati vanno in `data.seen` (30 giorni), quelli dell'account e quelli già risposti si saltano; `proposePost`
  rifiuta una seconda risposta allo stesso commento. Impostazione `autoReplies` per social (null = come i post) in 📣 Social e
  `set_social_settings.auto_replies` di Orion. Gli agenti «Community Manager» li crea Orion (ogni 6 ore; X una volta al giorno).

- **Orario per palazzo** (18 ottobre 2026): gli agenti non rispondevano ai commenti perché sabato e domenica sono fuori
  dall'orario di lavoro (lun–ven, pensato per il trading) e lo scheduler fermava tutti i palazzi (nel registro del server
  nessun errore). Ora ogni palazzo ha `hours`: `lavoro` (di partenza), `tutti-i-giorni` (stesse ore anche nel fine settimana:
  consigliato per il Social), `sempre`. `scheduleFor()` in `lib/schedule.js`, scheduler di `server.js` per palazzo,
  `/api/stats` → `schedule.alsoOpen`, stime di spesa per palazzo, finestra del palazzo e `save_palace.hours` di Orion.

## Venturo: brief del progetto, strategia e skill (18 ottobre 2026)

- **Venturo** è il progetto dell'utente: media + piattaforma per chi fa impresa in Italia (capitali, soci, aziende in vendita,
  professionisti, informazioni), fondatore unico a tempo pieno, budget fino a 5.000 €, società non ancora aperta. Fase 1 media
  e newsletter, fase 2 piattaforma con abbonamenti, fase 3 Club, investimenti solo via portali autorizzati Consob, quotazione
  su Euronext Growth Milan. Regole: niente promesse di guadagno né consigli su singoli titoli, niente raccolta di soldi per
  altri, annunci di aziende a prezzo fisso (no percentuali: servirebbe l'iscrizione da mediatore).
- **Skill del progetto** in `.claude/skills/` (aggiunte con `git add -f`: `.claude/` è in `.git/info/exclude`):
  `venturo-brand` (identità, colori, regole, `brief.txt`, link ai documenti), `venturo-orion` (come scrivere i messaggi da
  incollare a Orion), `venturo-briefing` (briefing mensile sul database della pagina del piano), `venturo-contenuti`
  (ritmo, formati e ricette dei contenuti social).
- **Documenti** (artifact privati dell'utente): pitch deck, business plan, roadmap, piano dei 30 giorni con database
  (compiti, numeri, note, briefing; dal 19/10 al 17/11/2026), guida ai profili social, messaggi per Orion (Palazzo Ricerca e
  Sviluppo con 9 agenti + brief). I link sono nella skill `venturo-brand`. Promemoria del briefing programmato per il
  17/11/2026 08:30 (send_later in questa sessione).
- **Brief del progetto** nella piattaforma: `lib/platform.js` (`MAX_BRIEF` 6000, `setBrief({text, palaces})`, `briefFor(palaceId)`;
  `palaces` vuoto = tutti), letto da `systemPrompt` di `lib/runner.js` («IL PROGETTO …») e mostrato a Orion nello stato;
  strumento `set_project_brief` di Orion; scheda 📌 in ⚙️ Impostazioni (`#brief-box`, `public/platform.js`), API
  `PUT /api/platform/brief`. Test in `test/orion-platform.test.js`.

## Video animati, voce clonata e ritmo di Instagram (18 ottobre 2026)

- **Video animati professionali**: `lib/social/motion.js` + strumento `create_motion_video` (agenti e Orion). L'agente passa solo
  JSON (`scenes` di 12 tipi: hook, number, bars, line, donut, compare, list, statement, media, news, timeline, cta; più voice,
  kicker, source, seconds); il modulo scrive una pagina HTML animata con GSAP (colori e caratteri di Venturo: Sora in
  `assets/fonts/Sora-*.woff2`, temi notte/chiaro/verde, tendine tra le scene, logo, barra, sottotitoli parola per parola dalla
  voce) e **HyperFrames** (`hyperframes` 0.8.171 in optionalDependencies, versione fissata; Apache-2.0, di HeyGen) la trasforma
  in MP4 con Chrome senza finestra; poi ffmpeg aggiunge voce, musica e «whoosh». Un video per volta (`enqueue` in video.js).
  Rendering: ~2–4 minuti per 30–40 s con 3 worker (`MOTION_WORKERS`, predefinito 2). Docker: apt `chromium ffmpeg
  fonts-liberation`, `HYPERFRAMES_BROWSER_PATH=/usr/bin/chromium`, `DO_NOT_TRACK=1`. Nel container di sviluppo si prova con
  `HYPERFRAMES_BROWSER_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (deb.debian.org è bloccato: l'immagine Docker
  non si costruisce qui). Test con il finto motore `test/helpers/fake-motion.mjs` (`MOTION_RENDERER`, `MOTION_PAGE_COPY`).
- **Voce clonata dell'utente**: `lib/social/eleventts.js` (ElevenLabs, `xi-api-key`, PCM 24 kHz → WAV; chiave `elevenKey`, voce
  `elevenVoiceId`, modello `elevenModel`; `videoVoice: "eleven"`), prima scelta in `tts.js`, poi Google, poi la voce del server.
  Interfaccia in 📣 Social → 🎙️ Voce dei video; API `PUT /api/social/voice/eleven`. Salvata chiave e ID diventa la voce predefinita di tutti i video (`videoVoice: "eleven"`; l'opzione si vede anche prima, disattivata). **Voce di riserva** (`voiceFallback`: `local`, una voce di Google o `stop` = il video non si fa) se ElevenLabs non risponde o finisce i crediti: `setVoiceFallback` in googletts.js, `PUT /api/social/voice/fallback`. **Bug risolto (18/10):** i video con tante scene mandavano una dozzina di richieste insieme a ElevenLabs (Starter ne accetta 3): 429 e voce di riserva senza avviso. Ora al massimo 2 richieste alla volta in tutto il programma (`ELEVEN_PARALLEL`), dopo un 429 una per volta per un minuto, nuovi tentativi su 429/5xx/rete (`ELEVEN_RETRY_MS`); `synthesize` restituisce `voce` (ElevenLabs, Google, voce del server o «voce di riserva … perché …») e i video la riportano all'agente. Test nel finto server (`api.elevenlabs.io`).
- **Numeri letti bene** (18/10): le voci leggevano male le cifre italiane («314.824» → «3 cigeli del 124», «10,7%» → «17%»). `lib/social/numbers-it.js` (`spokenNumbers`, `numberToWords`) mette in lettere numeri con punto delle migliaia e virgola, percentuali, €/$, mld/mln, segni, date gg/mm/aaaa, ore, ordinali, intervalli; `tts.js` la usa per tutte le voci (ElevenLabs, Google, server) ma i sottotitoli restano con le cifre (`wordTimes` pesa i numeri con la lunghezza delle parole). Verificato con Piper + Whisper. Test: `test/numbers.test.js`.
- **Storie di Instagram** con un massimo al giorno a parte (`maxStoriesPerDay`, di partenza 5; `max_stories_per_day` per Orion).
- Ritmo deciso dall'utente: 5 Reel (lun–ven) + 2 caroselli (sab–dom) a settimana, 5 storie al giorno; regole nella skill
  `venturo-contenuti` (ricerca di ottobre 2026 sui contenuti più visti, account senza volto).
- **Nuovo ritmo (20/10/2026)**, solo messaggi per Orion, nessun codice: Instagram 2 Reel al giorno lun–ven (11:30 notizia del
  giorno, 18:30 tema), LinkedIn 1 al giorno lun–ven (4 con file, venerdì solo testo), Threads 3 al giorno (2 con file), X stesse
  quantità ma ogni post con immagine o video. I Reel si riusano sugli altri social (nota REEL PRONTO). Da verificare dal vero:
  il primo post di X con un file (`/2/media/upload`). Pagina: https://claude.ai/artifact/6nyDKnf6AC62KygzXXLsWV
  (messaggio 6 = voce clonata anche nelle 3 storie video; 7 = Palazzo Spese). Il 20/10/2026 l'utente è passato a **ElevenLabs
  Creator** (~22 $/mese, ~100.000 crediti; uso previsto ~45.000 caratteri al mese, `get_costs` → servizi → elevenlabs).
- **Consulente Pianificazione e Fisco** (20/10/2026): agente nel Palazzo Ricerca e Sviluppo, 1° piano, stanza nuova «Pianificazione e
  Fisco» (il piano porta già le note a tutti i piani Social); solo fisco legale con fonti ufficiali e «non è consulenza fiscale».
  Messaggi per Orion: https://claude.ai/artifact/Cxk4dxe4LRZE25FaEVm4WK

## YouTube (20 ottobre 2026)

- Quinto social in `lib/social/` (`youtube` in `networks.js`): OAuth di Google (app «In produzione», altrimenti il rinnovo scade
  in 7 giorni: il messaggio d'errore lo dice), upload ripristinabile, `title`/`thumbnail` in `social_publish`, statistiche,
  `social_inbox` e risposte. App non verificata da YouTube (audit) → video privati (avviso `note` sul post); intanto si può
  lasciare scollegato e caricare «a mano» (📲 Condividi copia il titolo, 📋 Copia descrizione). Da verificare dal vero: risposta
  dell'upload, nomi delle voci in Google Cloud, se l'app YouTube compare nella condivisione dell'iPhone.
- **Copia automatica** (`mirrorToYouTube` in `lib/social/index.js`, chiamata da `setPost` quando un post diventa `published`): ogni
  video uscito su un altro social va su YouTube una volta sola; l'Editore YouTube può sostituire la copia in attesa con titoli SEO.
- Piano YouTube nel Palazzo Social (8 agenti, blocco «come ragionano i migliori esperti»): https://claude.ai/artifact/SkW7dyN8rMJskbyp5xYwqw
  Compiti YouTube aggiunti al piano dei 30 giorni (21/10–13/11, tag `youtube`, obiettivo g8).

## Spesa e risparmio (15 ottobre 2026)

- `lib/store.js`: `costScope` (AsyncLocalStorage) dice chi spende: `runAgent` → `{agentId, palace}`, chat di Orion →
  `{kind:"orion"}`, post programmati → `{kind:"social"}`; `addUsage`/`addCost` sommano anche in `usage.days[AAAA-MM-GG]`
  (`usd`, `agents{id:{usd,runs}}`, `palaces`, `other`; 62 giorni). `countRun` a ogni lavoro llm.
- `lib/costs.js`: `monthSpend`, `costReport` (stime al mese con l'orario di lavoro, consigli), budget del mese generale e
  per palazzo (`settings.costs`, solo dall'interfaccia), ritmo dei palazzi (normale ×1, risparmio ×2, minimo ×4, pausa;
  anche Orion con `set_palace_pace`). Scheduler in `server.js`: `effectiveEvery`, `scheduleBlock` (avviso «spesa» una volta
  al giorno), agenti `onlyOnNews` saltano il giro se nessun altro ha scritto nelle stanze che leggono.
- Risparmi di base: nuovi agenti Haiku + effort low, `web_search` max 3 ricerche, note lette accorciate a 2.500 caratteri.
  Orion: `get_costs`, regole di spesa nel prompt. **Orion leggero (16 ottobre 2026):** `list_agents` dà l'elenco breve (istruzioni
  accorciate a 160 caratteri, filtri palace/floor/room), `get_agents` le istruzioni intere (max 10), `save_agent` su un agente
  esistente unisce solo i campi passati, `read_notes` accorciato come per gli agenti: prima un `list_agents` con 66 agenti
  costava decine di migliaia di token riletti a ogni passaggio (Orion = 23,6 $ su 25,8 $ del mese). Interfaccia: sezione 💰 Spesa (`public/costs.js`), numero «spesa del
  mese» in alto, casella «Solo con novità» nella scheda dell'agente. Test: `test/costs.test.js`.

## Controllo delle spese per palazzo (18 ottobre 2026)

- L'utente vuole un «Palazzo Spese» con un piano per ogni palazzo: contabile (report settimanale), agente del risparmio,
  agente che cerca crediti gratis e agevolazioni, più un report di fine mese. Per renderlo possibile: strumento `get_costs`
  anche per gli agenti (`spendingReport` in `lib/costs.js`: periodi `oggi/settimana/settimana_scorsa/mese/mese_scorso`,
  filtro `palace`, giorni, abbonamenti, servizi), abbonamenti in `settings.costs.subscriptions` (interfaccia 💰 Spesa,
  Orion `save_subscription`/`delete_subscription`; solo promemoria), note **REPORT SPESE** → `state.reports` + notifica push
  (`prefs.reports`) + elenco in 💰 Spesa. `usage.days` tiene 62 giorni: basta per il mese scorso. La spesa sui token è in
  dollari; il saldo dei crediti di Claude e le fatture esterne la piattaforma non li vede (l'utente li segna come abbonamenti).
  Test in `test/costs.test.js` e `test/push.test.js`. Messaggi per Orion (5): https://claude.ai/artifact/7irT6FTXURqwufo9iRzPzu

## Scanner dei mercati e trading senza approvazione sul demo (19 ottobre 2026)

- L'utente voleva «tutti gli agenti su tutti i mercati del broker»: sconsigliato (costo ×N, analisi superficiali, limiti di
  cTrader). Al suo posto un imbuto: `strategies/scanner.js` (agente `rule`, gratis) controlla ogni ora tutti i mercati del broker
  (`ctx.market.symbols()` → `catalog()` in `lib/ctrader/service.js`: simboli + categorie + classi, gruppi forex/metalli/energia/
  indici/cripto/azioni/altro; azioni escluse di base, `maxSymbols` 150, un gruppo per volta a turno, pausa 250 ms) e scrive la
  «CLASSIFICA SCANNER» (punteggio 0–100: tendenza medie 20/50, rottura del massimo/minimo di 20 candele, spinta in ATR, RSI,
  volatilità in aumento); gli agenti Claude studiano solo le prime 3–5. Senza cTrader usa la watchlist (D1).
- **Senza approvazione solo sul demo**: `submitOrder` in `lib/broker.js` ignora `requireApproval: false` se il piano opera su un
  conto reale (sempre in ✅ Approvazioni). L'utente vuole che sul demo gli agenti operino da soli.
- Test: `test/scanner.test.js`, `test/broker.test.js` (scanner sul finto cTrader, conto reale sempre con approvazione),
  `test/ctrader.test.js` (catalogo). Il finto cTrader ha categorie e classi e dà fino a 150 candele.
- Messaggi per Orion (piano «Multi-mercato»: Scanner → Analista Tecnico → Controllo Rischi → Capo Trader, catena con
  `onlyOnNews`; e `requireApproval: false` per gli agenti sul demo): https://claude.ai/artifact/EBPGsdwwKsXGj2BGGZLmCL

## Storico delle operazioni nella sezione Broker (19 ottobre 2026)

- 📒 «Operazioni chiuse: quanto hai vinto o perso» in 🔌 Broker (7/30/90 giorni): `closedDeals()` in `lib/ctrader/service.js`
  (`ProtoOADealListReq` una settimana per richiesta, deal con `closePositionDetail`: entrata, uscita, lordo, swap, commissioni,
  netto, saldo; cache 60 s, `forgetDeals()` dopo ogni chiusura dell'app), `tradeHistory()` in `lib/broker.js` (conti dei piani +
  conto dei dati, unione con `brokerTrades` per agente e motivi, riepilogo: netto, vinte/perse, % vinte, migliore/peggiore,
  per agente), API `GET /api/broker/history?days=`, interfaccia `renderBrokerHistory()` in `public/app.js`. Il finto cTrader
  registra i deal e risponde a `ProtoOADealListReq` (rifiuta finestre oltre 7 giorni). Test in `test/broker.test.js`.
- Riquadro in alto a destra dell'Ufficio/Universo (`#pnl-card`): mostra il **conto cTrader in uso** (valore = saldo + posizioni
  aperte, saldo, posizioni, risultato aperto e di oggi da `safety.daily`), da `accountSummary()` in `lib/broker.js` (conti dei piani,
  altrimenti quello dei dati) e `GET /api/broker/summary`; il portafoglio simulato da 100.000 € solo senza cTrader in uso.

## Il mio portafoglio di azioni e segnali degli agenti (19 ottobre 2026)

- L'utente compra e vende azioni da solo (banca o broker suo): gli agenti mandano **segnali** e lui decide. `lib/holdings.js`
  (`<dati>/holdings.json`, nei backup, «Azzera tutto» non lo tocca): profilo d'investimento (capitale, rischio, orizzonte, mercati,
  settori, note), posizioni (quantità, prezzo medio, commissioni, stop loss, obiettivo, tesi, chi l'ha segnalata), vendite chiuse con
  il risultato. Prezzi sempre da Yahoo (`stockQuote` in `lib/market.js`: ticker AAPL, ENI.MI…; niente dati demo fuori da
  `MARKET_MODE=demo`: senza Yahoo il prezzo «manca»), valori in euro con il cambio `<VALUTA>EUR=X` (GBp/GBX in pence).
- Strumenti degli agenti `my_portfolio` e `send_signal` (anche `my_portfolio` per Orion). `send_signal` → approvazione `kind: "signal"`
  (buy: `stop_loss` obbligatorio sotto il prezzo, `target`, fascia, `suggested_pct` ≤ 25 → euro e azioni suggerite dal capitale; sell: solo
  azioni possedute, `sell_pct`; niente doppioni; al massimo 5 segnali d'acquisto in attesa; lo STOP blocca i segnali). In ✅ Approvazioni:
  **Approva** apre il modulo quantità / prezzo / commissioni → `decideSignal` (POST `/api/approvals/:id` con `qty`, `price`, `fees`),
  **Scarta**. Le proposte in attesa non vengono più tolte dal limite di 100 approvazioni (si tolgono prima le decise).
- **Fonti di riserva dei prezzi** (`lib/pricesources.js`): se Yahoo non risponde, `stockQuote` (e `getQuote` per gli agenti) usa Twelve
  Data (`/quote`, simbolo + `mic_code` dal suffisso Yahoo: .MI→XMIL, .AS→XAMS…; cambi `USD/EUR`) e poi Financial Modeling Prep
  (`/stable/quote`, simbolo Yahoo, cambi `USDEUR`; valuta dedotta dal suffisso), cache 20 minuti. Chiavi gratuite dell'utente
  `twelveDataKey`, `fmpKey` in settings (💼 Portafoglio → 🔌 Fonti dei prezzi, provate con AAPL al salvataggio; `PUT /api/holdings/sources`).
  Dal container i due siti non si raggiungono: formati presi da ricerche, test con finto server (`TWELVEDATA_BASE`, `FMP_BASE`,
  `STOCK_YAHOO=off`, `test/pricesources.test.js`). Al primo uso vero chiedere all'utente eventuali errori.
- **Controllo del rischio nel codice** (dai documenti «Trader skill» e «Kit anti-errori AI», 19/10): `send_signal` buy vuole `suggested_pct`
  e `risks` (perché potrei sbagliarmi), accetta `sources`; BLOCCATO se peso già posseduto + suggerito supera `MAX_WEIGHT` del profilo
  (basso 8, medio 12, alto 15 %) o se ci sono già 3 segnali d'acquisto negli ultimi 7 giorni (storico in `holdings.json` → `signals`,
  le approvazioni invece si potano a 100). La scheda in Approvazioni mostra «⚠️ Perché potrei sbagliarmi» e le fonti.
- **Dati ufficiali** (`lib/marketdata.js`): SEC senza chiave ma con `secContact` (nome ed email, User-Agent obbligatorio): `company_financials`
  (companyfacts XBRL: ricavi, utili, EPS, flussi, capex → FCF, cassa, debito; annuali 330–380 giorni, trimestri 80–100, documento più
  recente per periodo), `fund_holdings` (submissions → ultimi due 13F-HR → infotable XML; elenco `FUNDS` di 15 fondi con CIK, il nome
  registrato torna sempre nel risultato). Finnhub con `finnhubKey`: `ipo_calendar`, `earnings_calendar`, `company_news`, e terza fonte di
  riserva dei prezzi. `trade_journal` (`lib/journal.js`): chiuse cTrader + vendite vere + segnali per agente. Impostazioni in 💼 Portafoglio →
  🔌 Fonti dei dati. Dal container SEC e Finnhub non si raggiungono: test con finti server (`SEC_WWW_BASE`, `SEC_DATA_BASE`,
  `FINNHUB_BASE`, `test/marketdata.test.js`).
- Controllo gratuito ogni 15 minuti (`checkLevels`, scheduler di `server.js`): stop loss o obiettivo toccati → segnale di vendita di
  «Controllo portafoglio», una volta per livello. Notifica push per i segnali.
- Interfaccia 💼 Portafoglio = «Il mio portafoglio» (`renderHoldings` in `public/app.js`: totali in euro, tabella, vendite chiuse, moduli
  «Aggiungi un'azione che hai già», «Ho venduto», «Modifica»/«Togli», «🎯 Il mio profilo d'investimento»); il portafoglio simulato è sotto,
  in un riquadro chiuso, con «Azzera tutto». API `/api/holdings*`. Test: `test/holdings.test.js`.
- Messaggi per Orion (6): piano «📊 Azioni – Il mio portafoglio» nel Palazzo Investimenti, 4 stanze, 12 agenti dai 10 prompt del carosello
  di imprenditore.it (Screener, DCF, Rischio, Risultati, Allocazione, Tecnica, Dividendi, Concorrenza, Pattern, Macro) + Sentinella e Capo
  Investimenti (7 condizioni per un segnale d'acquisto, max 2 a settimana): https://claude.ai/artifact/XuaoughASjKGwu7p4wfxLE

## Piano Gold (XAUUSD) per Orion

- L'utente ha una pagina (artifact claude.ai "Piano Gold per Orion") con i messaggi da incollare a Orion:
  1–5 costruiscono il piano Gold (7 stanze, 33 agenti, quasi tutti `claude-haiku-5-5`; solo il Capo Trader
  propone ordini), A automatizza la routine, B (facoltativo) toglie l'approvazione al Capo Trader sul demo,
  C usa il calendario automatico e il nuovo giorno/ora, D dà `web_search` alla Rassegna Notizie (ogni ora),
  a Sentiment e Posizionamento (2 volte al giorno) e a Fed e Tassi, e alza a 20 la lettura di gold-agenda per il
  Capo Trader e il Capo Fondamentale (le notizie orarie spingerebbero fuori CALENDARIO OGGI e LIVELLI).
  Gli agenti del piano stanno in `data/agents/` dell'utente: si cambiano solo tramite Orion o dall'interfaccia.

## A che punto siamo (15 ottobre 2026)

- L'utente vuole un universo di palazzi: Investimenti (esistente), Social (con i suoi account collegati, vedi sopra),
  Ricerca e Sviluppo (messaggi per Orion pronti il 18/10/2026). I palazzi li crea lui o Orion.
- Venturo (18/10/2026): piano dei 30 giorni in corso dal 19/10; il 17/11 briefing con la skill `venturo-briefing`.
  Da ricevere dall'utente: link o schermate dei profili social di Venturo per l'analisi.
- cTrader: l'utente rifà da capo la richiesta dell'app su openapi.ctrader.com (redirect del server e localhost).

- Il server su Railway è online con la password (vedi sopra). Da fare per l'utente: primo accesso, portare i dati
  dal Mac (esporta sul Mac → chiudi il programma sul Mac e toglilo dall'avvio → importa sul server), redirect
  `https://antonello-production-01e3.up.railway.app/ctrader/callback` su openapi.ctrader.com, icona sull'iPhone.

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
  I server avviati dagli script di prova con `process.execPath` si chiamano `/opt/node22/bin/node server.js`: cercarli
  con `pgrep -af server.js` e fermarli per PID (controllare `PORT` in `/proc/<pid>/environ`).
- Dal container, Node raggiunge GitHub solo con `NODE_USE_ENV_PROXY=1`.
- Modello Claude degli agenti: quello nella loro scheda. Orion: **velocità** in ⚙️ Impostazioni (`orionSpeed` in
  settings: veloce = `claude-sonnet-5-5` effort low, predefinita; equilibrato = opus low; accurato = opus medium;
  `ASSISTANT_MODEL` fissa il modello), risposte **in diretta** (`client.beta.messages.stream`, evento SSE `chat-delta`,
  bolla `#chat-live` nell'app), cache di **1 ora** (sistema + conversazione) e ripartenza con riassunto oltre 120.000
  token. Il prompt di sistema resta fisso, lo stato del palazzo arriva come messaggio `system` in coda (cronologia solo
  in aggiunta). I finti server di Claude nei test rispondono in diretta con `test/helpers/claude-reply.js`.
