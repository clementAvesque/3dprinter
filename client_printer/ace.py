import json

from .config import MOONRAKER_PORT
from .state import State
from .utils import gcode, query_status, req_send


class Ace:
    def __init__(self, url):
        # tableau d'objets : [{"color": "#rrggbb" ou None si vide, "emplacement": 1..4, "matiere": "PLA"...}]
        self.fils = None
        self.slot_actif = None  # emplacement (1..4) dont le fil est chargé dans la tête, sinon None
        self.state = State()  # "DRY" si séchage, "ON" si allumé, "OFF" si absent
        self.url = url
        self.query = {"filament_hub": None}     # ce que l'ACE lit sur Klipper (None = tout)

    def __str__(self):
        # phrase lisible pour print(ace) ; le JSON structuré est dans to_json()
        if self.fils is not None:
            return str(self.fils)
        return "tu dois d'abord initialiser ton ACE"

    def to_dict(self):
        return {"state": self.state.state, "fils": self.fils, "slot_actif": self.slot_actif}

    def to_json(self):
        return json.dumps(self.to_dict(), ensure_ascii=False)

    def init_fil(self):
        # fait l'appel nécessaire pour récupérer les données de l'ACE
        return self.update()

    def update(self):
        # récupère les valeurs actuelles de l'ACE (fils + état)
        # retourne la liste des fils, ou None si la connexion a échoué
        status = query_status(self.url, self.query)

        # échec de connexion : on garde les anciennes valeurs
        if status.get("error"):
            print(f"Erreur : {status['error']}")
            return None
        return self.apply_status(status)

    def apply_status(self, status):
        # met à jour self.fils et self.state depuis un status déjà récupéré (aucune requête réseau)
        hub = status.get("filament_hub", {})
        hubs = hub.get("filament_hubs") or hub.get("hubs") or []

        # pas d'ACE détecté
        if not hubs:
            self.fils = []
            self.slot_actif = None
            self.state.OFF()
            return self.fils

        # fil chargé dans la tête : "0-2" = ACE 0, emplacement d'indice 2 (donc le 3), "" = aucun
        try:
            self.slot_actif = int(str(hub.get("current_filament") or "").split("-")[1]) + 1
        except (IndexError, ValueError):
            self.slot_actif = None

        ace = hubs[0]

        fils = []
        for slot in ace.get("slots", []):
            # un emplacement vide garde une ancienne couleur côté imprimante :
            # on se fie à son "status" ("ready" / "empty") et on met None
            rgb = slot.get("color")
            if slot.get("status") == "empty" or not rgb:
                couleur = None
            else:
                couleur = "#{:02x}{:02x}{:02x}".format(*rgb[:3])
            fils.append({
                "color": couleur,
                "emplacement": slot.get("index", 0) + 1,
                "matiere": (slot.get("type") or None) if couleur else None,
            })
        self.fils = fils

        # état : DRY si le séchage est actif, sinon ON
        # (l'imprimante l'appelle "dryer_status" ; "dry_status" gardé au cas où)
        dry = ace.get("dryer_status") or ace.get("dry_status") or {}
        if dry.get("status") not in (None, 0, "stop", "off"):
            self.state.DRY()
        else:
            self.state.ON()

        return self.fils

    # Séchage : il n'existe pas de commande gcode pour ça sur la Kobra 3 (vérifié : /printer/gcode/help).
    # Rinkhals l'expose par son module Moonraker « mmu_ace » : POST /server/filament_hub/start_drying et
    # /stop_drying (id = numéro de l'ACE, 0 pour le premier). Contrairement à son gcode MMU_DRYER_START,
    # ces adresses renvoient une vraie erreur si l'ACE refuse.

    def _dryer(self, action, **params):
        return req_send("POST", f"http://{self.url}:{MOONRAKER_PORT}/server/filament_hub/{action}",
                        json={"id": 0, **params}, timeout=15)

    def start_dry(self, temp=50, duration=240, fan_speed=0):
        # lance le séchage : temp en °C (45 PLA, 55 PETG, 65 ABS), duration en minutes
        res = self._dryer("start_drying", temp=int(temp), duration=int(duration), fan_speed=int(fan_speed))
        if not res.get("error"):
            self.state.DRY()
        return res

    def stop_dry(self):
        # arrête le séchage
        res = self._dryer("stop_drying")
        if not res.get("error"):
            self.state.ON()
        return res

    # Avancer / reculer le filament : commandes du firmware Anycubic (GoKlipper), celles qu'utilise Rinkhals
    # pour son MMU_LOAD / MMU_UNLOAD. Vérifié sur la Kobra 3 : FEED_FILAMENT refuse si la buse est froide
    # (« Extruder must heat up first »), UNWIND_FILAMENT refuse si aucun fil n'est dans l'extrudeur.
    # /!\ Attention : le firmware répond « ok » à une commande qu'il ne connaît pas ; seules ces commandes-là
    # (vérifiées) sont fiables. ID = numéro de l'ACE (0), INDEX = emplacement 0..3.

    def feed(self, slot, length=100, speed=25):
        # pousse le filament de l'emplacement (1..4) vers la tête : length en mm, speed en mm/s.
        # La buse doit être chaude (voir Printer.load_filament, qui chauffe d'abord).
        if slot not in (1, 2, 3, 4):
            return {"error": "slot doit valoir 1, 2, 3 ou 4"}
        return gcode(self.url, f"FEED_FILAMENT ID=0 INDEX={slot - 1} LENGTH={int(length)} SPEED={int(speed)}",
                     timeout=int(length / max(speed, 1)) + 30)

    def retract(self, slot, length=100, speed=20):
        # ramène dans l'ACE le filament de l'emplacement (1..4) (voir Printer.unload_filament)
        if slot not in (1, 2, 3, 4):
            return {"error": "slot doit valoir 1, 2, 3 ou 4"}
        return gcode(self.url, f"UNWIND_FILAMENT ID=0 INDEX={slot - 1} LENGTH={int(length)} SPEED={int(speed)}",
                     timeout=int(length / max(speed, 1)) + 30)
