"""python -m client_printer 192.168.1.42  ->  met à jour l'imprimante en boucle (Ctrl+C pour arrêter)."""

import sys

from .printer import Printer


def main():
    if len(sys.argv) < 2:
        print("usage : python -m client_printer <ip de l'imprimante>")
        return 1
    Printer(sys.argv[1]).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
