import json

from .state import State
from .utils import gcode, query_status


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

    def start_dry(self, temp=50, duration=240):
        # lance le séchage : temp en °C, duration en minutes
        # /!\ commande gcode supposée, à vérifier avec ta doc Rinkhals
        res = gcode(self.url, f"ACE_START_DRYING TEMP={int(temp)} DURATION={int(duration)}")
        if not res.get("error"):
            self.state.DRY()
        return res

    def stop_dry(self):
        # arrête le séchage
        # /!\ commande gcode supposée, à vérifier avec ta doc Rinkhals
        res = gcode(self.url, "ACE_STOP_DRYING")
        if not res.get("error"):
            self.state.ON()
        return res

    def feed(self, slot, length=100, speed=25):
        # pousse le filament du slot (1..4) vers l'imprimante : length en mm, speed en mm/s
        # /!\ commande gcode supposée, à vérifier avec ta doc Rinkhals
        if slot not in (1, 2, 3, 4):
            return {"error": "slot doit valoir 1, 2, 3 ou 4"}
        return gcode(self.url, f"ACE_FEED INDEX={slot - 1} LENGTH={int(length)} SPEED={int(speed)}",
                     timeout=int(length / max(speed, 1)) + 15)

    def retract(self, slot, length=100, speed=25):
        # ramène le filament du slot (1..4) dans l'ACE
        # /!\ commande gcode supposée, à vérifier avec ta doc Rinkhals
        if slot not in (1, 2, 3, 4):
            return {"error": "slot doit valoir 1, 2, 3 ou 4"}
        return gcode(self.url, f"ACE_RETRACT INDEX={slot - 1} LENGTH={int(length)} SPEED={int(speed)}",
                     timeout=int(length / max(speed, 1)) + 15)
