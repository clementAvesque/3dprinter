"""Branche Stripe sur le serveur en ligne : webhook chez Stripe + secrets sur Fly.

    python serveur/scripts/stripe_configurer.py

Le script demande ta clé secrète Stripe (Developers > API keys > Secret key, « sk_test_... » en mode test) :
colle-la, rien ne s'affiche à l'écran, c'est normal. Il :
  1. vérifie la clé auprès de Stripe ;
  2. crée chez Stripe le webhook https://<app>.fly.dev/api/stripe/webhook (paiement reçu, page expirée)
     et récupère son secret de signature (« whsec_... ») ;
  3. envoie la clé et le secret à Fly (STRIPE_CLE_SECRETE, STRIPE_SECRET_WEBHOOK) : le serveur redémarre.

Relancer le script remplace le webhook (Stripe ne redonne jamais le secret d'un webhook existant).
Aucune dépendance : seulement la bibliothèque standard de Python.
"""

import getpass
import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PROJET = Path(__file__).resolve().parent.parent.parent
API = "https://api.stripe.com/v1"
EVENEMENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.expired"]

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def arreter(message):
    print(f"\n[ERREUR] {message}\n")
    input("Appuie sur Entrée pour fermer...")
    sys.exit(1)


def oui(question):
    return input(f"{question} [O/n] ").strip().lower() in ("", "o", "oui", "y", "yes")


def stripe(cle, methode, chemin, champs=None):
    donnees = urllib.parse.urlencode(champs or [], doseq=True).encode() if champs is not None else None
    requete = urllib.request.Request(API + chemin, method=methode, data=donnees,
                                     headers={"Authorization": f"Bearer {cle}"})
    try:
        with urllib.request.urlopen(requete, timeout=20) as rep:
            return json.loads(rep.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            raison = json.loads(e.read().decode()).get("error", {}).get("message", "")
        except Exception:
            raison = ""
        if e.code == 401:
            arreter(f"Stripe refuse la clé ({raison or 'HTTP 401'}). Copie la « Secret key » en entier.")
        arreter(f"Stripe a refusé {methode} {chemin} (HTTP {e.code}) : {raison}")
    except urllib.error.URLError as e:
        arreter(f"Stripe injoignable (connexion Internet ?) : {e.reason}")


def nom_app_fly():
    toml = (PROJET / "fly.toml").read_text(encoding="utf-8")
    m = re.search(r'^app\s*=\s*"([^"]+)"', toml, re.M)
    if not m:
        arreter("Nom de l'app introuvable dans fly.toml (ligne app = \"...\").")
    return m.group(1)


def main():
    print("=== Paiement Stripe du site ===\n")
    cle = getpass.getpass("Colle ta clé secrète Stripe (rien ne s'affiche, c'est normal) puis Entrée : ").strip()
    if cle.startswith("sk_live_"):
        print("\n/!\\ Clé RÉELLE : les clients paieront vraiment. Les CGV et mentions légales doivent être en place.")
        if input("Tape REEL pour continuer : ").strip() != "REEL":
            arreter("Annulé. Utilise d'abord la clé de test (sk_test_...).")
    elif not cle.startswith("sk_test_"):
        arreter("Une clé secrète Stripe commence par « sk_test_ » (test) ou « sk_live_ » (réel). "
                "Les clés « pk_ » (publiques) et « rk_ » (restreintes) ne conviennent pas.")

    print("\nVérification de la clé...")
    compte = stripe(cle, "GET", "/account")
    print(f"[OK] Compte Stripe : {compte.get('settings', {}).get('dashboard', {}).get('display_name') or compte.get('id')}"
          f" ({'TEST' if cle.startswith('sk_test_') else 'RÉEL'})")

    app = nom_app_fly()
    url = f"https://{app}.fly.dev/api/stripe/webhook"
    existants = [w for w in stripe(cle, "GET", "/webhook_endpoints?limit=100").get("data", []) if w.get("url") == url]
    if existants:
        print(f"\nUn webhook existe déjà pour {url} : il va être remplacé (Stripe ne redonne pas son secret).")
        if not oui("Continuer ?"):
            arreter("Annulé.")
        for w in existants:
            stripe(cle, "DELETE", f"/webhook_endpoints/{w['id']}")
    webhook = stripe(cle, "POST", "/webhook_endpoints", [("url", url), ("description", "Site d'impression 3D (serveur Fly)")]
                     + [("enabled_events[]", e) for e in EVENEMENTS])
    secret = webhook.get("secret", "")
    if not secret.startswith("whsec_"):
        arreter("Stripe n'a pas renvoyé de secret de webhook.")
    print(f"[OK] Webhook créé : {url}")

    secrets = [f"STRIPE_CLE_SECRETE={cle}", f"STRIPE_SECRET_WEBHOOK={secret}"]
    fly = shutil.which("fly") or shutil.which("flyctl")
    if fly and oui(f"\nEnvoyer la clé et le secret à Fly ({app}) maintenant ? (le serveur redémarre, coupure de quelques secondes)"):
        r = subprocess.run([fly, "secrets", "set", *secrets, "-a", app])
        if r.returncode != 0:
            arreter("fly secrets set a échoué (connecté à Fly ? essaie : fly auth login).")
        print(f"\n[OK] Paiement branché. Vérifie avec :  fly logs -a {app}")
        print("Essai : commande un devis sur le site et paie avec la carte 4242 4242 4242 4242, date future, CVC 123.")
    else:
        print("\nCommande à lancer toi-même (elle contient tes secrets : ne la colle nulle part ailleurs) :")
        print(f"  fly secrets set {' '.join(secrets)} -a {app}")

    input("\nTerminé. Appuie sur Entrée pour fermer...")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAnnulé.")
