#!/usr/bin/env bash
# Sur la Raspberry : installe l'agent et le fait démarrer TOUT SEUL à chaque allumage (service systemd).
#   mkdir -p ~/imprimantes && tar xzf agent-raspberry.tar.gz -C ~/imprimantes
#   bash ~/imprimantes/agent/installer-raspberry.sh
# À lancer avec ton utilisateur normal (pas avec sudo) : le script demande sudo quand il en a besoin.
# Relancer le script plus tard (mise à jour du code) ne casse rien.
set -euo pipefail
AGENT="$(cd "$(dirname "$0")" && pwd)"
PROJET="$(dirname "$AGENT")"
UTILISATEUR="$(id -un)"
if [ "$UTILISATEUR" = root ]; then
  echo "Lance ce script avec ton utilisateur normal, sans sudo : le service tournera avec lui, pas en root."
  exit 1
fi
for f in config.json secrets/ca.crt.pem secrets/agent.crt.pem secrets/agent.key.pem secrets/agent_ed25519.pem; do
  [ -f "$AGENT/$f" ] || { echo "manquant : $AGENT/$f (copie l'archive faite par exporter-raspberry.sh)"; exit 1; }
done

echo "1/5 paquets système (Python, ffmpeg pour les vidéos)"
sudo apt-get update -qq
sudo apt-get install -y -qq python3-venv python3-pip ffmpeg

echo "2/5 environnement Python ($PROJET/.venv)"
python3 -m venv "$PROJET/.venv"
"$PROJET/.venv/bin/pip" install -q --upgrade pip
"$PROJET/.venv/bin/pip" install -q -r "$AGENT/requirements.txt"

echo "3/5 clés lisibles par toi seul"
chmod 700 "$AGENT/secrets"
chmod 600 "$AGENT"/secrets/*

echo "4/5 heure exacte avant de démarrer (la Raspberry n'a pas d'horloge ; l'agent refuse plus de 30 s d'écart)"
sudo systemctl enable --now systemd-timesyncd >/dev/null 2>&1 || true
sudo systemctl enable systemd-time-wait-sync >/dev/null 2>&1 || true

echo "5/5 service de démarrage automatique"
sudo tee /etc/systemd/system/imprimantes-agent.service >/dev/null <<EOF
[Unit]
Description=Agent imprimantes : relie les imprimantes au serveur en ligne
Wants=network-online.target time-sync.target
After=network-online.target time-sync.target

[Service]
Type=simple
User=$UTILISATEUR
WorkingDirectory=$PROJET
ExecStart=$PROJET/.venv/bin/python $AGENT/agent.py
Environment=PYTHONUNBUFFERED=1
Environment=IMAGEIO_FFMPEG_EXE=/usr/bin/ffmpeg
Restart=always
RestartSec=10
# durcissement : pas de nouveaux privilèges, système en lecture seule, écriture seulement dans le projet
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$PROJET

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable imprimantes-agent >/dev/null
sudo systemctl restart imprimantes-agent

sleep 6
systemctl --no-pager --lines=6 status imprimantes-agent || true
echo
echo "C'est installé : l'agent démarre tout seul à chaque allumage et redémarre s'il s'arrête."
echo "  journal en direct : journalctl -u imprimantes-agent -f"
echo "  redémarrer        : sudo systemctl restart imprimantes-agent"
echo "  arrêter           : sudo systemctl stop imprimantes-agent"
