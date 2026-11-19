from .heater import Heater
from .utils import gcode, query_status


class Nozzle(Heater):
    NAME = "nozzle"
    SENSOR = "extruder"
    GCODE_SET = "M104"
    GCODE_WAIT = "M109"
    MAX_TEMP = 300      # /!\ à adapter à ta machine
    MAX_EXTRUDE = 200   # mm max par appel d'extrusion (sécurité)

    def __init__(self, ip):
        super().__init__(ip)
        self.posX = None
        self.posY = None
        self.posZ = None
        # la buse lit sa température ET la position de la tête : une seule requête pour les deux
        self.query = {**self.temperature.query, "toolhead": ["position"]}

    def __str__(self):
        if self.posX is not None:
            pos_str = f"Position -> X:{self.posX} Y:{self.posY} Z:{self.posZ}"
        else:
            pos_str = "Position inconnue"
        return f"Buse | {self.temperature} | {pos_str}"

    def to_dict(self):
        return {
            "temperature": self.temperature.to_dict(),
            "position": {"x": self.posX, "y": self.posY, "z": self.posZ},
        }

    def update(self):
        status = query_status(self.ip, self.query)
        if status.get("error"):
            print(f"Erreur : {status['error']}")
        else:
            self.apply_status(status)
        return self.to_dict()

    def apply_status(self, status):
        # température puis position, depuis un status déjà récupéré (aucune requête réseau)
        self.temperature.apply_status(status)
        pos = status.get("toolhead", {}).get("position")
        if pos and len(pos) >= 3:
            self.posX = round(pos[0], 2)
            self.posY = round(pos[1], 2)
            self.posZ = round(pos[2], 2)

    def position(self):
        """Retourne la dernière position connue (appelle update() avant pour la rafraîchir)."""
        return {"x": self.posX, "y": self.posY, "z": self.posZ}

    def home(self, axes=""):
        """Auto-Home (G28). home() pour tous les axes, home("XY") pour certains."""
        axes = " ".join(axes.upper())
        return gcode(self.ip, f"G28 {axes}".strip(), timeout=120)

    def move(self, x=None, y=None, z=None, relative=False, speed=3000):
        """Déplace la tête. speed en mm/min. Les axes doivent être "home" avant.
        move(x=100, y=50)           -> position absolue
        move(x=-10, relative=True)  -> -10 sur X par rapport à la position actuelle
        """
        axes = " ".join(
            f"{nom}{valeur}"
            for nom, valeur in (("X", x), ("Y", y), ("Z", z))
            if valeur is not None
        )
        if not axes:
            return {"error": "donne au moins un axe (x, y ou z)"}
        mode = "G91" if relative else "G90"
        return gcode(self.ip, f"{mode}\nG1 {axes} F{speed}\nG90")

    # ----- moteur d'extrusion ---------------------------------------------
    # Bas niveau : ne vérifie PAS si une impression est en cours.
    # Pour charger/décharger un filament en sécurité, voir Printer.load_filament().

    def can_extrude(self):
        """True si la buse est assez chaude pour extruder (décision de Klipper)."""
        status = query_status(self.ip, {"extruder": ["can_extrude"]})
        if status.get("error"):
            return False
        return bool(status.get("extruder", {}).get("can_extrude"))

    def _move_extruder(self, delta, speed):
        if speed <= 0:
            return {"error": "speed doit être positif"}
        if abs(delta) > self.MAX_EXTRUDE:
            return {"error": f"longueur limitée à {self.MAX_EXTRUDE} mm par appel"}
        if not self.can_extrude():
            return {"error": "buse trop froide pour extruder (chauffe-la d'abord)"}
        # M83 = extrusion en relatif ; speed en mm/s -> F en mm/min
        duree = abs(delta) / speed
        return gcode(self.ip, f"M83\nG1 E{delta} F{round(speed * 60)}", timeout=int(duree) + 15)

    def extrude(self, length=10, speed=5):
        """Pousse `length` mm de filament à `speed` mm/s."""
        if length <= 0:
            return {"error": "length doit être positif (utilise retract() pour reculer)"}
        return self._move_extruder(length, speed)

    def retract(self, length=10, speed=5):
        """Recule `length` mm de filament à `speed` mm/s."""
        if length <= 0:
            return {"error": "length doit être positif"}
        return self._move_extruder(-length, speed)
