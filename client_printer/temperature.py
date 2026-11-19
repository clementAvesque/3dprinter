import json

from .utils import query_status


class Temperature:
    def __init__(self, temp_of, url, sensor="extruder"):
        self.value = None
        self.target = None      # température cible (None = chauffe coupée)
        self.unit = "Celsius"
        self.temp_of = temp_of
        self.url = url
        self.sensor = sensor    # "extruder" pour la buse, "heater_bed" pour le plateau
        self.query = {sensor: ["temperature", "target"]}    # ce que ce capteur lit sur Klipper

    def __str__(self):
        if self.value is None:
            return "Veuillez donner une température via la fonction update"
        texte = f"La température de {self.temp_of} est de {self.value} {self.unit}"
        if self.target:
            texte += f" (cible : {self.target})"
        return texte

    def to_dict(self):
        return {
            "value": self.value,
            "target": self.target,
            "unit": self.unit,
            "temperature_of": self.temp_of,
        }

    def to_json(self):
        if self.value is None:
            return "Veuillez donner une température via la fonction update"
        return json.dumps(self.to_dict(), ensure_ascii=False)

    def update(self):
        # lecture de ce seul capteur (1 requête).
        # Printer.update() n'appelle pas ça : il lit tout d'un coup puis appelle apply_status().
        status = query_status(self.url, self.query)
        if status.get("error"):
            print(f"Erreur : {status['error']}")
            return None
        return self.apply_status(status)

    def apply_status(self, status):
        # met à jour depuis un status déjà récupéré (aucune requête réseau)
        data = status.get(self.sensor)
        if not data or "temperature" not in data:
            return None
        self.value = data["temperature"]
        self.target = data.get("target") or None    # 0 -> None
        return self.value
