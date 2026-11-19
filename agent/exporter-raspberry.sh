#!/usr/bin/env bash
# Sur ton PC (Git Bash) : prépare UNE archive avec tout ce que l'agent doit avoir sur la Raspberry.
#   bash agent/exporter-raspberry.sh
# Contenu : l'agent, sa config et ses clés, le protocole commun, le code de la librairie client_printer.
# Pas copiés : les gcodes (re-téléchargés depuis l'imprimante), l'index local (chemins Windows), les .venv.
# /!\ L'archive contient les clés de l'agent : supprime-la une fois copiée.
set -euo pipefail
PROJET="$(cd "$(dirname "$0")/.." && pwd)"
SORTIE="$PROJET/agent-raspberry.tar.gz"
cd "$PROJET"

for f in agent/config.json agent/secrets/ca.crt.pem agent/secrets/agent.crt.pem agent/secrets/agent.key.pem \
         agent/secrets/agent_ed25519.pem agent/secrets/empreinte_serveur.txt; do
  [ -f "$f" ] || { echo "manquant : $f"; exit 1; }
done

tar czf "$SORTIE" \
  agent/agent.py agent/actions.py agent/protocole.py agent/requirements.txt agent/README.md \
  agent/config.json agent/installer-raspberry.sh agent/secrets \
  protocole/commandes.json \
  client_printer/*.py client_printer/requirements.txt

echo "Archive prête : $SORTIE ($(du -h "$SORTIE" | cut -f1))"
echo "Copie-la sur la Raspberry, par exemple :"
echo "  scp agent-raspberry.tar.gz pi@raspberrypi.local:~"
echo "Puis supprime-la ici : elle contient les clés de l'agent."
