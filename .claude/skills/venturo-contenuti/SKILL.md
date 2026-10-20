---
name: venturo-contenuti
description: Come si producono i contenuti social di Venturo (Reel, caroselli, storie, Shorts, post LinkedIn e Threads) senza che il fondatore appaia, con la sua voce clonata e i video animati della piattaforma. Usala quando Antonello chiede contenuti, un piano editoriale, video, caroselli o storie, o quando prepari messaggi per Orion sulla produzione.
---

# Produzione dei contenuti di Venturo

Leggi prima `venturo-brand` (identità e regole). Qui ci sono il **ritmo**, i **formati** e le **ricette** basati sulla
ricerca di ottobre 2026 sui contenuti più visti nel business e nella finanza (account senza volto). Antonello **non appare
mai**: al massimo la sua voce clonata (ElevenLabs), dichiarata come voce generata con IA.

## Ritmo di Instagram (deciso da Antonello il 18/10/2026, Reel raddoppiati il 20/10/2026)

Dal 20/10/2026 nei giorni dei Reel (lun–ven) escono **2 Reel**: alle 11:30 «La notizia del giorno per chi fa impresa»
(20–35 s, notizia delle ultime 24 ore) e alle 18:30 il Reel del tema del giorno della tabella (45–75 s). Sab–dom 1 carosello.
Dopo ogni Reel il Regista scrive la nota **REEL PRONTO** (id, tema, ora, durata, didascalia): gli altri social riusano quei video.

| Giorno | Feed (Reel delle 18:30 o carosello) | Storie (5 al giorno) |
| --- | --- | --- |
| Lun | Reel «Bando della settimana» (chi può chiederlo, quanto, scadenza) | dato · sondaggio «Lo chiederesti?» · ripresa del Reel · dietro le quinte · link newsletter |
| Mar | Reel «Come fa soldi» (azienda italiana nota, con i numeri) | risposta di ieri · quiz · ripresa · strumento del giorno · box domande |
| Mer | Reel «Il numero della settimana» (grafico animato) | notizia · cursore · ripresa · dietro le quinte · link |
| Gio | Reel «Caso studio» (azienda venduta, socio trovato, crescita) | dato · sondaggio · ripresa · risposte alle domande · link |
| Ven | Reel «Borsa e IPO della settimana» (solo informativo) | 3 numeri della settimana · quiz · ripresa · anteprima newsletter · link |
| Sab | Carosello «Guida passo per passo» (bando, finanziamento, checklist) | «Aggiungi il tuo» · Reel più inviati · sondaggio temi · box domande · link |
| Dom | Carosello «Mappa o classifica» (regioni, settori, investimenti) | anteprima della settimana: scadenze, calendario, sondaggio, domanda, link |

Orari di partenza (poi si guardano i numeri): Reel 11:30 e 18:30, caroselli 10:00, storie distribuite nella giornata.
Nell'app: Instagram → massimo **2 post al giorno**, **storie al giorno 5** (contate a parte dai post).
Voce clonata: 10 Reel a settimana ≈ 28.000–30.000 caratteri al mese, quasi tutto lo Starter di ElevenLabs: consigliato il
modello Flash v2.5 (metà crediti). I video riusati sugli altri social non usano altra voce. Con il piano Creator
(~22 $/mese, ~100.000 crediti) anche le 3 storie video hanno la voce (~13.000–15.000 caratteri al mese in più; messaggio 6
nella pagina del nuovo ritmo): totale ~45.000 su 100.000.

## Reel e Shorts (strumento `create_motion_video`)

- Durata: 20–40 s per le notizie, 45–75 s per spiegazioni e casi; mai oltre 90 s.
- **Scena 1 = `hook`**: il gancio scritto e detto nei primi 2 secondi. Formule: numero shock («Lo Stato regala 50.000 € e il
  70% non li chiede»), domanda con soldi in gioco («Quanto vale davvero una pizzeria?»), contrasto, storia («Nel 2019 questa
  azienda di Brescia valeva 2 milioni…»), errore da evitare («Non aprire la partita IVA prima di vedere questo»).
- Una scena ogni 2–4 s; voce in frasi corte (8–15 parole) scritte come si parla; tipi di scena alternati (number, bars, line,
  donut, compare, list, timeline, media con foto o clip vere da `stock_search`/`stock_add`).
- Ogni numero ha `source`; dati veri, verificati con `web_search`; mai inventati.
- Chiusura ad anello (l'ultima frase richiama la prima) e scena finale `cta` che spinge all'**invio**: «Mandalo a chi…».
- Didascalia: prima riga = gancio; 3–5 righe utili; invito alla newsletter (link in bio); 3–5 hashtag pertinenti;
  «Voce generata con IA» se c'è la voce clonata; sui temi d'investimento «Contenuto informativo, non è consulenza finanziaria».
- Prima di un formato nuovo: un Trial Reel (mostrato solo a chi non segue). Lo stesso video va su YouTube Shorts e TikTok.

### Ricetta tipo (Reel da 35 s, «Il numero della settimana»)

1. `hook` — «Le PMI italiane hanno chiesto 40 miliardi in meno» (highlight «40 miliardi»)
2. `number` — value, suffix «mld €», label, source
3. `line` — andamento degli ultimi 6 anni, source
4. `compare` — prima/dopo o Italia/Europa
5. `list` — «Cosa vuol dire per te» in 3 punti
6. `cta` — «Mandalo a un imprenditore che conosci», sub «Newsletter gratuita · link in bio»

## Caroselli (strumento `create_graphic`, formato portrait 1080×1350)

- 8–10 slide. Slide 1: titolo con un numero e una promessa («7 bandi aperti a novembre (scadenze incluse)») e immagine forte.
- 25–40 parole per slide, una idea per slide; stile «da salvare»: guide passo per passo, liste di controllo, tabelle, mappe.
- Penultima: riassunto. Ultima: «Salva · Inviala al tuo socio · Newsletter gratuita (link in bio)».
- Colori e caratteri del brand; numero di pagina piccolo; fonte in basso.
- Lo stesso carosello va su LinkedIn come post con più immagini (la piattaforma non fa ancora i PDF; link nel primo commento).

## Storie (formato story, `format: "story"` in `social_publish`)

- 5 al giorno, mai più di 7; la **prima è la più forte** (circa un quarto esce dopo la prima).
- **3 video e 2 grafiche** (deciso da Antonello il 18/10/2026; messaggio per Orion nella pagina «Video e Voce»):

| Ora | Tipo | Storia |
| --- | --- | --- |
| 9:00 | Video 8–12 s | Il dato del giorno: hook → number/compare con source → statement «cosa vuol dire» |
| 12:00 | Grafica | Domanda o quiz («Rispondi con un messaggio»; risposta nella storia 1 del giorno dopo) |
| 15:00 | Video 6–10 s | Ripresa del Reel di oggi (scena `media` con il Reel) o del carosello → cta «Il video completo è sul profilo» |
| 18:00 | Grafica | Dietro le quinte (fonti, strumenti, numeri della newsletter) |
| 21:00 | Video 6–8 s | Newsletter: hook con il tema della prossima → cta «Newsletter gratuita · Link in bio» |

- Video delle storie: `create_motion_video` format story, al massimo 3 scene, testo grande leggibile senza audio, theme alternato
  (notte, verde, chiaro), **senza voce** (`seconds` 2,5–4 per scena) per non consumare i crediti di ElevenLabs, musica dell'archivio bassa.
- Gli adesivi interattivi (sondaggio, quiz, link) si aggiungono solo dall'app di Instagram: se servono, l'agente lo scrive
  nella nota per Antonello; altrimenti si usa una domanda scritta nella grafica («Rispondi con un messaggio»).
- Finché Instagram non è collegato le storie arrivano in ✅ Approvazioni: Antonello tocca 📲 Condividi → Instagram → Storia.

## Altri social (ritmo deciso da Antonello il 20/10/2026)

- **LinkedIn**: 1 post al giorno lun–ven, 8:00–9:30 (`max_per_day` 1). Lun carosello 6–8 immagini (guida o bando), mar video
  (il Reel più forte di lun–mar, testo nuovo), mer immagine con il numero della settimana e la fonte, gio video (caso studio),
  **ven solo testo** «Diario del fondatore» (costruiamo Venturo in pubblico). Niente link nel testo (primo commento).
- **Threads**: 3 post al giorno (`max_per_day` 3): 8:30 grafica con il dato del giorno, 13:00 **solo testo** (domanda aperta o
  opinione, anche mini-thread), 20:30 video (il Reel di oggi; sab–dom le slide del carosello).
- **X**: 3–4 post al giorno + 2 thread a settimana, **ogni post con un file** (grafica 1200×675 o un Reel; nei thread una
  grafica numerata per post). L'Editore non pubblica mai post solo testo: aspetta la GRAFICA.
- Messaggi per Orion del nuovo ritmo: https://claude.ai/artifact/6nyDKnf6AC62KygzXXLsWV
- **YouTube**: gli Shorts sono i Reel; una volta al mese un video lungo 8–15 minuti dal caso studio del giovedì.

## Cosa si misura (ogni lunedì)

Invii e salvataggi in rapporto alle persone raggiunte, percentuale di chi salta il Reel nei primi 3 secondi (obiettivo sotto
il 35%), iscritti alla newsletter. Non i like. Il formato che funziona si ripete, quello che non funziona si cambia.

## Voce clonata (ElevenLabs)

Antonello registra 1–2 minuti di audio (iPhone, Memo Vocali «Senza perdita», stanza con tende e tappeti, 20 cm dalla bocca,
tono da reel), crea una «Instant Voice Clone» su elevenlabs.io (piano Starter, uso commerciale), poi mette chiave e ID della
voce nell'app (📣 Social → 🎙️ Voce dei video → La tua voce). Mai chiedergli chiave o ID in chat. Nei testi per la voce:
numeri scritti come si leggono quando sono ambigui, sigle sciolte («pi emme i»), frasi brevi, punteggiatura che dà il ritmo.

## Regole che non cambiano

Niente contenuti altrui ripubblicati o con watermark (Instagram toglie dai consigliati chi li usa), niente promesse di
guadagno, niente consigli su singoli titoli, etichetta IA attiva quando c'è la voce clonata, fonte e data per ogni dato.
