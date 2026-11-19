#!/bin/sh
# Point d'entrée du conteneur : le volume Fly (/data) est monté appartenant à root.
# On le donne à l'utilisateur "node", puis le serveur tourne SANS les droits root.
set -e
DONNEES="${DONNEES:-/data}"
mkdir -p "$DONNEES"
chown -R node:node "$DONNEES"
exec setpriv --reuid=node --regid=node --init-groups "$@"
