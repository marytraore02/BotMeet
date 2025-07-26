#!/bin/sh
# Ce script s'assure que D-Bus et PulseAudio sont correctement configurés et lancés
# avant de démarrer l'application Node.js.
set -e

# --- Exécuté en tant que root ---
echo "Configuration des répertoires d'exécution en tant que root..."
# Crée le répertoire d'exécution nécessaire pour l'utilisateur 'node' (UID 1000)
mkdir -p /var/run/user/1000
chown -R node:node /var/run/user/1000

# --- Passage à l'utilisateur 'node' ---
# Utilise 'su' pour changer d'utilisateur et exécuter le reste du script
echo "Passage à l'utilisateur 'node' pour lancer les services..."
exec su -s /bin/sh -c '
  # Définir la variable d''environnement essentielle pour D-Bus et PulseAudio
  export XDG_RUNTIME_DIR=/var/run/user/1000
  
  # Démarrer une session D-Bus. C''est l''étape clé qui manquait.
  echo "Démarrage de la session D-Bus..."
  eval $(dbus-launch --sh-syntax)
  
  # Démarrer le serveur PulseAudio, qui va maintenant trouver la session D-Bus.
  # L''option -D le lance en arrière-plan (daemonize).
  echo "Démarrage de PulseAudio..."
  pulseaudio -D --exit-idle-time=-1
  
  # Attendre que le serveur PulseAudio soit réellement prêt à accepter des connexions.
  until pactl info > /dev/null 2>&1; do
    echo "En attente de PulseAudio..."
    sleep 1
  done
  echo "PulseAudio est prêt."
  
  # Maintenant que le serveur tourne, on charge notre carte son virtuelle.
  pactl load-module module-null-sink sink_name=virtual_sink
  
  # Lancer l''application principale
  echo "Démarrage du serveur Node.js."
  exec node server3.js
' node
