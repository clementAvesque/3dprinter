import json

from .temperature import Temperature
from .utils import gcode


class Heater:
    """Base commune à la buse et au plateau : lecture + réglage de la température."""

    NAME = ""             # nom lisible (ex. "nozzle")
    SENSOR = ""           # objet Klipper (ex. "extruder")
    GCODE_SET = ""        # commande non bloquante (M104 / M140)
    GCODE_WAIT = ""       # commande bloquante (M109 / M190)
    MAX_TEMP = 0          # limite de sécurité en °C
    WAIT_TIMEOUT = 600    # secondes max d'attente quand wait=True

    def __init__(self, ip):
        self.ip = ip
        self.temperature = Temperature(self.NAME, ip, self.SENSOR)
        self.query = self.temperature.query     # ce que ce composant lit sur Klipper

    def __str__(self):
        return str(self.temperature)

    def to_dict(self):
        return {"temperature": self.temperature.to_dict()}

    def to_json(self):
        return json.dumps(self.to_dict(), ensure_ascii=False)

    def update(self):
        self.temperature.update()
        return self.to_dict()

    def apply_status(self, status):
        # met à jour depuis un status déjà récupéré (aucune requête réseau)
        self.temperature.apply_status(status)

    def set_target_temp(self, temp, wait=False):
        """Chauffe jusqu'à `temp` °C. Si wait=True, bloque jusqu'à ce que la température soit atteinte."""
        temp = int(temp)
        if temp < 0 or temp > self.MAX_TEMP:
            return {"error": f"température hors limites (0 à {self.MAX_TEMP} °C)"}

        commande = f"{self.GCODE_WAIT if wait else self.GCODE_SET} S{temp}"
        res = gcode(self.ip, commande, timeout=self.WAIT_TIMEOUT if wait else 10)
        if not res.get("error"):
            self.temperature.target = temp if temp > 0 else None
        return res

    def stop(self):
        """Coupe la chauffe."""
        return self.set_target_temp(0)
