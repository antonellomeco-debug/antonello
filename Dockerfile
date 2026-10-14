# Immagine del programma per il server in cloud (Railway). Sul Mac non serve: lì si usa "npm start".
FROM node:22-slim

WORKDIR /app

# - HOST=0.0.0.0: raggiungibile dal proxy di Railway (l'app parte solo con APP_PASSWORD, vedi lib/env.js).
# - UPDATER=off: le nuove versioni arrivano con un nuovo deploy da GitHub, non dal pulsante 🔄 Aggiorna.
# - TRUST_PROXY=1: davanti al container c'è un solo proxy, quello di Railway, che imposta X-Forwarded-For,
#   -Proto e -Host. Railway non pubblica gli indirizzi dei suoi proxy e non documenta un numero di "salti":
#   nei forum il personale dice che il proxy sovrascrive X-Forwarded-For, altri utenti lo vedono aggiungere
#   l'indirizzo in fondo. Con 1 Express usa l'ultimo indirizzo della lista, quello scritto dal proxy di
#   Railway: va bene in entrambi i casi e nessuno lo può falsificare. Mai "true" (Express crederebbe al primo
#   indirizzo, che chiunque può inventare). Se l'immagine gira senza un proxy davanti: TRUST_PROXY=0.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    OPEN_BROWSER=0 \
    UPDATER=off \
    TRUST_PROXY=1

# bzip2: serve a "tar" per estrarre il riconoscimento della voce dei messaggi vocali, che si scarica nel volume
# alla prima richiesta (lib/voice.js).
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 && rm -rf /var/lib/apt/lists/*

# Prima solo le librerie (cambiano di rado: Docker riusa questo passaggio), poi il programma.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .

# I dati (palazzo, agenti, chiavi, token di cTrader) vanno nel volume del servizio: Railway imposta da sola
# RAILWAY_VOLUME_MOUNT_PATH quando il volume è collegato (es. montato su /data), oppure si indica
# AGENTI_DATA_DIR. Senza volume si perdono a ogni nuova versione (l'app lo segnala).
#
# Utente: il programma gira come root. I volumi di Railway sono montati come root e la documentazione dice
# che con un utente diverso (es. "node") non si può scrivere nel volume se non rimettendo root con
# RAILWAY_RUN_UID=0: per non rischiare di perdere i dati si resta root dentro il container.
EXPOSE 3000

# Railway ignora HEALTHCHECK (usa /healthz impostato nel servizio): serve per altri host Docker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# start.js (non "npm start"): riceve SIGTERM, lo passa al server per una chiusura ordinata e lo fa
# ripartire dopo l'importazione di una copia dei dati (codice d'uscita 75).
CMD ["node", "start.js"]
