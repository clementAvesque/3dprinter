# Image du serveur en ligne (API + WebSocket agent + site client + OrcaSlicer) pour Fly.io.
# Construite depuis la racine du projet : elle a besoin de serveur/, protocole/ et web_printer_user/front/.
# Aucun secret dedans : certificats et clé de l'agent arrivent par "fly secrets" (voir serveur/README.md).

# 1. site client (Vue) compilé : seul le dossier dist/ passe dans l'image finale
FROM node:22-slim AS front
WORKDIR /front
COPY web_printer_user/front/package.json web_printer_user/front/package-lock.json ./
RUN npm ci && npm cache clean --force
COPY web_printer_user/front/index.html web_printer_user/front/vite.config.js ./
COPY web_printer_user/front/public ./public
COPY web_printer_user/front/src ./src
RUN npm run build

# 2. dépendances du serveur
FROM node:22-slim AS deps
WORKDIR /app/serveur
COPY serveur/package.json serveur/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 3. OrcaSlicer : AppImage officielle (github.com/OrcaSlicer), empreinte SHA-256 vérifiée, puis extraite
#    (pas besoin de FUSE). Version épinglée : pour la changer, mettre à jour les deux lignes ensemble.
FROM ubuntu:24.04 AS orca
ARG ORCA_VERSION=2.5.1
ARG ORCA_SHA256=073b8105c928356141db0ddbce88b81d52c7a9e2442f9baae0a9089c89ff04eb
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp
RUN curl -fsSL -o orca.AppImage \
      "https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage" \
 && echo "${ORCA_SHA256}  orca.AppImage" | sha256sum -c - \
 && chmod +x orca.AppImage \
 && ./orca.AppImage --appimage-extract > /dev/null \
 && mv squashfs-root /opt/orca \
 && rm orca.AppImage \
 && chmod -R a+rX /opt/orca
# a+rX : l'archive extraite n'est lisible que par root, or le serveur tourne sous l'utilisateur « node »

# 4. image finale : Ubuntu 24.04 (celle pour laquelle Orca est compilé) + Node 22
FROM ubuntu:24.04
ENV NODE_ENV=production DEBIAN_FRONTEND=noninteractive
# bibliothèques dont Orca a besoin (GTK, OpenGL logiciel) ; xvfb : écran virtuel, Orca n'a pas d'écran ici
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates xvfb xauth \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 libgl1 libegl1 libglu1-mesa libgl1-mesa-dri libosmesa6 \
      libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libsecret-1-0 libfontconfig1 libdbus-1-3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --home-dir /home/node --shell /usr/sbin/nologin node
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=orca /opt/orca /opt/orca
ENV ORCA_CMD="xvfb-run -a /opt/orca/AppRun"

WORKDIR /app/serveur
COPY --from=deps /app/serveur/node_modules ./node_modules
COPY serveur/package.json ./
COPY protocole /app/protocole
COPY serveur/src ./src
COPY serveur/scripts ./scripts
COPY serveur/orca ./orca
COPY --from=front /front/dist /app/web_printer_user/front/dist
COPY serveur/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

# essai de découpe avec le vrai Orca et les vrais profils, sous l'utilisateur « node » comme le serveur :
# s'il échoue, l'image n'est pas construite (le serveur en ligne garde sa version précédente)
RUN setpriv --reuid=node --regid=node --init-groups \
      node --disable-warning=ExperimentalWarning scripts/essai-orca.js

EXPOSE 3000 8443
# démarre en root le temps de donner le volume /data à l'utilisateur "node", puis tourne en "node"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
