# 🍎 Come avviare il programma sul Mac (guida per principianti)

Non serve saper programmare. Ti servono solo il Mac e una connessione internet.
La prima volta ci vogliono circa 10 minuti; dalla seconda volta basta un doppio clic.

> Il **Terminale** è una finestra in cui si scrivono dei comandi. Ogni volta che in questa guida trovi un comando in un riquadro grigio, **scrivilo (o copialo e incollalo) nel Terminale e poi premi Invio**.

---

## Parte 1 — La prima volta

### Passo 1: installa Node.js (il "motore" che fa girare il programma)

1. Apri **https://nodejs.org/en/download**.
2. In cima alla pagina c'è un riquadro grigio pieno di comandi: **non copiarli**.
3. **Scorri più in basso** e clicca il pulsante **macOS Installer (.pkg)**.
4. Apri il file scaricato (lo trovi nella cartella **Download**, si chiama tipo `node-v24….pkg`) e segui l'installazione: **Continua → Accetta → Installa**. Il Mac ti chiederà la password del computer: è normale.

> Se l'installazione dice che il tuo macOS è troppo vecchio, torna sulla pagina di download, scegli la versione **v22** nel menu delle versioni e scarica di nuovo **macOS Installer (.pkg)**.

### Passo 2: scarica il programma

1. Apri **https://github.com/antonellomeco-debug/antonello** (non serve accedere).
2. Clicca il pulsante verde **Code** → **Download ZIP**.
3. Apri la cartella **Download**:
   - se usi **Safari** trovi già una **cartella** che si chiama tipo `antonello-claude-sharp-mccarthy-231pjj` (Safari apre lo ZIP da solo);
   - se invece vedi un **file .zip**, fai doppio clic per aprirlo e comparirà la cartella.
4. **Rinomina** la cartella in `agenti-borsa` (clic sul nome, aspetta un secondo, riscrivi e premi Invio).
5. Nel Finder, dal menu in alto clicca **Vai → Inizio**: si apre la cartella con il tuo nome (l'icona della casetta). **Trascina lì dentro la cartella `agenti-borsa`**.

> Meglio non metterla in Documenti o sulla Scrivania: su molti Mac quelle cartelle vengono copiate su iCloud, e con loro anche la tua chiave di Claude.

### Passo 3: apri il Terminale

Premi **⌘ Cmd + barra spaziatrice**, scrivi **Terminale** e premi **Invio**. Si apre una finestra con del testo.

Controlla che Node.js sia installato scrivendo:

```
node -v
```

Deve comparire un numero che inizia con **v20 o più** (per esempio `v24.21.0`).
Se compare `command not found`, chiudi il Terminale (⌘ Cmd + Q), riaprilo e riprova. Se ancora non va, ripeti il Passo 1.

### Passo 4: entra nella cartella del programma

1. Nel Terminale scrivi **`cd`** seguito da **uno spazio** (non premere ancora Invio).
2. Nel Finder vai in **Vai → Inizio** e **trascina la cartella `agenti-borsa` dentro la finestra del Terminale**: il percorso si scrive da solo.
3. Premi **Invio**.

### Passo 5: installa i componenti (solo la prima volta)

```
npm install
```

Aspetta 1–2 minuti. Ha finito quando ricompare la riga dove puoi scrivere.

Possono comparire scritte gialle (`warn`) o righe che iniziano con `npm notice`: è normale. **Ignora** gli inviti a eseguire `npm install -g npm` o `npm audit fix`: non servono.

### Passo 6: crea l'icona sulla Scrivania

```
npm run collegamento
```

Sulla Scrivania compare il file **Avvia Agenti**. Se il Mac chiede il permesso di accedere alla Scrivania, clicca **Consenti**.

### Passo 7: avvia il programma

```
npm start
```

Si apre da solo il browser con l'ufficio 3D. Se non si apre, apri Safari o Chrome e vai su **http://localhost:3000**.

**Lascia aperta la finestra del Terminale** mentre usi il programma (puoi ridurla a icona). Se la chiudi, il programma si ferma.

### Passo 8: collega Claude (consigliato)

Senza chiave funzionano già l'ufficio 3D, gli agenti "a regole" (Quant SMA, Quant RSI, Risk Manager) e le approvazioni.
Per far ragionare gli agenti "LLM" e parlare con **Orion** serve una chiave di Claude:

1. Nell'app clicca il pulsante giallo **🔑 Collega Claude** (oppure **⚙️ Impostazioni** in basso a sinistra).
2. Apri **Come ottengo la chiave?** e segui i punti. In breve:
   - crea un account su **console.anthropic.com**;
   - in **Settings → Billing** aggiungi un po' di **credito** (senza credito gli agenti non funzionano);
   - in **Settings → API keys → Create key** dai un nome, scegli il workspace **Default** e come scadenza **Never**;
   - **copia subito** la chiave (inizia con `sk-ant-`): viene mostrata una sola volta.
3. Incollala nel campo e premi **Salva e verifica**. Se compare ✅ la chiave è giusta.

---

## Parte 2 — Le volte successive

1. **Doppio clic su "Avvia Agenti"** sulla Scrivania.
2. Si apre il Terminale e poi il browser con l'ufficio. Fatto!

Per **chiudere** il programma: clicca sulla finestra del Terminale e premi **control + C** (il tasto *control*, non ⌘), oppure chiudi la finestra e conferma **Termina**.

> Gli agenti programmati (es. "ogni 60 minuti") lavorano solo mentre il programma è aperto e il Mac è acceso, e solo nell'**orario di lavoro** scelto in ⚙️ Impostazioni (di partenza dal lunedì al venerdì, dalle 07:30 alle 22:30). Fuori orario non partono e non costano niente: il programma può restare aperto anche la notte e nel weekend.

**Far partire il programma all'accensione del Mac** (facoltativo):

1. Apri **Impostazioni di Sistema → Generali → Elementi login** (su alcune versioni si chiama «Elementi login ed estensioni»).
2. Sotto **«Apri al login»** premi **+**, scegli **Avvia Agenti** sulla Scrivania e premi **Apri**.
3. Gli agenti lavorano solo se il Mac resta sveglio: in **Impostazioni di Sistema → Batteria → Opzioni** (sui Mac fissi: **Energia**) attiva l'opzione che impedisce lo stop automatico quando il display è spento.

---

## Parte 3 — Primi passi nell'app

- **Il palazzo**: l'ufficio è un palazzo con più **piani**. Ogni piano si occupa di un settore (es. Azioni, Crypto) e ha le sue **stanze** con gli agenti. Con l'**ascensore** a sinistra scegli quale piano guardare, oppure **Tutto il palazzo**. Il nome e lo stato di un agente compaiono quando passi il mouse sopra di lui.
- **Prova un agente**: clicca la scrivania del **Quant SMA** → **▶ Esegui**. Vedrai il fumetto sopra l'agente; il risultato finisce in **Bacheca**.
- **Parla con Orion** (con la chiave inserita): scrivi a destra, per esempio *"Cosa sta succedendo nel palazzo?"* oppure *"Crea un agente che segue le banche italiane"*.
- **Approvazioni**: quando un agente vuole comprare o vendere, compare un pallino rosso. Tu scegli **Fallo per me** o **Scarta**.
- **All'inizio è tutto simulato**: il portafoglio parte con 100.000 € finti e nessun ordine va in borsa davvero. Per usare i prezzi e un conto del tuo broker vedi la **Parte 4**.

### Creare piani, stanze e farli comunicare

Puoi farlo in due modi.

**Parlando con Orion**, per esempio:
- *"Crea un piano Crypto con una stanza Bitcoin e una stanza DeFi, e mettici un analista in ognuna"*
- *"Collega il piano Crypto alla Direzione"* (si scambiano le informazioni nei due sensi)
- *"Fai arrivare le informazioni del piano Azioni al piano Crypto, ma non il contrario"* (collegamento in un solo senso)
- *"Scollega il piano Crypto"* oppure *"Spegni il collegamento tra Crypto e Azioni"*

**Dalla sezione 🏗️ Palazzo** (barra a sinistra):
- **+ Nuovo piano** per aggiungere un piano; **✏️ Modifica** per cambiargli nome, settore, colore o altezza;
- **+ Stanza** dentro un piano per aggiungere una stanza; clicca una stanza per modificarla o spostarla;
- in **Collegamenti tra piani** scegli i due piani e la direzione (**↔** nei due sensi, **→** in un solo senso) e premi **Collega**. Con l'interruttore **Attivo/Spento** li fai comunicare solo quando vuoi.

**Come comunicano**: gli agenti leggono sempre la propria stanza e le stanze del proprio piano che scegli nella loro scheda. Poi dipende dal collegamento:
- con **↔** i due piani si leggono a vicenda: gli agenti di ciascun piano leggono **tutte le bacheche** dell'altro;
- con **→** le informazioni vanno in un solo senso: solo il piano di arrivo legge le bacheche di quello di partenza. All'inizio, per esempio, la Direzione legge il piano Azioni, ma non il contrario;
- se il collegamento è **spento**, i due piani lavorano ciascuno per conto suo.

### Orario di lavoro, calendario economico e notizie

- **Orario di lavoro** (⚙️ Impostazioni → 🕒 Orario di lavoro degli agenti): scegli i giorni e le ore in cui gli agenti programmati lavorano (ora italiana) e premi **Salva orario**. Quando l'orario ricomincia, gli agenti programmati ripartono tutti, come quando apri il programma. Fuori orario nell'Ufficio vedi la scritta **⏸ Fuori orario**; Orion risponde comunque e con **▶** puoi far lavorare un agente a mano.
- **Chiusura del venerdì**: con la casella attiva, il venerdì dall'ora scelta (di partenza le 21:45) il programma chiude le posizioni aperte dagli agenti sui conti cTrader, così nessuna resta aperta nel weekend. Lo trovi scritto in **📜 Attività**.
- **Giorno e ora**: ogni agente, quando comincia un lavoro, sa che giorno della settimana è e che ora è in Italia. Anche Orion.
- **Calendario economico**: gli agenti con lo strumento **get_calendar** (si spunta nella scheda dell'agente, oppure lo chiedi a Orion) leggono da soli il calendario della settimana: orari italiani, importanza, previsioni e, appena esce, il dato uscito. Si aggiorna da solo da internet al massimo una volta all'ora. Puoi anche chiedere a Orion: *"Quali dati importanti escono oggi?"*
- **Notizie automatiche**: gli agenti con lo strumento **web_search** cercano da soli su internet le notizie (per esempio sull'oro) e le pubblicano in bacheca con il nome della fonte: non devi più incollarle tu. Anche Orion sa cercare: chiedigli *"Che notizie ci sono oggi sull'oro?"*. Ogni ricerca costa circa 1 centesimo: un agente che cerca le notizie ogni ora costa circa 7–8 € al mese.

### Quanto costa?

- Il programma è gratis. Gli agenti **a regole** sono gratis.
- Gli agenti **LLM** e la chat con Orion usano il credito di Claude: di solito da pochi centesimi a qualche decina di centesimi per ogni lavoro. La **spesa stimata** è sempre visibile in alto nell'ufficio.
- La **ricerca sul web** (strumento web_search) costa circa 1 centesimo in più per ogni ricerca, già compreso nella spesa stimata.
- Consiglio: nella console di Anthropic imposta un **limite di spesa mensile**.

---

## Parte 4 — Collegare il broker cTrader (conto demo)

Collegando il tuo conto **cTrader** (per esempio di FP Markets):
- gli agenti usano i **prezzi e i grafici del broker**, gli stessi a cui si fanno gli ordini (anche a 1 minuto, 5 minuti, 1 ora…);
- ogni **piano** può operare su un conto diverso: per esempio il piano Forex su un conto demo, il piano Azioni sul portafoglio simulato;
- il **conto reale resta bloccato** finché non lo sblocchi tu, e ci sono protezioni sempre attive (pulsante STOP, limiti, perdita massima del giorno).

Il collegamento è **gratuito**. Si fa una volta sola e richiede una ventina di minuti, più l'attesa dell'approvazione di cTrader.

### Passo A: apri un conto demo cTrader

1. Nell'area clienti di FP Markets apri un **conto demo** scegliendo la piattaforma **cTrader**.
2. Riceverai (o creerai) un **cTrader ID**: è l'email e la password con cui entri in cTrader.
3. Controlla di riuscire a entrare nel conto demo da [app.ctrader.com](https://app.ctrader.com).

> Se nell'area clienti vedi solo MetaTrader 4/5, chiedi al supporto di FP Markets di aprirti un conto **cTrader**: il programma funziona solo con cTrader.

### Passo B: registra il programma su cTrader (una volta sola)

1. **Trova il tuo cTrader ID**: è l'email (o il nome utente) e la password con cui entri **nell'app cTrader**, che può essere diversa dall'accesso all'area clienti di FP Markets. Entra in cTrader (es. [app.ctrader.com](https://app.ctrader.com)) e controlla che si veda il tuo conto **demo**. Se non ricordi la password puoi reimpostarla da [id-app.fpmarkets.com](https://id-app.fpmarkets.com/login) → *Forgot password?*.
2. Vai su [openapi.ctrader.com/apps](https://openapi.ctrader.com/apps) e accedi con il **cTrader ID**.
3. Premi **Add new app** e compila:
   - **Application name**: es. *Agenti borsa personale*;
   - **Description**: scrivi bene a cosa serve, così l'approvano prima. Per esempio: *Strumento personale, non commerciale, usato solo da me sul mio computer per leggere i prezzi e gestire il mio conto demo cTrader di FP Markets (in futuro il mio conto reale). Nessun altro utente.*
   - nei campi dell'azienda scrivi il tuo nome e cognome; il **Company website** lascialo **vuoto** (serve solo a chi crea app per altre persone, e cTrader può chiedere di dimostrare che il sito è tuo: non inventarlo);
   - in **Allow this application to** spunta **solo "Access your accounts and trade"** (i tuoi conti, con il trading). **Non** spuntare le voci *"Access any available account…"*: sono per chi lavora con conti di altre persone, e rendono obbligatorio il sito web.
4. **Redirect URIs**: la prima riga già presente (quella con *playground*) **lasciala com'è**. Premi **Add redirect URI** (o *+ Add redirect URL*) e incolla esattamente l'indirizzo che trovi nell'app, sezione 🔌 Broker → **Copia**: `http://localhost:3000/ctrader/callback` (senza spazi né barra finale). Se il modulo non ha questa voce, la aggiungi dopo con **Edit** (punto 7).
5. Premi **Save**. L'app compare nell'elenco con lo stato **Submitted** (inviata).
6. **Aspetta l'approvazione**: la fa a mano il personale di cTrader. Di solito servono **da 1 a 3 giorni lavorativi**. Ti arriva un'email all'indirizzo del cTrader ID (guarda anche nello spam): o conferma l'approvazione o chiede altre informazioni, e in quel caso rispondi. Quando è approvata lo stato diventa **Active**.
7. Quando è **Active**, premi **Edit** sulla riga della tua app e controlla che fra i **Redirect URIs** ci sia `http://localhost:3000/ctrader/callback`; se manca aggiungilo e premi **Save**.
8. Nella colonna **Credentials** premi **View**: copia **Client ID** (un numero, un trattino basso e lettere) e **Secret** nei due campi della sezione 🔌 Broker dell'app e premi **Salva**.

> Client ID e Secret si vedono anche prima dell'approvazione, ma **funzionano solo quando lo stato è Active**: prima, collegando, vedresti l'errore *"l'app cTrader non è ancora stata approvata"*.
> Il **Secret** è come una password: non mandarlo a nessuno e non metterlo in foto o chat.
> Crea **una sola app**: basta per tutti i conti.

### Passo C: collega il conto

1. Nel riquadro **2 · Collega il tuo conto** premi **🔗 Collega cTrader**.
2. Si apre la pagina di cTrader: entra con il tuo cTrader ID, lascia selezionati i conti e premi **Allow access**.
3. Torni nell'app da solo: vedrai **✔ Collegato** e l'elenco dei conti con l'etichetta **DEMO** o **REALE**.
4. Se in futuro apri un altro conto (es. il conto reale), premi **🔗 Ricollega** e spunta anche quello: i conti nuovi non vengono aggiunti da soli.

> Se dopo *Allow access* il browser mostra una pagina di errore, copia l'indirizzo **completo** dalla barra in alto (inizia con `http://localhost`) e incollalo in **La pagina finale dà errore o non torna all'app?** → **Conferma**. Fallo **entro un minuto**: il codice nell'indirizzo scade presto. Se è scaduto, premi di nuovo **Collega cTrader**.

### Passo D: scegli dove operano i piani

1. In **Conti**, nella colonna **Dati**, scegli il conto demo: da lì arrivano prezzi e grafici per tutti gli agenti.
2. In **Dove operano i piani** scegli, per ogni piano, **Portafoglio simulato** oppure il tuo conto **Demo**.
3. Nelle watchlist degli agenti usa i **nomi del broker** (es. `EURUSD`, `XAUUSD`, `US500`). Per trovarli usa la casella **Cerca uno strumento** (clicca un nome per copiarlo), oppure chiedi a Orion: *"Cambia la watchlist del Trader in EURUSD e XAUUSD"*.
4. Sui conti cTrader gli ordini si danno in **lotti** (es. 0,01) e hanno uno **stop loss**: se l'agente non lo indica, si usa quello predefinito di Sicurezza (2%). Lascia attiva l'opzione **Ogni ordine richiede la mia approvazione** finché non sei sicuro: gli ordini arrivano in **✅ Approvazioni** con l'etichetta *demo* o *CONTO REALE*.
5. Usa un conto di tipo **hedging** (quello normale di cTrader, più posizioni per strumento): sui conti *netting* gli agenti non possono operare, perché i loro ordini si mescolerebbero con i tuoi.

Puoi anche chiedere a Orion: *"Fai operare il piano Azioni sul conto demo"*. Orion può usare solo i conti demo.

### Le protezioni (sezione 🔌 Broker → 🛡️ Sicurezza)

- **⛔ STOP**: ferma subito tutti gli ordini degli agenti (e gli avvii automatici). Puoi anche chiudere in un colpo tutte le posizioni aperte dagli agenti. Si toglie con **Riattiva gli ordini**. Quando un piano usa cTrader, il pulsante STOP compare anche in alto nell'Ufficio.
- **Limiti**: lotti massimi per ordine, posizioni aperte massime, ordini massimi al giorno.
- **Perdita massima del giorno**: ogni minuto il programma controlla il valore dei conti usati dai piani (depositi e prelievi non contano); se la perdita del giorno supera il limite (3% di partenza), scatta lo STOP da solo. Anche se poi riattivi gli ordini, **su quel conto** gli agenti restano fermi fino al giorno dopo (il giorno cambia a mezzanotte UTC, cioè all'1 o alle 2 di notte in Italia), a meno che tu alzi il limite.
- **Posizioni aperte**: vedi tutte le posizioni, chi le ha aperte (un agente o tu) e puoi chiuderle con **Chiudi**, anche con lo STOP attivo. Gli agenti possono chiudere solo le posizioni aperte da loro.
- **Conto reale**: è **bloccato**. Si sblocca solo scrivendo **SOLDI VERI** e confermando. Fallo solo dopo aver provato a lungo il sistema sul demo, e inizia con lotti piccoli. Bloccandolo di nuovo, i piani collegati al conto reale tornano al portafoglio simulato.

> ⚠️ Gli agenti lavorano solo mentre il programma è aperto e il Mac è acceso. Le posizioni invece restano aperte sul broker anche a Mac spento: per questo lascia attiva l'opzione **Ogni ordine sul broker ha sempre uno stop loss** (è attiva di partenza). Il trading con leva (CFD, Forex) può farti perdere più velocemente di quanto pensi: questo programma non è una consulenza finanziaria.

---

## Se qualcosa non funziona

| Cosa vedi | Cosa fare |
|---|---|
| `command not found: node` o `npm` | Node.js non è installato, oppure il Terminale era già aperto durante l'installazione. Chiudi il Terminale (⌘ Cmd + Q), riaprilo e riprova. |
| `npm error … ENOENT … package.json` | Non sei nella cartella giusta: ripeti il **Passo 4**. |
| `operation not permitted` o `EPERM` | Il Mac ha negato un permesso al Terminale. Apri **Impostazioni di Sistema → Privacy e sicurezza → File e cartelle → Terminale**, attiva le cartelle (es. Scrivania), poi chiudi e riapri il Terminale e riprova. |
| Il browser dice *"Impossibile connettersi"* | Il programma non è acceso: doppio clic su **Avvia Agenti** (o `npm start`). |
| *"Il programma è già aperto"* | È già acceso: usa la pagina del browser che si apre. |
| Doppio clic su "Avvia Agenti" e il Mac lo blocca | Tasto destro sull'icona → **Apri** → **Apri**. Se non basta: Impostazioni di Sistema → Privacy e sicurezza → **Apri comunque**. |
| *"Cartella del programma non trovata"* | Hai spostato o rinominato la cartella: ripeti i Passi 3, 4 e 6. |
| Prezzi con l'asterisco o la scritta *demo* | Yahoo Finance non risponde: il programma usa prezzi simulati finché non torna disponibile. |
| *"Chiave non valida"* quando la salvi | Ricopia la chiave per intero (inizia con `sk-ant-`). Se non l'hai più, creane una nuova: viene mostrata una sola volta. |
| *"La chiave non funziona più (scaduta o disattivata)"* | Crea una nuova chiave in console.anthropic.com (scadenza **Never**) e incollala in ⚙️ Impostazioni. |
| *"Credito di Claude esaurito"* | In console.anthropic.com → **Settings → Billing** aggiungi credito. |
| *"Il tuo account Anthropic è sospeso"* (o *organization has been disabled*) | Il problema è nell'account Anthropic, non nel programma né nella chiave. Chiedi la riattivazione su **console.anthropic.com/appeal** o scrivi al supporto (**support.anthropic.com**). Nel frattempo gli agenti a regole funzionano lo stesso. |
| *"La ricerca web è disattivata sul tuo account Anthropic"* | Apri **platform.claude.com/settings/capabilities** (con lo stesso account della chiave), attiva **Web search** e riprova. Se non vedi l'interruttore, l'account non è tuo: chiedi a chi lo amministra. |
| *"Questa chiave va creata per un solo workspace"* | Crea una nuova chiave scegliendo il workspace **Default** e incollala in ⚙️ Impostazioni. |
| cTrader: *"cTrader ha rifiutato l'accesso"* subito dopo *Allow access* o dopo aver incollato l'indirizzo | Il codice di accesso vale circa un minuto e una sola volta: premi di nuovo **Collega cTrader** e completa l'accesso senza aspettare. Se succede ancora, ricopia **Client ID** e **Secret** da openapi.ctrader.com (pulsante Credentials), premi Salva e riprova. |
| La pagina di cTrader parla di *redirect URI* | In openapi.ctrader.com, nella tua app, la voce **Redirect URIs** deve contenere esattamente l'indirizzo mostrato nella sezione Broker (premi **Copia**). Se avvii il programma su un'altra porta (es. 3001) l'indirizzo cambia. |
| *"Hai concesso solo la lettura"* | In 🔌 Broker premi **🔗 Ricollega** e nella pagina di cTrader concedi l'accesso completo (trading). |
| *"STOP attivo"* | Hai premuto STOP, oppure la perdita del giorno ha superato il limite. Controlla in 🔌 Broker e, se va bene, premi **Riattiva gli ordini**. Se lo STOP era per la perdita del giorno, su quel conto gli agenti restano fermi fino al giorno dopo (vedi il riquadro **Oggi**). |
| *"oggi la perdita ha raggiunto…"* | È il limite di perdita del giorno: su quel conto gli ordini ripartono il giorno dopo (00:00 UTC), oppure subito se alzi la **Perdita massima del giorno** in Sicurezza. |
| *"gli agenti possono operare solo su conti HEDGED"* | Il conto è di tipo netting. Apri (o chiedi al broker) un conto cTrader di tipo **hedging** e collega quello al piano. |
| *"Relative stop loss has invalid precision"* o *"stop loss non validi"* | Aggiorna il programma (🔄): le versioni nuove arrotondano lo stop loss ai decimali dello strumento. |
| *"Il conto REALE è bloccato"* | È voluto: il conto reale si sblocca solo da 🔌 Broker → Sicurezza scrivendo SOLDI VERI. |
| Una pagina diversa su localhost:3000 | Un altro programma usa la stessa porta. Nel Terminale, dentro la cartella, avvia con: `PORT=3001 npm start` e apri http://localhost:3001 |

## Aggiornare il programma

**Con il pulsante (dalla versione con il palazzo in poi):**

1. Quando c'è una novità compare il pulsante verde **🔄 Nuova versione** in alto. Puoi anche controllare tu da **⚙️ Impostazioni → Aggiornamenti → Controlla**.
2. Premi **Aggiorna ora** e conferma. Il programma scarica la nuova versione, si riavvia da solo e ricarica la pagina.
3. Il tuo palazzo, gli agenti, il portafoglio e la chiave **restano come sono**: stanno nella cartella `data`, che l'aggiornamento non tocca. Una copia dei file vecchi viene salvata in `data/backup`.

**A mano (serve solo se la tua versione non ha ancora il pulsante "Aggiorna"):**

1. **Chiudi il programma** (control + C nel Terminale, oppure chiudi la finestra → Termina).
2. Scarica di nuovo lo ZIP (Passo 2) e chiama la nuova cartella `agenti-borsa-nuovo`.
3. Dalla vecchia cartella copia nella nuova:
   - la cartella **`data`** (contiene portafoglio, bacheche e chiave);
   - la cartella **`agents`** (contiene i tuoi agenti, anche quelli creati da Orion);
   - il file **`rooms.json`**.

   Copiali **prima** di avviare la versione nuova. Al primo avvio il programma li importa da solo: trovi tutte le tue stanze su un unico piano, **Piano Borsa**, e gli agenti leggono le stesse stanze di prima. Da lì puoi aggiungere altri piani.
4. Rinomina le cartelle in modo che quella nuova si chiami `agenti-borsa` (la vecchia puoi chiamarla `agenti-borsa-vecchio` e cancellarla quando tutto funziona), poi ripeti i Passi 3, 4 e 5 e avvia con l'icona **Avvia Agenti**.
