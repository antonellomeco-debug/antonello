---
name: venturo-contenuti
description: Come si producono i contenuti social di Venturo (Reel, caroselli, storie, Shorts, post LinkedIn e Threads) senza che il fondatore appaia, con la sua voce clonata e i video animati della piattaforma. Usala quando Antonello chiede contenuti, un piano editoriale, video, caroselli o storie, o quando prepari messaggi per Orion sulla produzione.
---

# Produzione dei contenuti di Venturo

Leggi prima `venturo-brand` (identità e regole). Qui ci sono il **ritmo**, i **formati** e le **ricette** basati sulla
ricerca di ottobre 2026 sui contenuti più visti nel business e nella finanza (account senza volto). Antonello **non appare
mai**: al massimo la sua voce clonata (ElevenLabs), dichiarata come voce generata con IA.

## Ritmo di Instagram (deciso da Antonello il 18/10/2026)

| Giorno | Feed (1 al giorno) | Storie (5 al giorno) |
| --- | --- | --- |
| Lun | Reel «Bando della settimana» (chi può chiederlo, quanto, scadenza) | dato · sondaggio «Lo chiederesti?» · ripresa del Reel · dietro le quinte · link newsletter |
| Mar | Reel «Come fa soldi» (azienda italiana nota, con i numeri) | risposta di ieri · quiz · ripresa · strumento del giorno · box domande |
| Mer | Reel «Il numero della settimana» (grafico animato) | notizia · cursore · ripresa · dietro le quinte · link |
| Gio | Reel «Caso studio» (azienda venduta, socio trovato, crescita) | dato · sondaggio · ripresa · risposte alle domande · link |
| Ven | Reel «Borsa e IPO della settimana» (solo informativo) | 3 numeri della settimana · quiz · ripresa · anteprima newsletter · link |
| Sab | Carosello «Guida passo per passo» (bando, finanziamento, checklist) | «Aggiungi il tuo» · Reel più inviati · sondaggio temi · box domande · link |
| Dom | Carosello «Mappa o classifica» (regioni, settori, investimenti) | anteprima della settimana: scadenze, calendario, sondaggio, domanda, link |

Orari di partenza (poi si guardano i numeri): Reel 12:30 o 18:30, caroselli 10:00, storie distribuite nella giornata.
Nell'app: Instagram → massimo 1–2 post al giorno, **storie al giorno 5** (contate a parte dai post).

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
- Schema: 1 dato o notizia · 2 sondaggio o quiz (la risposta il giorno dopo) · 3 ripresa del post del giorno · 4 dietro
  le quinte (fonti, strumenti, numeri della newsletter) · 5 link alla newsletter o box domande.
- Grafiche 1080×1920 con `create_graphic` (formato story) o brevi video animati di 5–8 s con `create_motion_video`.
- Gli adesivi interattivi (sondaggio, quiz, link) si aggiungono solo dall'app di Instagram: se servono, l'agente lo scrive
  nella nota per Antonello; altrimenti si usa una domanda scritta nella grafica («Rispondi con un messaggio»).

## Altri social

- **LinkedIn**: caroselli di 8–10 immagini (i PDF si caricano a mano dall'app di LinkedIn); post del fondatore come testo personale («costruiamo Venturo in pubblico»), link nel primo commento.
- **Threads/X**: sempre il grafico del giorno insieme al testo; una domanda aperta al giorno su Threads.
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
