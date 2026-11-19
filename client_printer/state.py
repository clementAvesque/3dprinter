class State:
    """État de l'ACE : DRY (séchage), ON (allumé), OFF (absent)."""

    def __init__(self):
        self.state = None

    def DRY(self):
        self.state = "DRY"
        return self.state

    def OFF(self):
        self.state = "OFF"
        return self.state

    def ON(self):
        self.state = "ON"
        return self.state
