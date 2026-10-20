---
name: venturo-orion
description: Come scrivere i messaggi da incollare a Orion, il regista della piattaforma di agenti di questo repository, per creare o cambiare palazzi, piani, stanze, agenti, collegamenti, post, impostazioni social e brief. Usala quando Antonello chiede di far fare qualcosa a Orion o agli agenti (Palazzo Social, Palazzo Ricerca e Sviluppo, Palazzo Investimenti).
---

# Messaggi per Orion

Orion è l'assistente della piattaforma (`lib/orchestrator.js`). Antonello gli parla dalla chat dell'app (anche a voce
dall'iPhone). Claude Code non parla con Orion direttamente: prepara i messaggi, Antonello li incolla.

## Prima di scrivere

1. Controlla gli strumenti che Orion ha davvero: l'elenco `TOOLS` e `ORION_SOCIAL_TOOLS` in `lib/orchestrator.js`, gli
   strumenti degli agenti in `ALL_TOOLS` di `lib/config.js`, i modelli in `lib/models.js`. Non chiedere a Orion
   strumenti che non esistono: se serve una funzione nuova, va scritta nel codice (con test) e pubblicata.
2. Uno strumento aggiunto nel codice funziona solo dopo l'unione nel ramo principale e l'aggiornamento dell'app
   (🔄 Aggiorna o il nuovo deploy su Railway). Se un messaggio dipende da codice non ancora pubblicato, dillo.
3. Rileggi il brief (`.claude/skills/venturo-brand/brief.txt`): i messaggi devono rispettare le sue regole.

## Regole della piattaforma da rispettare nei messaggi

- `save_agent`: `mode` «llm» con `instructions`, `model` tra quelli di `lib/models.js` (di base `claude-haiku-5-5`;
  `claude-sonnet-5-5` solo per chi deve ragionare di più), `effort` «low» salvo motivi seri, `everyMinutes` 0 (solo a mano)
  oppure almeno 5; valori comodi: 60 = ogni ora, 360 = ogni 6 ore, 1440 = ogni giorno, 10080 = ogni settimana,
  20160 = ogni 2 settimane, 43200 = ogni mese. `onlyOnNews: true` fa lavorare un agente solo se ci sono note nuove nelle
  stanze che legge. `readsFrom` = stanze dello stesso piano da leggere.
- Gli agenti leggono le stanze dei piani collegati: `set_link` con `one-way` porta le informazioni da `from` a `to`.
  Collegamenti tra palazzi diversi = come i palazzi comunicano. Il Palazzo Investimenti resta separato da Venturo.
- `save_palace.hours`: «lavoro» (lun–ven), «tutti-i-giorni» (social), «sempre».
- Note con l'etichetta RICHIESTA diventano domande per Antonello in ✅ Approvazioni: chiedere agli agenti di usarle solo
  quando serve davvero una sua decisione.
- `web_search`: dire «al massimo 3 ricerche per lavoro». Costa 10 $ ogni 1.000 ricerche più i token.
- Solo Antonello può: chiavi e password, collegare account e conti, soldi veri, STOP e limiti, budget, ordini di trading.
  Non scrivere messaggi che chiedono a Orion queste cose.
- Spesa: prima di creare molti agenti stimare il costo (`get_costs`); preferire agenti settimanali su Haiku.

## Forma dei messaggi

- Italiano semplice, rivolto a Orion («Orion, …»). Un obiettivo per messaggio; più messaggi numerati se il lavoro è grande
  (es. 1 = palazzo, piani, stanze, collegamenti; 2 = agenti; 3 = brief o impostazioni). Massimo circa 6.000 caratteri.
- Per ogni agente: emoji e nome, stanza, `model`/`effort` se diversi dal solito, `everyMinutes`, `onlyOnNews`, `tools`,
  istruzioni tra « » con: cosa fa, quando, cosa scrive (nome della nota in MAIUSCOLO), limiti («non inventare numeri»,
  fonti e date, regole del brief).
- Chiudi con cosa Orion deve rispondere (elenco di ciò che ha creato, id delle stanze, stima dei costi) e, se utile,
  un primo avvio a mano di uno o due agenti.
- Consegna: una pagina artifact con un riquadro e un tasto «Copia» per ogni messaggio, numerati, con l'avviso dei messaggi
  che dipendono da un aggiornamento non ancora pubblicato. Esempio già fatto: https://claude.ai/artifact/Th8PfDYcafPjH6NeX1K7AD
- Nella risposta ad Antonello: link alla pagina, poi i passi (copia, incolla nella chat di Orion, aspetta la risposta,
  messaggio successivo).

## Palazzi di Venturo (ottobre 2026)

- **Palazzo Social:** 4 piani (Instagram, LinkedIn, Threads, X), 5 stanze per piano (Direzione, Trend, Studio, Redazione,
  Analisi), più di 30 agenti tra cui un Brand Manager e un Community Manager per piano. Orario «tutti-i-giorni».
- **Palazzo Ricerca e Sviluppo:** Piano Terra Brand e Numeri (Cruscotto, Direzione), 1° Mercato e Concorrenti (Osservatorio;
  dal 20/10/2026 anche «Pianificazione e Fisco» con il 🧮 Consulente Pianificazione e Fisco, Sonnet medium ogni 2880 min, note
  GUIDA PER LE IMPRESE e ARGOMENTI FISCO E PIANIFICAZIONE: https://claude.ai/artifact/Cxk4dxe4LRZE25FaEVm4WK),
  2° Prodotto (Laboratorio), 3° Capitali e Borsa (Finanza), 4° Regole (Conformità); 9 agenti, quasi tutti settimanali su Haiku.
- **Palazzo Investimenti:** trading (piano Gold e altri), non legato a Venturo.

I dati veri stanno sul server dell'utente: verifica con Antonello (o chiedi a Orion `list_agents`) prima di dare per
scontati nomi e id.
