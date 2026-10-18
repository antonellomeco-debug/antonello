---
name: venturo-brand
description: Identità, regole e documenti di Venturo, il progetto di Antonello (media + piattaforma per chi fa impresa in Italia). Usala per qualsiasi testo, grafica, pagina, post, presentazione, strategia o analisi che riguarda Venturo, i suoi social, la newsletter, i soci o gli investitori.
---

# Venturo: il brand

Venturo è il progetto di Antonello (fondatore unico, a tempo pieno, budget iniziale fino a 5.000 €, nessuna società ancora,
ottobre 2026). Il testo di riferimento è `brief.txt` in questa cartella: leggilo per intero prima di scrivere qualsiasi
cosa su Venturo. È lo stesso testo che gli agenti della piattaforma ricevono come «brief del progetto».

## In breve

- **Cos'è:** la piazza dove chi fa impresa in Italia trova capitali, soci, aziende in vendita, professionisti e informazioni.
- **Fasi:** 1) media + newsletter + community (adesso); 2) piattaforma: Venturo Deal (vendi o rileva un'azienda), Cerca soci,
  Albo dei professionisti, abbonamenti Pro 12 €/mese, Business 49 €/mese, Investor 29 €/mese; 3) Venturo Club, eventi,
  investimenti solo tramite portali autorizzati Consob, Europa, quotazione su Euronext Growth Milan (2033–2035).
- **Pubblico:** titolari di PMI tradizionali, chi vuole aprire o rilevare un'azienda, investitori privati e business angel,
  professionisti al servizio delle imprese.
- **Tono:** competente, chiaro, ottimista ma concreto; dà del tu; numeri veri con fonte e data; niente hype.

## Identità visiva

| Ruolo | Colore |
| --- | --- |
| Navy (fiducia, sfondi scuri, titoli) | `#0A1F44` |
| Blu elettrico (accento, link, pulsanti) | `#2F5BFF` (su scuro `#7C9BFF`) |
| Verde crescita | `#2BD67B` su scuro, `#0B7A45` su chiaro |
| Neutri | `#0B1220` inchiostro, `#5B6575` testo secondario, `#EEF2F7` nebbia, `#F7F9FC` fondo |

- Caratteri: **Sora** per i titoli, **Inter** per i testi (Google Fonts). Per numeri e date si può usare IBM Plex Mono.
- Simbolo: una V il cui braccio destro sale più in alto, con un punto verde in alto a destra («il futuro che sorge»).
  SVG pronto: `<svg viewBox="0 0 200 200"><path d="M36 70 L92 152 L148 54" fill="none" stroke="#F7F9FC" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/><circle cx="168" cy="26" r="17" fill="#2BD67B"/></svg>`
  (tratto bianco su navy; su fondo chiaro il tratto è navy). Logotipo «venturo» in minuscolo, Sora 800.
- Niente rosso come colore principale (in finanza vuol dire perdita), niente sfumature viola-blu da startup generica.

## Regole che non si toccano

1. Mai promettere guadagni o rendimenti; mai consigli d'investimento personalizzati o previsioni su singoli titoli
   (per il Reg. UE 596/2014 un'opinione sul prezzo futuro è una «raccomandazione d'investimento»). Sui temi d'investimento
   chiudere con «Contenuto informativo, non è consulenza finanziaria».
2. Venturo non raccoglie soldi per conto di altri e non vende «accesso prioritario» a singoli investimenti: lo fanno solo
   i portali autorizzati (Reg. UE 2020/1503, Consob). Le idee dell'utente vanno adattate così: «analisi esclusive» invece di
   «segreti», anteprima sugli annunci di aziende in vendita invece di accesso prioritario agli investimenti.
3. Annunci di aziende in vendita a prezzo fisso, senza percentuali sull'affare (servirebbe l'iscrizione come mediatore,
   L. 39/1989). Niente intermediazione di lavoro (d.lgs. 276/2003).
4. Dal 2025 una startup innovativa non può avere come attività principale l'intermediazione: Venturo si presenta come
   piattaforma tecnologica e media.
5. Dati veri e verificati, mai inventati; testi fatti con l'IA controllati prima di uscire. Crescita vera (iscritti email,
   invii, salvataggi, commenti di sconosciuti), mai follower comprati, pod o concorsi per follower.

## I documenti del progetto (artifact su claude.ai, privati dell'utente)

| Documento | Link |
| --- | --- |
| Pitch deck per investitori e soci | https://claude.ai/artifact/U35Seow87fKr9vjPkQLTFL |
| Business plan | https://claude.ai/artifact/JxwusJVPh86ZD39mghqCRF |
| Roadmap 2026–2035 | https://claude.ai/artifact/J3W3Drg8BsUnzQWyZfKBNQ |
| Piano dei 30 giorni (con database: compiti, numeri, note, briefing) | https://claude.ai/artifact/8NkLfFwLJJsjyVY3Z3AUii |
| Guida ai profili social | https://claude.ai/artifact/Me2c6tvLuFonpmqXx8UyTa |
| Messaggi per Orion (palazzo Ricerca e Sviluppo e brief) | https://claude.ai/artifact/Th8PfDYcafPjH6NeX1K7AD |
| Video, voce e ritmo di Instagram (guida voce ElevenLabs + messaggio per Orion) | https://claude.ai/artifact/Byds6y5cGEPoccmNwXiM8y |

Per leggerli usa lo strumento Artifact con `action: "read"`, mai un download. Per aggiornarne uno pubblica sullo stesso `url`
dopo averlo letto. Il piano dei 30 giorni si aggiorna con lo strumento ArtifactData (vedi la skill `venturo-briefing`).

## Come lavorare per Venturo

- Rispondi ad Antonello in italiano, con passi numerati semplici: non è un programmatore.
- Pagine e presentazioni: usa i colori e i caratteri qui sopra, testi pronti da copiare con un tasto «Copia».
- Quando servono messaggi per Orion (creare agenti, piani, post, impostazioni) segui la skill `venturo-orion`.
- Ogni mese c'è il briefing: skill `venturo-briefing`.
- Se una richiesta tocca soldi di altri, investimenti o mediazione, applica le regole sopra e spiega in modo semplice
  perché la proposta è stata adattata; per i casi dubbi consiglia il parere di un avvocato esperto di Consob.
