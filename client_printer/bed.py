from .heater import Heater


class Bed(Heater):
    NAME = "bed"
    SENSOR = "heater_bed"
    GCODE_SET = "M140"
    GCODE_WAIT = "M190"
    MAX_TEMP = 110      # /!\ à adapter à ta machine

    def __str__(self):
        return f"Plateau | {self.temperature}"
