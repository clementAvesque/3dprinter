"""Crée (ou met à jour) chez Brevo le template HTML des e-mails du site, puis l'envoie à Fly.

    python serveur/scripts/brevo_template.py

Le script demande :
  1. ta clé API Brevo (xkeysib-...) : colle-la, rien ne s'affiche à l'écran, c'est normal ;
  2. l'adresse qui envoie les e-mails (validée dans Brevo > Senders) ;
puis il crée le template (ou le met à jour s'il existe déjà : relance-le après avoir modifié
brevo-template.html), t'envoie un e-mail d'essai et règle le serveur Fly (clé + expéditeur + numéro du template).

Aucune dépendance : seulement la bibliothèque standard de Python.
"""

import getpass
import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ICI = Path(__file__).resolve().parent
PROJET = ICI.parent.parent
API = "https://api.brevo.com/v3"
NOM_TEMPLATE = "Impression 3D - e-mails du site"
EMAIL_RE = re.compile(r"^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$")

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")   # accents corrects dans le terminal Windows


def arreter(message):
    print(f"\n[ERREUR] {message}\n")
    input("Appuie sur Entrée pour fermer...")
    sys.exit(1)


def oui(question):
    return input(f"{question} [O/n] ").strip().lower() in ("", "o", "oui", "y", "yes")


def brevo(cle, methode, chemin, corps=None):
    """Appelle l'API Brevo ; retourne le JSON de la réponse (None si vide)."""
    requete = urllib.request.Request(
        API + chemin, method=methode,
        data=json.dumps(corps).encode() if corps is not None else None,
        headers={"api-key": cle, "accept": "application/json", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(requete, timeout=20) as rep:
            texte = rep.read().decode()
            return json.loads(texte) if texte else None
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read().decode())
            raison = detail.get("message") or detail.get("code") or ""
        except Exception:
            raison = ""
        if e.code == 401:
            arreter(f"Brevo refuse la clé API ({raison or 'HTTP 401'}). Vérifie que tu l'as bien copiée en entier.")
        if "sender" in raison.lower():
            arreter(f"Brevo refuse l'expéditeur : {raison}\n"
                    "         Valide d'abord cette adresse dans Brevo > Senders, Domains & Dedicated IPs > Senders.")
        arreter(f"Brevo a refusé {methode} {chemin} (HTTP {e.code}) : {raison}")
    except urllib.error.URLError as e:
        arreter(f"Brevo injoignable (connexion Internet ?) : {e.reason}")


def nom_app_fly():
    toml = (PROJET / "fly.toml").read_text(encoding="utf-8")
    m = re.search(r'^app\s*=\s*"([^"]+)"', toml, re.M)
    if not m:
        arreter("Nom de l'app introuvable dans fly.toml (ligne app = \"...\").")
    return m.group(1)


def main():
    print("=== Template Brevo des e-mails du site ===\n")

    # 1. clé API (masquée : elle ne reste ni à l'écran ni dans l'historique du terminal)
    cle = getpass.getpass("Colle ta clé API Brevo (rien ne s'affiche, c'est normal) puis Entrée : ").strip()
    if not cle.startswith("xkeysib-"):
        arreter("Une clé API Brevo commence par « xkeysib- » (Brevo > SMTP & API > API Keys).")

    # 2. expéditeur
    email = input("Adresse qui envoie les e-mails (validée dans Brevo > Senders) : ").strip()
    if not EMAIL_RE.match(email):
        arreter(f"« {email} » n'est pas une adresse e-mail valide.")
    nom = input("Nom affiché comme expéditeur [Printable] : ").strip() or "Printable"
    nom = nom.replace("<", "").replace(">", "").replace('"', "")
    expediteur = f"{nom} <{email}>"

    # 3. template : mis à jour s'il existe déjà (recherché par son nom), sinon créé
    html = (ICI / "brevo-template.html").read_text(encoding="utf-8")
    modele = {"templateName": NOM_TEMPLATE, "subject": "{{ params.sujet }}", "htmlContent": html,
              "sender": {"name": nom, "email": email}, "isActive": True, "tag": "site"}
    print("\nConnexion à Brevo...")
    liste = brevo(cle, "GET", "/smtp/templates?limit=1000&offset=0") or {}
    existant = next((t for t in liste.get("templates", []) if t.get("name") == NOM_TEMPLATE), None)
    if existant:
        id_template = existant["id"]
        brevo(cle, "PUT", f"/smtp/templates/{id_template}", modele)
        print(f"[OK] Template n° {id_template} mis à jour.")
    else:
        id_template = brevo(cle, "POST", "/smtp/templates", modele)["id"]
        print(f"[OK] Template n° {id_template} créé.")

    # 4. e-mail d'essai (mêmes variables que celles envoyées par le serveur, voir src/courriel.js)
    if oui(f"\nM'envoyer un e-mail d'essai à {email} ?"):
        brevo(cle, "POST", "/smtp/email", {
            "templateId": id_template,
            "sender": {"name": nom, "email": email},
            "to": [{"email": email}],
            "subject": "Essai du template",
            "params": {
                "sujet": "Essai du template",
                "paragraphes": [
                    "Bonjour,",
                    "Ceci est un e-mail d'essai.\nSi tu vois le bandeau, ce texte sur deux lignes et le bouton bleu, "
                    "le template marche.",
                ],
                "lien": "https://passerelle-printer-server.fly.dev/sante",
                "bouton": "Bouton d'essai",
            },
        })
        print(f"[OK] E-mail d'essai envoyé à {email} (regarde aussi les indésirables).")

    # 5. réglages du serveur en ligne
    app = nom_app_fly()
    secrets = [
        "COURRIEL_MODE=brevo",
        f"COURRIEL_CLE_API={cle}",
        f"COURRIEL_EXPEDITEUR={expediteur}",
        f"COURRIEL_TEMPLATE_ID={id_template}",
    ]
    fly = shutil.which("fly") or shutil.which("flyctl")
    print(f"\nRéglages pour le serveur Fly ({app}) :")
    print(f"  COURRIEL_EXPEDITEUR  = {expediteur}")
    print(f"  COURRIEL_TEMPLATE_ID = {id_template}")
    print("  COURRIEL_CLE_API     = xkeysib-...(masquée)")
    if fly and oui("Les envoyer à Fly maintenant ? (le serveur redémarre, coupure de quelques secondes)"):
        r = subprocess.run([fly, "secrets", "set", *secrets, "-a", app])
        if r.returncode != 0:
            arreter("fly secrets set a échoué (connecté à Fly ? essaie : fly auth login).")
        print("\n[OK] Serveur mis à jour. Vérifie avec :  fly logs -a " + app)
    else:
        if not fly:
            print("\n(commande fly introuvable sur ce PC)")
        print("\nCommande à lancer toi-même (elle contient ta clé : ne la colle nulle part ailleurs) :")
        print(f'  fly secrets set {secrets[0]} {secrets[1]} "{secrets[2]}" {secrets[3]} -a {app}')

    input("\nTerminé. Appuie sur Entrée pour fermer...")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nAnnulé.")
