import time
import requests

IP_IMPRIMANTE = "192.168.1.42"
url = f"http://{IP_IMPRIMANTE}:7125/printer/objects/query?print_stats&webhooks"

while True:
    try:
        response = requests.get(url)
        data = response.json()
        
        status = data.get("result", {}).get("status", {})
        print_stats = status.get("print_stats", {})
        webhooks = status.get("webhooks", {})
        
        etat_machine = webhooks.get("state") # Ex: "ready" ou "error"
        etat_impression = print_stats.get("state") # Ex: "printing", "error", etc.
        message_erreur = webhooks.get("message", "")

        print(f"État machine : {etat_machine} | Impression : {etat_impression}")

        if etat_machine == "error" or etat_impression == "error":
            print(f"⚠️ ATTENTION : Erreur détectée sur l'imprimante ! Message : {message_erreur}")
            # Ici, tu pourrais ajouter une alerte (ex: un envoi de message Discord/Telegram)
            break

    except Exception as e:
        print(f"Erreur de communication : {e}")

    time.sleep(5) # Vérifie toutes les 5 secondes