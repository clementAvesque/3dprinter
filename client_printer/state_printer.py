class State_printer:
    def __init__(self):
        self.state = None

    def READY(self):
        self.state = "READY"
        return self.state

    def PRINTING(self):
        self.state = "PRINTING"
        return self.state

    def ERROR(self):
        self.state = "ERROR"
        return self.state

    def BREAK(self):
        if self.state != "PRINTING":
            return "il faut qu'une impression ait lieu pour mettre sur pause"
        self.state = "BREAK"
        return self.state

    def RESTART(self):
        # après une reprise l'imprimante est de nouveau en train d'imprimer
        if self.state != "BREAK":
            return "l'impression doit etre en pause d'impression pour reprendre une impression"
        self.state = "PRINTING"
        return self.state
