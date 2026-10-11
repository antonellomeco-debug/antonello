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

> Gli agenti programmati (es. "ogni 60 minuti") lavorano solo mentre il programma è aperto e il Mac è acceso.

---

## Parte 3 — Primi passi nell'app

- **Prova un agente**: clicca la scrivania del **Quant SMA** → **▶ Esegui**. Vedrai il fumetto sopra l'agente; il risultato finisce in **Bacheca**.
- **Parla con Orion** (con la chiave inserita): scrivi a destra, per esempio *"Cosa sta succedendo in ufficio?"* oppure *"Crea un agente che segue le banche italiane"*.
- **Approvazioni**: quando un agente vuole comprare o vendere, compare un pallino rosso. Tu scegli **Fallo per me** o **Scarta**.
- **È tutto simulato**: il portafoglio parte con 100.000 € finti e nessun ordine va in borsa davvero.

### Quanto costa?

- Il programma è gratis. Gli agenti **a regole** sono gratis.
- Gli agenti **LLM** e la chat con Orion usano il credito di Claude: di solito da pochi centesimi a qualche decina di centesimi per ogni lavoro. La **spesa stimata** è sempre visibile in alto nell'ufficio.
- Consiglio: nella console di Anthropic imposta un **limite di spesa mensile**.

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
| *"Questa chiave va creata per un solo workspace"* | Crea una nuova chiave scegliendo il workspace **Default** e incollala in ⚙️ Impostazioni. |
| Una pagina diversa su localhost:3000 | Un altro programma usa la stessa porta. Nel Terminale, dentro la cartella, avvia con: `PORT=3001 npm start` e apri http://localhost:3001 |

## Aggiornare il programma in futuro

Quando ci saranno nuove versioni:

1. **Chiudi il programma** (control + C nel Terminale, oppure chiudi la finestra → Termina).
2. Scarica di nuovo lo ZIP (Passo 2) e chiama la nuova cartella `agenti-borsa-nuovo`.
3. Dalla vecchia cartella copia nella nuova la cartella **`data`** (contiene portafoglio, bacheche e chiave). Se hai creato o modificato agenti, copia anche i loro file dalla cartella **`agents`**.
4. Rinomina le cartelle in modo che quella nuova si chiami `agenti-borsa`, poi ripeti i Passi 3, 4, 5 e 6.
