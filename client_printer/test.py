#!/usr/bin/env python3
"""Test de chauffe de la buse : demande une température, la lit en boucle, vérifie qu'elle monte.

    python test.py 192.168.1.42              # 60 °C par défaut
    python test.py 192.168.1.42 --temp 100
    python test.py 192.168.1.42 --temp 60 --timeout 180

La chauffe est toujours coupée à la fin, même avec Ctrl+C ou en cas d'erreur.
"""

import argparse
import os
import sys
import time

# permet de lancer ce script depuis le dossier de la librairie :
# on ajoute le dossier parent au chemin pour pouvoir importer "client_printer"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from client_printer import Printer


def main():
    ap = argparse.ArgumentParser(description="Test de chauffe de la buse")
    ap.add_argument("ip")
    ap.add_argument("--temp", type=int, default=60, help="température visée en °C (défaut 60)")
    ap.add_argument("--timeout", type=int, default=120, help="secondes max avant d'abandonner")
    ap.add_argument("--interval", type=float, default=2, help="secondes entre deux lectures")
    args = ap.parse_args()

    p = Printer(args.ip)
    if not p.update():
        print("ÉCHEC : l'imprimante ne répond pas")
        return 1

    depart = p.nozzle.temperature.value
    print(f"Départ : {depart} °C -> cible {args.temp} °C")

    res = p.nozzle.set_target_temp(args.temp)
    if res.get("error"):
        print(f"ÉCHEC : commande refusée : {res}")
        return 1

    reussi = False
    debut = time.time()
    try:
        while True:
            if not p.update():
                print("ÉCHEC : l'imprimante ne répond plus")
                break

            t = p.nozzle.temperature
            print(f"{time.time() - debut:5.0f} s   buse {t.value:6.1f} °C   cible lue : {t.target}")

            if t.target != args.temp:
                print(f"ÉCHEC : la cible lue sur Klipper ({t.target}) n'est pas celle demandée ({args.temp})")
                break
            if t.value >= args.temp - 2:
                print(f"OK : {t.value} °C atteint (départ {depart} °C)")
                reussi = True
                break
            if time.time() - debut > args.timeout:
                print(f"ÉCHEC : {args.temp} °C non atteint en {args.timeout} s (buse à {t.value} °C)")
                break

            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nInterrompu.")
    finally:
        p.nozzle.stop()
        print("Chauffe coupée.")

    return 0 if reussi else 1


if __name__ == "__main__":
    sys.exit(main())