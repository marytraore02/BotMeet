#!/bin/bash

# Démarre le serveur de son PulseAudio en arrière-plan
# --exit-idle-time=-1 garde le démon actif indéfiniment
pulseaudio --start --exit-idle-time=-1

# Démarre le serveur d'affichage virtuel Xvfb en arrière-plan
# sur l'écran :99 avec une résolution de 1920x1080
Xvfb :99 -ac -screen 0 1920x1080x24 &

# Exporte la variable d'environnement DISPLAY pour que Chrome sache quel écran utiliser
export DISPLAY=:99

# Exécute la commande passée au conteneur (notre script Node.js)
# "$@" permet de passer tous les arguments
exec "$@"