"""Agent local : relie tes imprimantes au serveur en ligne, par UNE connexion sortante WebSocket sécurisée.

    python agent/agent.py --generer-cle     crée la clé de signature Ed25519 de l'agent (une fois)
    python agent/agent.py                   se connecte au serveur et attend ses commandes

Sécurité côté agent :
  - TLS 1.3, autorité privée, certificat client (mTLS) et empreinte du certificat serveur épinglée
  - preuve d'identité : signature Ed25519 du défi du serveur, liée au certificat du serveur
  - chaque message vérifié : version, séquence, horodatage, identifiant unique, champs connus
  - seules les commandes de protocole/commandes.json sont exécutées, paramètres revalidés ici
  - aucune commande système ; console gcode désactivée par défaut (config.json)
"""

import argparse
import asyncio
import base64
import hashlib
import json
import logging
import os
import secrets
import shutil
import ssl
import sys
import time

import websockets
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from protocole import COMMANDES, LIMITES, valider

ICI = os.path.dirname(os.path.abspath(__file__))
ID_RE_MAX = 40
JSON_INLINE_MAX = 48_000           # au-delà, un résultat part en transfert (morceaux)
log = logging.getLogger("agent")


class Violation(Exception):
    """Message du serveur non conforme : la connexion est coupée."""


def chemin(c):
    return c if os.path.isabs(c) else os.path.join(ICI, c)


def nouvel_id():
    return secrets.token_urlsafe(12)


# ---------------------------------------------------------------------------- clé de signature

def generer_cle(config):
    prive = chemin(config["cle_signature"])
    public = prive.replace(".pem", ".pub.pem")
    if os.path.exists(prive):
        sys.exit(f"{prive} existe déjà (supprime-le d'abord pour en créer une nouvelle)")
    os.makedirs(os.path.dirname(prive), exist_ok=True)
    cle = Ed25519PrivateKey.generate()
    fd = os.open(prive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(cle.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                  serialization.NoEncryption()))
    with open(public, "wb") as f:
        f.write(cle.public_key().public_bytes(serialization.Encoding.PEM,
                                              serialization.PublicFormat.SubjectPublicKeyInfo))
    print(f"Clé privée : {prive} (ne quitte jamais ce PC)")
    print(f"Clé publique à enrôler sur le serveur : {public}")


# ---------------------------------------------------------------------------- connexion

class Session:
    def __init__(self, ws, config, machines, empreinte_serveur):
        self.ws = ws
        self.config = config
        self.machines = machines
        self.empreinte = empreinte_serveur
        self.seq_out = 0
        self.seq_in = 0
        self.vus = {}
        self.envoi = asyncio.Lock()      # séquence + envoi atomiques : l'ordre reçu = l'ordre numéroté
        self.uploads = {}                # transferts reçus du serveur (gcodes)
        self.taches = set()

    # -------------------------------------------------------- envoi

    def _enveloppe(self, msg):
        self.seq_out += 1
        return {"v": 1, "id": nouvel_id(), "seq": self.seq_out, "ts": int(time.time() * 1000), **msg}

    async def envoyer(self, msg):
        async with self.envoi:
            await self.ws.send(json.dumps(self._enveloppe(msg), separators=(",", ":")))

    async def envoyer_binaire(self, entete, octets):
        async with self.envoi:
            e = json.dumps(self._enveloppe(entete), separators=(",", ":")).encode()
            await self.ws.send(len(e).to_bytes(4, "big") + e + octets)

    async def transferer(self, re, ok_resultat, octets=None, chemin_fichier=None, mime="application/octet-stream"):
        """Réponse + fichier en morceaux de 1 Mo, avec taille et SHA-256 annoncées d'avance."""
        if chemin_fichier:
            taille = os.path.getsize(chemin_fichier)
            h = hashlib.sha256()
            with open(chemin_fichier, "rb") as f:
                for bloc in iter(lambda: f.read(1 << 20), b""):
                    h.update(bloc)
            empreinte = h.hexdigest()
        else:
            taille, empreinte = len(octets), hashlib.sha256(octets).hexdigest()
        tid = nouvel_id()
        await self.envoyer({"type": "reponse", "re": re, "ok": True, "resultat": ok_resultat,
                            "transfert": {"id": tid, "taille": taille, "sha256": empreinte, "mime": mime}})
        if taille == 0:
            return
        morceau = LIMITES["morceau_octets"]
        index = 0
        if chemin_fichier:
            with open(chemin_fichier, "rb") as f:
                envoye = 0
                for bloc in iter(lambda: f.read(morceau), b""):
                    envoye += len(bloc)
                    await self.envoyer_binaire({"type": "morceau", "transfert": tid, "index": index,
                                                "fin": envoye >= taille}, bloc)
                    index += 1
        else:
            for debut in range(0, taille, morceau):
                await self.envoyer_binaire({"type": "morceau", "transfert": tid, "index": index,
                                            "fin": debut + morceau >= taille}, octets[debut:debut + morceau])
                index += 1

    # -------------------------------------------------------- réception

    def verifier(self, env, autorises):
        if not isinstance(env, dict) or env.get("v") != 1:
            raise Violation("version invalide")
        mid = env.get("id")
        if not isinstance(mid, str) or not 8 <= len(mid) <= ID_RE_MAX or not all(c.isalnum() or c in "-_" for c in mid):
            raise Violation("identifiant invalide")
        if env.get("seq") != self.seq_in + 1 or isinstance(env.get("seq"), bool):
            raise Violation(f"séquence {env.get('seq')} au lieu de {self.seq_in + 1}")
        ts = env.get("ts")
        if not isinstance(ts, (int, float)) or abs(time.time() * 1000 - ts) > LIMITES["horloge_tolerance_ms"]:
            raise Violation("horodatage hors tolérance (horloge du PC à l'heure ?)")
        if mid in self.vus:
            raise Violation("message rejoué")
        for k in env:
            if k not in ("v", "id", "seq", "ts", "type") and k not in autorises:
                raise Violation(f"champ inconnu {k[:20]}")
        self.seq_in += 1
        self.vus[mid] = time.time()
        if len(self.vus) > 5000:
            self.vus = {k: t for k, t in self.vus.items() if time.time() - t < 120}

    async def lire(self, autorises_par_type, binaire_ok=False):
        brut = await self.ws.recv()
        if isinstance(brut, bytes):
            if not binaire_ok or len(brut) < 4:
                raise Violation("trame binaire inattendue")
            lg = int.from_bytes(brut[:4], "big")
            if lg > 4096 or 4 + lg > len(brut):
                raise Violation("entête binaire invalide")
            env = json.loads(brut[4:4 + lg])
            octets = brut[4 + lg:]
            if env.get("type") != "morceau":
                raise Violation("type binaire refusé")
        else:
            if len(brut) > LIMITES["message_json_octets"]:
                raise Violation("message trop gros")
            env = json.loads(brut)
            octets = None
        t = env.get("type") if isinstance(env, dict) else None
        if t not in autorises_par_type:
            raise Violation(f"type {str(t)[:20]} refusé")
        self.verifier(env, autorises_par_type[t])
        return env, octets

    # -------------------------------------------------------- authentification

    async def authentifier(self):
        env, _ = await self.lire({"defi": ["nonce", "defi_ts"]})
        nonce, defi_ts = env.get("nonce"), env.get("defi_ts")
        if not isinstance(nonce, str) or len(nonce) > 100 or not isinstance(defi_ts, int):
            raise Violation("défi invalide")
        with open(chemin(self.config["cle_signature"]), "rb") as f:
            cle = serialization.load_pem_private_key(f.read(), password=None)
        agent_id = self.config["agent_id"]
        message = f"printer-agent-v1|{nonce}|{defi_ts}|{agent_id}|{self.empreinte}".encode()
        await self.envoyer({
            "type": "preuve", "agent": agent_id, "protocole": 1,
            "signature": base64.b64encode(cle.sign(message)).decode(),
            "machines": [{"id": m.id, "nom": m.nom} for m in self.machines.values()],
        })
        await self.lire({"bienvenue": []})
        log.info("authentifié auprès du serveur, %d machine(s)", len(self.machines))

    # -------------------------------------------------------- boucles

    async def recevoir(self):
        types = {"commande": ["machine", "action", "params", "user"], "morceau": ["transfert", "index", "fin"]}
        while True:
            env, octets = await self.lire(types, binaire_ok=True)
            if env["type"] == "morceau":
                self.morceau_recu(env, octets)
            else:
                t = asyncio.create_task(self.commande(env))
                self.taches.add(t)
                t.add_done_callback(self.taches.discard)

    async def commande(self, env):
        re, action, user = env["id"], env.get("action"), env.get("user")
        machine = self.machines.get(env.get("machine"))
        params, erreur = valider(action, env.get("params"))
        if machine is None:
            erreur = "machine inconnue"
        if erreur:
            log.warning("commande refusée %s : %s", action, erreur)
            return await self.envoyer({"type": "reponse", "re": re, "ok": False, "erreur": "refusee_par_agent", "detail": erreur})
        log.info("%s -> %s %s %s", user or "?", machine.id, action, params)
        try:
            if action == "file.upload":
                r = await self.recevoir_gcode(machine, params)
            else:
                r = await asyncio.to_thread(machine.executer, action, params)
        except Exception as e:                  # ne jamais laisser le serveur sans réponse
            log.exception("erreur pendant %s", action)
            r = {"ok": False, "erreur": "erreur_agent", "detail": str(e)[:300]}

        if r.get("ok") and ("octets" in r or "chemin" in r):
            return await self.transferer(re, r.get("resultat"), octets=r.get("octets"),
                                         chemin_fichier=r.get("chemin"), mime=r.get("mime"))
        resultat = r.get("resultat")
        if r.get("ok") and len(json.dumps(resultat)) > JSON_INLINE_MAX:
            return await self.transferer(re, None, octets=json.dumps(resultat).encode(), mime="application/json")
        rep = {"type": "reponse", "re": re, "ok": bool(r.get("ok")), "resultat": resultat}
        if not r.get("ok"):
            rep.update(erreur=r.get("erreur"), detail=r.get("detail"))
        await self.envoyer(rep)

    # -------------------------------------------------------- gcode reçu du serveur

    async def recevoir_gcode(self, machine, p):
        dossier = os.path.join(ICI, "tmp", p["transfert"])
        os.makedirs(dossier, exist_ok=True)
        nom = os.path.basename(p["fichier"].replace("\\", "/"))
        fichier = os.path.join(dossier, nom)
        fin = asyncio.get_running_loop().create_future()
        self.uploads[p["transfert"]] = {"f": open(fichier, "wb"), "taille": p["taille"], "sha": p["sha256"],
                                        "h": hashlib.sha256(), "recu": 0, "index": 0, "fin": fin}
        try:
            await asyncio.wait_for(fin, timeout=LIMITES["reponse_longue_ms"] / 1000)
            return await asyncio.to_thread(machine.recevoir_gcode, fichier)
        except asyncio.TimeoutError:
            return {"ok": False, "erreur": "transfert_incomplet"}
        except Violation as e:
            return {"ok": False, "erreur": "transfert_invalide", "detail": str(e)}
        finally:
            u = self.uploads.pop(p["transfert"], None)
            if u and not u["f"].closed:
                u["f"].close()
            shutil.rmtree(dossier, ignore_errors=True)

    def morceau_recu(self, env, octets):
        u = self.uploads.get(env.get("transfert"))
        if u is None or u["fin"].done():
            raise Violation("morceau d'un transfert inconnu")
        if env.get("index") != u["index"] or not isinstance(env.get("fin"), bool):
            raise Violation("morceau hors ordre")
        u["index"] += 1
        u["recu"] += len(octets)
        if u["recu"] > u["taille"]:
            u["fin"].set_exception(Violation("fichier plus gros qu'annoncé"))
            return
        u["h"].update(octets)
        u["f"].write(octets)
        if env["fin"]:
            u["f"].close()
            if u["recu"] != u["taille"] or u["h"].hexdigest() != u["sha"]:
                u["fin"].set_exception(Violation("taille ou empreinte SHA-256 incorrecte"))
            else:
                u["fin"].set_result(True)

    # -------------------------------------------------------- état et vidéo

    async def pousser_etat(self):
        dernier_fichiers = {}
        while True:
            for m in self.machines.values():
                try:
                    etat = await asyncio.to_thread(m.etat)
                    await self.envoyer({"type": "evenement", "machine": m.id, "nom": "etat", "donnees": etat})
                    liste = await asyncio.to_thread(m.fichiers)
                    signature = hashlib.sha256(json.dumps(liste, sort_keys=True).encode()).hexdigest()
                    if dernier_fichiers.get(m.id) != signature and len(json.dumps(liste)) < JSON_INLINE_MAX:
                        dernier_fichiers[m.id] = signature
                        await self.envoyer({"type": "evenement", "machine": m.id, "nom": "fichiers", "donnees": {"liste": liste}})
                except websockets.ConnectionClosed:
                    raise
                except Exception:
                    log.exception("état de %s", m.id)
            await asyncio.sleep(2)

    async def pousser_video(self):
        # 5 images/s au plus, et seulement pour les machines que quelqu'un regarde
        while True:
            actives = [m for m in self.machines.values() if m.flux_video]
            if not actives:
                await asyncio.sleep(0.5)
                continue
            debut = time.monotonic()
            for m in actives:
                pic = await asyncio.to_thread(m.printer.camera.instant_pic)
                if isinstance(pic, bytes) and len(pic) < LIMITES["morceau_octets"]:
                    await self.envoyer_binaire({"type": "video", "machine": m.id}, pic)
            await asyncio.sleep(max(0.0, 0.2 - (time.monotonic() - debut)))


# ---------------------------------------------------------------------------- boucle principale

def contexte_tls(config):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_3
    ctx.load_verify_locations(chemin(config["ca"]))           # SEULE autorité de confiance : la nôtre
    ctx.load_cert_chain(chemin(config["certificat"]), chemin(config["cle_certificat"]))
    ctx.check_hostname = True
    return ctx


async def une_session(config, machines):
    async with websockets.connect(
        config["serveur"], ssl=contexte_tls(config), compression=None, max_size=LIMITES["morceau_octets"] + 8192,
        open_timeout=15, ping_interval=15, ping_timeout=45, close_timeout=5,
    ) as ws:
        # épinglage : le certificat présenté doit être EXACTEMENT celui attendu
        der = ws.transport.get_extra_info("ssl_object").getpeercert(binary_form=True)
        empreinte = hashlib.sha256(der).hexdigest()
        if not secrets.compare_digest(empreinte, config["empreinte_serveur"].strip().lower()):
            await ws.close(4004, "certificat serveur inattendu")
            raise Violation(f"empreinte du certificat serveur inattendue : {empreinte}")
        s = Session(ws, config, machines, empreinte)
        await s.authentifier()
        taches = [asyncio.create_task(s.recevoir()), asyncio.create_task(s.pousser_etat()),
                  asyncio.create_task(s.pousser_video())]
        try:
            fini, _ = await asyncio.wait(taches, return_when=asyncio.FIRST_EXCEPTION)
            for t in fini:
                t.result()
        finally:
            for m in machines.values():
                m.flux_video = False
            for t in taches + list(s.taches):
                t.cancel()


async def principal(config):
    machines = {}
    for m in config["machines"]:
        from actions import Machine
        machines[m["id"]] = Machine(m["id"], m["ip"], m.get("nom", m["id"]), config)
        log.info("machine %s (%s)", m["id"], m["ip"])
    attente = 1
    while True:
        try:
            await une_session(config, machines)
            attente = 1
        except Violation as e:
            log.error("connexion coupée : %s", e)
            attente = 60
        except websockets.ConnectionClosed as e:
            code = e.rcvd.code if e.rcvd else None
            log.warning("connexion fermée (%s %s)", code, e.rcvd.reason if e.rcvd else "")
            attente = 60 if code in (4001, 4003, 4009) else attente
        except websockets.InvalidStatus as e:
            code = e.response.status_code
            raisons = {409: "place prise par une autre connexion d'agent ; le serveur vérifie si elle répond encore "
                            "(sinon il la coupe sous 5 s). Si un autre agent tourne vraiment, arrête-le",
                       403: "refusé par le serveur (certificat ou adresse IP non autorisés)",
                       429: "adresse IP bannie par le serveur après trop d'échecs (redémarre le serveur ou attends 1 h)"}
            log.warning("connexion refusée (HTTP %s) : %s", code, raisons.get(code, "voir le journal du serveur"))
            if code == 409:
                attente = 3          # la place se libère vite si l'ancienne connexion est morte : on revient tôt
        except (ConnectionAbortedError, ConnectionResetError) as e:
            # WinError 10053 / 10054 : le serveur a coupé la connexion dès l'ouverture
            log.warning("connexion coupée par le serveur dès l'ouverture (%s) : un autre agent est peut-être "
                        "déjà connecté, ou l'adresse IP est bannie ; voir le journal du serveur", e.__class__.__name__)
        except (OSError, ssl.SSLError, asyncio.TimeoutError) as e:
            log.warning("serveur injoignable : %s", e)
        log.info("nouvel essai dans %d s", attente)
        await asyncio.sleep(attente)
        attente = min(attente * 2, 60)


def main():
    ap = argparse.ArgumentParser(description="Agent local des imprimantes")
    ap.add_argument("--config", default=os.path.join(ICI, "config.json"))
    ap.add_argument("--generer-cle", action="store_true", help="crée la clé de signature Ed25519 de l'agent")
    args = ap.parse_args()
    with open(args.config, "r", encoding="utf-8") as f:
        config = json.load(f)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(),
                                  logging.FileHandler(os.path.join(ICI, "agent.log"), encoding="utf-8")])
    if args.generer_cle:
        return generer_cle(config)
    if not config.get("empreinte_serveur"):
        fichier = os.path.join(ICI, "secrets", "empreinte_serveur.txt")
        if os.path.exists(fichier):
            with open(fichier, encoding="utf-8") as f:
                config["empreinte_serveur"] = f.read().strip()
        else:
            sys.exit("empreinte_serveur manquante dans la configuration")
    try:
        asyncio.run(principal(config))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
