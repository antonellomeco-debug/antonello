---
name: venturo-sito
description: Come progettare e costruire il sito di Venturo (venturoitalia.it), la pagina della newsletter e le pagine future della piattaforma, usando le skill di design installate (Hallmark, Impeccable, diagram-design) con l'identità di Venturo. Usala quando Antonello chiede il sito, una landing page, la pagina della newsletter, una lista d'attesa o una revisione grafica di una pagina.
---

# Il sito di Venturo

Dominio: **venturoitalia.it** (comprato su Aruba il 20/10/2026; email info@venturoitalia.it su Aruba con inoltro a Gmail).
Leggi prima `venturo-brand` (identità, regole che non si toccano) e `scrittura-umana` (testi). Antonello non è un
programmatore: spiega in italiano, a passi numerati, e chiedi conferma prima di pubblicare o di toccare il dominio.

## Quale skill per cosa

| Lavoro | Skill | Note |
| --- | --- | --- |
| Pagina nuova (home, newsletter, lista d'attesa, chi siamo) | `hallmark` | Modo **custom** con il DESIGN.md qui sotto (colori e caratteri bloccati): niente temi con altre palette. Controlla con `scripts/sloplint.mjs --render`. |
| Revisione, rifinitura, accessibilità, telefono, casi limite | `impeccable` | `critique`, `audit`, `polish`, `harden`, `adapt`. Usa il PRODUCT.md qui sotto. Il lanciatore scarica il suo motore da GitHub (versione fissata, controllo SHA-256); se non va, la skill funziona leggendo i file. |
| Schemi e diagrammi (come funziona Venturo, le fasi, il percorso di vendita di un'azienda) | `diagram-design` | Già con i colori di Venturo (`references/style-guide.md`, profilo venturo). |
| Testi della pagina | `scrittura-umana` | Prima riga = il fatto; niente promesse di guadagno. |
| Grafiche per i social dalla pagina | strumenti della piattaforma (`create_graphic`) | |
| Quali pagine, menu, indirizzi | `site-architecture` | Raccolta Marketing Skills (MIT): legge `.agents/product-marketing.md`. |
| Testi delle pagine | `copywriting` poi `scrittura-umana` | In italiano, con il filtro delle regole di Venturo. |
| Regalo in cambio dell'iscrizione | `lead-magnets` | Per esempio una guida PDF ai bandi del mese. |
| Email di benvenuto e newsletter | `emails` | Sequenza dopo l'iscrizione. |
| Lancio del sito | `launch` | Lista d'attesa, annuncio sui social. |
| SEO (Google) | `seo-audit` | Dopo la messa online. |
| Decisioni grosse (prezzi, nome, lancio) | `marketing-council` | Consiglio simulato di 12 grandi del marketing, con il filtro Venturo. |

Hallmark e Impeccable non si usano insieme sulla stessa pagina nello stesso passaggio: Hallmark costruisce, Impeccable controlla e rifinisce.

## PRODUCT.md (per Impeccable, da copiare nella cartella del sito)

```markdown
# Venturo
Cos'è: media e piattaforma per chi fa impresa in Italia: capitali, soci, aziende in vendita, professionisti, informazioni.
Fase attuale: 1 (media, newsletter gratuita, community). Nessuna società ancora aperta: niente vendite né abbonamenti sul sito.
Pubblico: titolari di PMI tradizionali, chi vuole aprire o rilevare un'azienda, investitori privati e business angel,
professionisti al servizio delle imprese. Leggono soprattutto dal telefono, spesso di sera.
Azione principale: iscriversi alla newsletter. Secondaria: seguire Instagram e LinkedIn.
Voce: competente, chiara, ottimista ma concreta; dà del tu; numeri veri con fonte e data; niente hype.
Vincoli: niente promesse di rendimento né consigli su singoli titoli («Contenuto informativo, non è consulenza finanziaria»);
non raccoglie soldi per conto di altri; nessun volto del fondatore; dati veri, mai inventati (niente testimonianze o loghi finti).
Prove disponibili: solo quelle che Antonello fornisce (numeri della newsletter, post usciti). Se mancano, la pagina non le finge.
Lingua: italiano.
```

## DESIGN.md (per Hallmark e Impeccable)

```markdown
# Venturo: sistema visivo (bloccato)
Colori: navy #0A1F44 (fiducia, sfondi scuri, titoli); blu elettrico #2F5BFF (accento, link, pulsanti; su scuro #7C9BFF);
verde crescita #0B7A45 su chiaro, #2BD67B su scuro (solo dati in crescita e conferme); inchiostro #0B1220; testo
secondario #5B6575; nebbia #EEF2F7; fondo #F7F9FC. Niente rosso come colore principale, niente sfumature viola-blu.
Caratteri: Sora (titoli, 700–800), Inter (testi), IBM Plex Mono (numeri e date). File Sora in assets/fonts/ del repository.
Logo: V con il braccio destro più alto e punto verde in alto a destra; logotipo «venturo» minuscolo. File in
.claude/skills/venturo-brand/kit/.
Tono visivo: editoriale e finanziario, dati in primo piano, molto spazio bianco, angoli 12 px, ombre leggere o nessuna.
```

## Pagine della fase 1 (proposta)

1. **Home**: cosa trovi in Venturo in una frase, iscrizione alla newsletter in alto e in fondo, ultimi temi (bandi, numeri,
   casi), link ai social. Nessun volto: al posto della foto del fondatore il kit grafico e i contenuti veri.
2. **Newsletter**: cosa arriva e quando, un numero di esempio, archivio (quando ci saranno numeri usciti).
3. **Chi siamo / manifesto**: la missione, le regole (dati veri, niente promesse), il percorso in tre fasi.
4. **Contatti**: info@venturoitalia.it.
5. **Privacy e cookie**, **Note legali**: obbligatori (GDPR). Con l'iscrizione alla newsletter: consenso esplicito e doppia
   conferma via email. Statistiche senza cookie (per esempio Plausible o Umami) per evitare il banner dei cookie; se servono
   cookie di terze parti, banner con rifiuto facile come l'accettazione. Quando la società sarà aperta: partita IVA e ragione
   sociale nel piè di pagina (obbligatori per legge). Far rivedere i testi legali a un professionista prima del lancio.

Dopo (fase 2): lista d'attesa di Venturo Deal, Cerca soci, Albo dei professionisti.

## Dove sta il codice e dove gira

- Il sito è un sito statico (HTML e CSS, poco JavaScript): conviene un **repository a parte** (per esempio `venturo-sito`),
  così le modifiche al sito non ridistribuiscono il server degli agenti su Railway. Se Antonello preferisce un solo
  repository, cartella `sito/` (già fuori dall'immagine Docker se aggiunta a `.dockerignore`). Chiediglielo all'inizio.
- Hosting gratuito per siti statici: Cloudflare Pages, Netlify o GitHub Pages. Il dominio resta su Aruba: si cambiano solo i
  record DNS del sito (`www` e il dominio principale). **Non toccare i record MX e quelli dell'email**, altrimenti
  info@venturoitalia.it smette di funzionare. Prima di cambiare il DNS, chiedi conferma e fai una foto dei record attuali.
- Iscrizioni alla newsletter: servizio esterno (per esempio Brevo, MailerLite, Substack o beehiiv, con piano gratuito);
  la scelta spetta ad Antonello. Il modulo del sito manda all'indirizzo del servizio, nessun dato salvato da noi.

## Come procedere

1. Chiedi ad Antonello: repository a parte o cartella `sito/`; servizio della newsletter; cosa può fornire (numeri, foto,
   testi). Non inventare ciò che manca.
2. Scrivi PRODUCT.md e DESIGN.md nella cartella del sito (testi sopra).
3. Costruisci con `hallmark` (custom), una pagina alla volta, prima l'apertura (hero) poi il resto.
4. Controlla con `impeccable critique` e `audit` (telefono iPhone 13 con Playwright, contrasti, tastiera, testi lunghi).
5. Testi con `scrittura-umana`.
6. Pubblica un'anteprima (link provvisorio di Cloudflare Pages o Netlify) e mandala ad Antonello prima di collegare il dominio.
