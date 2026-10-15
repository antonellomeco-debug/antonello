# ☁️📱 Il programma sempre acceso e sul telefono (Railway + iPhone)

Con questa guida il programma gira **su un server su internet** (Railway), 24 ore su 24, anche con il Mac spento.
Lo usi dal **telefono** come un'app (icona «Agenti» nella schermata Home) e dal computer con il browser.
Serve una **password**: senza, nessuno può entrare.

**Tempo:** circa 30–40 minuti, una volta sola.
**Costo:** Railway, piano Hobby: **5 $ al mese** (comprende 5 $ di consumo, che per questo programma di solito
bastano). Il costo di Claude resta quello di prima.
**Ti servono:** il tuo account GitHub (quello del programma), una carta di credito, l'iPhone.

> Le scritte di Railway sono in inglese: nella guida le trovi **in grassetto**, così come appaiono sullo schermo.
> Se una voce ha un nome leggermente diverso, cerca quella più simile.

---

## Parte 1 — Prima di cominciare

1. **Scegli la password dell'app.** Almeno **10 caratteri**, diversa da quelle che usi altrove. Un modo facile:
   tre parole e un numero, per esempio `lampada-fiume-oro-47`. Salvala nelle **Password** dell'iPhone o in una nota
   con il lucchetto.
2. **Se hai già agenti e palazzo sul Mac**, portali con te:
   1. sul Mac apri il programma e aggiornalo (⚙️ **Impostazioni → 🔄 Aggiornamenti → Aggiorna ora**);
   2. vai in ⚙️ **Impostazioni → 💾 Dati → ⬇️ Esporta i dati**: si scarica un file `agenti-dati-…zip`
      (lo trovi nella cartella **Download**). Contiene agenti, palazzo, portafoglio, chiave di Claude e collegamento
      cTrader: **non mandarlo a nessuno**.
   3. **Chiudi il programma sul Mac** e toglilo dall'avvio automatico (**Impostazioni di Sistema → Generali → Elementi
      login** → seleziona **Avvia Agenti** → **−**). D'ora in poi lavora il server: se il Mac restasse acceso con gli
      stessi dati, gli agenti lavorerebbero due volte (costi doppi) e il collegamento con cTrader si romperebbe.

## Parte 2 — Account Railway

1. Apri **railway.com** e premi **Login**, poi scegli **GitHub** e, nella pagina di GitHub, **Authorize**.
2. Passa al piano **Hobby**: apri **railway.com/workspace/plans**, scegli **Hobby** e inserisci la carta.
   *Serve subito:* la prova gratuita può bloccare il collegamento con cTrader.
3. Scegli l'Europa: apri **railway.com/workspace** e come regione preferita (*preferred region*) scegli
   **EU West** (Amsterdam).
4. Metti un avviso di spesa: apri **railway.com/workspace/usage** → **Set Usage Limits** → in **Custom email alert**
   scrivi `8`. Ti arriva un'email se il consumo supera 8 $. *(Non impostare un limite massimo basso: al limite
   Railway spegne il programma, e le posizioni aperte resterebbero senza controllo, protette solo dal loro stop loss.)*

## Parte 3 — Metti online il programma

1. Apri **railway.com/new** e scegli **Deploy from GitHub repo** (o **GitHub repo**).
2. La prima volta premi **Configure GitHub App**: su GitHub scegli **Only select repositories**, spunta
   **antonello** e premi **Install & Authorize** (o **Save**). Torna su Railway.
3. Scegli **antonello**. Se compare la scelta, premi **Add variables** (così configuri prima di partire).
   Se invece parte subito, va bene lo stesso: completa i passi seguenti.
4. Clicca il riquadro del servizio **antonello**, apri la scheda **Variables** e, con **New Variable**, aggiungi
   queste tre variabili (nome a sinistra, valore a destra):

   | Nome | Valore |
   |---|---|
   | `APP_PASSWORD` | la tua password (Parte 1) |
   | `PORT` | `3000` |
   | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `15` |

   *PORT* dice a Railway dove risponde il programma; l'ultima variabile gli lascia 15 secondi per salvare tutto
   quando si riavvia.
5. **Volume (i tuoi dati):** sullo sfondo del progetto (lo spazio grigio intorno al riquadro) fai clic con il
   **tasto destro** e scegli **Volume** (oppure premi **⌘ + K** e scrivi `volume`). Collegalo al servizio
   **antonello** e come **Mount path** scrivi `/data`.
   *Senza volume, a ogni aggiornamento agenti e palazzo ripartirebbero da zero: l'app te lo segnala con una
   striscia gialla.*
6. Nel servizio apri **Settings** e controlla:
   - **Source** → il ramo (*Branch connected to production*) deve essere `claude/sharp-mccarthy-231pjj`;
   - **Networking → Public Networking → Generate Domain**: compare l'indirizzo dell'app, tipo
     `https://antonello-production-xxxx.up.railway.app`. **Copialo e salvalo.** Se ti chiede la porta, scrivi `3000`;
   - **Deploy → Healthcheck Path**: scrivi `/healthz`;
   - **Deploy → Restart Policy**: scegli **Always**;
   - **Deploy → Serverless**: deve essere **spento** (così il programma non si addormenta);
   - **Scale → Regions**: **EU West** (se non l'hai scelto al punto 3 della Parte 2).
7. In alto compare una striscia viola con le modifiche: premi **Deploy**. Dopo 2–4 minuti, nella scheda
   **Deployments**, la versione diventa verde (**Active** / **Success**).

## Parte 4 — Primo accesso (dal computer)

1. Apri nel browser l'indirizzo salvato (`https://…up.railway.app`): compare la pagina **I miei agenti** con la
   password. Scrivila e premi **Entra**.
   - Se vedi «**Imposta la variabile APP_PASSWORD**…»: la variabile manca o è più corta di 10 caratteri
     (Parte 3, punto 4). Correggila e premi **Deploy**.
   - Se vedi la striscia gialla «**I dati non sono salvati in modo permanente**»: manca il volume (Parte 3, punto 5).
2. **Hai esportato i dati dal Mac?** Vai in ⚙️ **Impostazioni → 💾 Dati → ⬆️ Importa i dati**, scegli il file
   `agenti-dati-…zip`, conferma e scrivi la password. Il programma si riavvia e la pagina si ricarica da sola:
   ritrovi palazzo, agenti, portafoglio, chiave di Claude e cTrader.
   **Non l'hai fatto?** Inserisci la chiave di Claude in ⚙️ **Impostazioni**, come sul Mac.

## Parte 5 — cTrader dal server

Il server ha un indirizzo nuovo: cTrader deve conoscerlo per il collegamento.

1. Apri **openapi.ctrader.com**, entra con il tuo cTrader ID e apri **Applications**.
2. Sulla riga della tua app premi **Edit**, scendi a **Redirect URIs**, scrivi in un campo vuoto (o dopo
   **Add redirect URI**) l'indirizzo dell'app seguito da `/ctrader/callback`, per esempio
   `https://antonello-production-xxxx.up.railway.app/ctrader/callback`, e premi **Save**.
   Lascia anche quello di prima (`http://localhost:3000/ctrader/callback`). L'indirizzo esatto lo trovi nell'app:
   🔌 **Broker** → passo 1 → **Come si fa** → pulsante **Copia**.
3. Nell'app, in 🔌 **Broker**:
   - se hai importato i dati del Mac, cTrader risulta già **✔ Collegato**: controlla solo che si vedano i conti;
   - altrimenti premi **Collega cTrader** come sul Mac (Client ID e Secret, poi **Allow access**).
     *Consiglio:* fai questo passaggio dal computer, non dall'app sul telefono.

## Parte 6 — L'app sull'iPhone

1. Apri **Safari** (non Chrome) e scrivi l'indirizzo dell'app.
2. Tocca **Condividi** (il quadrato con la freccia ⬆︎). Se non lo vedi, tocca prima i tre puntini **•••** accanto
   all'indirizzo, poi **Condividi**.
3. Scorri e tocca **Aggiungi alla schermata Home**. Lascia acceso **Apri come app web** (se c'è) e tocca **Aggiungi**.
4. Nella schermata Home compare l'icona **Agenti**: aprila e **scrivi la password una volta** (l'app installata non
   condivide l'accesso con Safari). Puoi farla ricordare all'iPhone.
5. Come si usa:
   - in basso ci sono **🏢 Ufficio · 💬 Orion · ✅ Approvazioni · 📝 Bacheca · ☰ Altro** (in **Altro**: universo,
     portafoglio, broker, attività, impostazioni, nuovo agente, esci);
   - nell'Ufficio, la barra sopra il 3D sceglie **🌌 Universo** (tutti i palazzi) o un palazzo; **+ Palazzo** ne crea uno;
   - nel palazzo: un dito per girare, due per avvicinarti; **tocca un agente** per vederne il nome, **toccalo di
     nuovo** (o tocca il nome) per aprire la sua scheda;
   - in chat **Invio va a capo**: per mandare il messaggio tocca **➤**;
   - per parlare con Orion a voce tocca **🎤** (vedi sotto).

## Messaggi vocali a Orion

1. Nella chat con Orion tocca **🎤**.
2. **Solo la prima volta** l'app chiede di preparare il riconoscimento della voce: tocca **OK**. Il server scarica
   circa 560 MB, una volta sola (qualche minuto: puoi continuare a scrivere). Quando è pronto, nella chat compare
   «✅ Messaggi vocali pronti».
3. Tocca **🎤**: la prima volta l'iPhone chiede il permesso per il **microfono** → **Consenti**.
4. Parla. Compare la barra rossa con il tempo. Quando hai finito tocca **➤** per mandare, oppure **✕** per annullare
   (al massimo 2 minuti).
5. Il messaggio compare nella chat con **🎤** e il testo capito: Orion lo legge e risponde.
6. **Orion ti risponde anche a voce** (con la voce italiana dell'iPhone). Se non lo vuoi, tocca **🔊** in alto: diventa
   **🔇**. Se non senti niente, togli il silenzioso (l'interruttore sul lato) e alza il volume.

La voce viene trasformata in testo **sul tuo server**, non da altri servizi, e non costa niente in più (pochi centesimi
di consumo su Railway). Il programma tiene la memoria occupata solo per qualche minuto dopo un messaggio vocale.
Se l'iPhone continua a chiedere il permesso del microfono: **Impostazioni → App → Safari → Microfono → Consenti**.
In alternativa puoi sempre dettare con il **microfono della tastiera** dell'iPhone.

## Social (Instagram, LinkedIn, Threads, X)

1. Apri **📣 Social** (sull'iPhone: **☰ Altro → 📣 Social**).
2. Per ogni social che vuoi usare apri **«Come si fa (una volta sola)»** e segui i passi: crei la tua app di
   sviluppatore, incolli l'indirizzo di ritorno che vedi lì, poi copi **ID** e **Secret** nei due campi e premi **Salva**.
   Il Secret non si chiede mai in chat e non si vede più dopo averlo salvato.
3. Premi **🔗 Collega**: si apre la pagina del social, accedi e conferma. Torni nell'app con «collegato».
4. In **Foto e video** premi **⬆️ Carica foto o video** e scegli dal rullino. Sotto ogni file scrivi due parole su cosa
   mostra: aiuta gli agenti.
5. I post degli agenti arrivano in **✅ Approvazioni** con testo e immagini: **Pubblica** o **Scarta**. Se un social lo
   metti su **Automatica**, gli agenti pubblicano da soli (sempre entro il massimo di post al giorno che scegli).
6. **LinkedIn** dopo 60 giorni chiede di essere ricollegato: compare un **!** su 📣 Social, premi **Ricollega**.
   **X** si paga a consumo (0,015 $ a post, 0,20 $ se contiene un link): tieni un po' di credito su console.x.com.

**Social non collegati** (per esempio se Meta non ti manda il codice): gli agenti lavorano lo stesso. I loro post arrivano
in ✅ Approvazioni con il pulsante **📲 Condividi**: lo tocchi, scegli l'app del social (le foto sono già pronte e il testo
è già copiato: su Instagram tieni premuto nella didascalia → Incolla), pubblichi e torni a toccare **Fatto**.

Foto e video restano nel volume del server e **non** entrano nella copia dei dati (sono grandi): tieni gli originali.

## Aggiornamenti e copie di sicurezza

- **Gli aggiornamenti arrivano da soli:** quando pubblico una nuova versione, Railway la installa in 2–4 minuti
  (per circa un minuto l'app non risponde). Il pulsante 🔄 Aggiorna non serve più. Sull'iPhone, se vedi ancora la
  versione vecchia, chiudi l'app (scorri in su dal basso e manda via la sua scheda) e riaprila.
- **Copia dei dati:** il piano Hobby di Railway non fa copie automatiche. Una volta a settimana vai in
  ⚙️ **Impostazioni → 💾 Dati → ⬇️ Esporta i dati** e tieni il file (per esempio su iCloud Drive).
- **Spesa:** dopo una settimana controlla **railway.com/workspace/usage**.

## Se qualcosa non funziona

| Cosa vedi | Cosa fare |
|---|---|
| La versione in **Deployments** è rossa (**Failed** / **Crashed**) | Apri la versione: in basso trovi il registro. Mandami le ultime righe (mai la password). Puoi riprovare con **⋮ → Redeploy**. |
| «**Application failed to respond**» | Il programma si sta avviando o si è fermato: aspetta 2 minuti. Se resta così, controlla che `PORT` sia `3000` e che il dominio punti alla porta `3000` (**Settings → Networking**, matita accanto all'indirizzo). |
| «**Imposta la variabile APP_PASSWORD…**» | Aggiungi o correggi `APP_PASSWORD` (almeno 10 caratteri) in **Variables**, poi **Deploy**. |
| «**Password sbagliata**» o «**Troppi tentativi**» | Ricontrolla la password in **Variables**. Dopo molti errori l'app fa aspettare un po': riprova tra qualche minuto. |
| Striscia gialla sui dati non permanenti | Manca il volume: Parte 3, punto 5. |
| cTrader: «**Provided application does not contain provided URI**» | L'indirizzo in **Redirect URIs** non è identico: ricopialo dall'app (🔌 Broker → passo 1 → **Come si fa** → **Copia**) senza barre in più. |
| cTrader: «**Rinnovo dell'accesso non riuscito**» | Probabilmente il programma è acceso anche sul Mac con gli stessi dati: chiudilo lì, poi nell'app premi **🔗 Ricollega**. |
| L'icona sull'iPhone apre Safari invece dell'app | L'icona è un semplice segnalibro: cancellala e aggiungila di nuovo con **Apri come app web** acceso. |
| Sull'iPhone devi rimettere la password ogni volta | Controlla di aprire l'app dall'icona **Agenti** e non da un link; l'accesso dura 60 giorni dall'ultimo uso. |
| 🎤: «**Il microfono non è consentito**» | Sull'iPhone: **Impostazioni → App → Safari → Microfono → Consenti**, poi chiudi l'app (scorri in su e mandala via) e riaprila. |
| 🎤: «**Non ho sentito la tua voce**» o «**Non ho capito le parole**» | Parla più vicino al telefono, in un posto meno rumoroso, e riprova. |
| L'app sul telefono mostra «**Server non raggiungibile**» | Il server si sta aggiornando o internet manca: aspetta un minuto e tocca **Riprova**. |

Le impostazioni tecniche (variabili facoltative, come funziona l'accesso) sono descritte nel [README](README.md#sul-server-railway).
