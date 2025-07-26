# # 1. Partir d'une image Node.js avec un système d'exploitation complet
# FROM node:18-bullseye

# # 2. Installer les dépendances : FFmpeg, PulseAudio, et autres utilitaires
# RUN apt-get update && apt-get install -y \
#     ffmpeg \
#     pulseaudio \
#     --no-install-recommends \
#     && rm -rf /var/lib/apt/lists/*

# # 3. Copier votre application Node.js
# WORKDIR /usr/src/app
# COPY package*.json ./
# RUN npm install
# COPY . .

# # 4. Configurer PulseAudio pour qu'il fonctionne pour tous les utilisateurs
# # et charge le module pour créer un "null sink" (périphérique de sortie virtuel)
# RUN echo "system-instance=yes" >> /etc/pulse/daemon.conf
# RUN echo "load-module module-null-sink sink_name=VirtualOutput" >> /etc/pulse/client.conf
# RUN echo "set-default-sink VirtualOutput" >> /etc/pulse/client.conf

# # 5. Lancer PulseAudio et votre application Node.js au démarrage
# # Votre script Node.js lancera alors FFmpeg pour enregistrer depuis "VirtualOutput.monitor"
# CMD pulseaudio --start && node index2.js


# Étape 1: Utiliser une image de base Node.js
FROM node:18-bullseye

# Installer les dépendances système (Puppeteer, FFmpeg, PulseAudio)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    ffmpeg \
    pulseaudio \
    dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

# --- NOUVELLE ÉTAPE : TÉLÉCHARGER ET INSTALLER GOOGLE CHROME ---
# Ceci résout l'erreur "Browser was not found".
RUN wget -q -O google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y ./google-chrome-stable_current_amd64.deb \
    && rm google-chrome-stable_current_amd64.deb

# Définir le répertoire de travail
WORKDIR /usr/src/app

# Copier les fichiers de dépendances et installer les paquets npm
COPY package*.json ./
RUN npm install

# Copier le reste du code de l'application, y compris le script d'entrée
COPY . .

# Rendre le script d'entrée exécutable
RUN chmod +x ./entrypoint.sh

# # Changer l'utilisateur pour 'node' (un utilisateur non-root fourni par l'image de base)
# USER node

# # Copier le reste du code de l'application en tant qu'utilisateur 'node'
# COPY --chown=node:node . .

# Exposer le port que le serveur utilise
EXPOSE 3000

ENTRYPOINT ["./entrypoint.sh"]
# # La commande pour démarrer l'application.
# CMD ["/bin/sh", "-c", "mkdir -p ~/.config/pulse && echo 'load-module module-null-sink sink_name=virtual_sink' > ~/.config/pulse/default.pa && pulseaudio --start --exit-idle-time=-1 && exec node server3.js"]

# CMD ["/bin/sh", "-c", "mkdir -p ~/.config/pulse && echo 'load-module module-null-sink sink_name=virtual_sink' > ~/.config/pulse/default.pa && pulseaudio --start --exit-idle-time=-1 && sleep 2 && exec node server3.js"]


# CMD ["/bin/sh", "-c", "mkdir -p ~/.config/pulse && echo 'load-module module-null-sink sink_name=virtual_sink' > ~/.config/pulse/default.pa && pulseaudio --start --exit-idle-time=-1 && until pactl info; do echo 'Waiting for PulseAudio to start...'; sleep 1; done && echo 'PulseAudio is ready.' && exec node server3.js"]
