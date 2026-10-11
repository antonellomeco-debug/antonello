# 🍎 Come avviare il programma sul Mac (guida per principianti)

Non serve saper programmare. Ti servono solo il Mac e una connessione internet.
La prima volta ci vogliono circa 10 minuti; dalla seconda volta basta un doppio clic.

> Il **Terminale** è una finestra in cui si scrivono dei comandi. Ogni volta che in questa guida trovi un comando in un riquadro grigio, **scrivilo (o copialo e incollalo) nel Terminale e poi premi Invio**.

---

## Parte 1 — La prima volta

### Passo 1: installa Node.js (il "motore" che fa girare il programma)

1. Apri **https://nodejs.org**.
2. Clicca il pulsante grande con scritto **LTS** e scarica il file per **macOS** (si chiama tipo `node-v….pkg`).
3. Apri il file scaricato (lo trovi nella cartella **Download**) e segui l'installazione: **Continua → Accetta → Installa**. Il Mac ti chiederà la password del computer: è normale.

### Passo 2: scarica il programma

1. Apri **https://github.com/antonellomeco-debug/antonello** ed entra con il tuo account GitHub.
2. Clicca il pulsante verde **Code** → **Download ZIP**.
3. Vai nella cartella **Download** e fai doppio clic sul file ZIP: si crea una cartella che si chiama tipo `antonello-claude-sharp-mccarthy-231pjj`.
4. **Rinominala** in `agenti-borsa` (clic sul nome, aspetta un secondo, riscrivi) e **trascinala dentro Documenti**.

### Passo 3: apri il Terminale

Premi **⌘ Cmd + Spazio**, scrivi **Terminale** e premi **Invio**. Si apre una finestra con del testo.

Controlla che Node.js sia installato scrivendo:

```
node -v
```

Deve comparire un numero tipo `v22.11.0` o `v24.1.0`. Se compare `command not found`, chiudi il Terminale (⌘ Cmd + Q), riaprilo e riprova. Se ancora non va, ripeti il Passo 1.

### Passo 4: entra nella cartella del programma

1. Nel Terminale scrivi **`cd`** seguito da **uno spazio** (non premere ancora Invio).
2. Apri il Finder, vai in **Documenti** e **trascina la cartella `agenti-borsa` dentro la finestra del Terminale**: il percorso si scrive da solo.
3. Premi **Invio**.

Se il Mac chiede *"Terminale vorrebbe accedere ai file nella cartella Documenti"*, clicca **Consenti** (o **OK**).

### Passo 5: installa i componenti (solo la prima volta)

```
npm install
```

Aspetta 1–2 minuti. Possono comparire scritte gialle con `warn`: è normale. Ha finito quando ricompare la riga dove puoi scrivere.

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
2. Apri **Come ottengo la chiave?** e segui i 4 punti: crei un account su console.anthropic.com, aggiungi un po' di credito, crei una chiave (inizia con `sk-ant-`) e la copi.
3. Incollala nel campo e premi **Salva e verifica**. Se compare ✅ hai finito.

---

## Parte 2 — Le volte successive

1. **Doppio clic su "Avvia Agenti"** sulla Scrivania.
2. Si apre il Terminale e poi il browser con l'ufficio. Fatto!

Per **chiudere**: nella finestra del Terminale premi **Ctrl + C**, oppure chiudi la finestra.

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
| Il browser dice *"Impossibile connettersi"* | Il programma non è acceso: doppio clic su **Avvia Agenti** (o `npm start`). |
| *"Il programma è già aperto"* | È già acceso: usa la pagina del browser che si apre. |
| Doppio clic su "Avvia Agenti" e il Mac lo blocca | Tasto destro sull'icona → **Apri** → **Apri**. Se non basta: Impostazioni di Sistema → Privacy e sicurezza → **Apri comunque**. |
| *"Cartella del programma non trovata"* | Hai spostato o rinominato la cartella: ripeti i Passi 3, 4 e 6. |
| Prezzi con l'asterisco o la scritta *demo* | Yahoo Finance non risponde: il programma usa prezzi simulati finché non torna disponibile. |
| *"Chiave non valida"* | Ricopia la chiave per intero dalla console di Anthropic (inizia con `sk-ant-`). |
| Una pagina diversa su localhost:3000 | Un altro programma usa la stessa porta. Nel Terminale, dentro la cartella, avvia con: `PORT=3001 npm start` |

## Aggiornare il programma in futuro

Quando ci saranno nuove versioni:

1. Scarica di nuovo lo ZIP (Passo 2) e chiama la nuova cartella `agenti-borsa-nuovo`.
2. Dalla vecchia cartella copia nella nuova la cartella **`data`** (contiene portafoglio, bacheche e chiave). Se hai creato o modificato agenti, copia anche i loro file dalla cartella **`agents`**.
3. Rinomina le cartelle in modo che quella nuova si chiami `agenti-borsa`, poi ripeti i Passi 3, 4, 5 e 6.
