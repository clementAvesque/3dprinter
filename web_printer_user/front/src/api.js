// Appels à l'API client du serveur (/api/client) : JSON, jeton anti-CSRF, erreurs lisibles.

const BASE = '/api/client';
let csrf = '';
export const poserCsrf = (c) => { csrf = c || ''; };

const MESSAGES = {
  identifiants_invalides: 'E-mail ou mot de passe incorrect.',
  email_non_verifie: 'Confirme d\'abord ton adresse e-mail : clique sur le lien reçu par e-mail.',
  trop_de_tentatives: 'Trop d\'essais : réessaie un peu plus tard.',
  trop_de_requetes: 'Trop de requêtes : patiente une minute.',
  non_connecte: 'Connecte-toi pour continuer.',
  lien_invalide: 'Ce lien a expiré ou a déjà servi. Demande-en un nouveau.',
  stl_invalide: 'Ce fichier n\'est pas un STL lisible.',
  stl_attendu: 'Seuls les fichiers .stl sont acceptés.',
  fichier_trop_gros: 'Fichier trop gros.',
  piece_trop_grande: 'Une pièce est trop grande pour nos imprimantes.',
  reseau: 'Le serveur ne répond pas. Vérifie ta connexion (en développement : le serveur local tourne-t-il ?).',
  paiement_non_configure: 'Le paiement en ligne n\'est pas encore ouvert. Reviens bientôt !',
  paiement_indisponible: 'Le service de paiement ne répond pas. Réessaie dans quelques minutes.',
  deja_commandee: 'Ce devis est déjà commandé et payé.',
  devis_commande: 'Ce devis est commandé (paiement en cours ou fait) : il ne peut plus être supprimé.',
  decoupe_en_cours: 'Le devis est en cours de découpe : attends la fin pour le supprimer.',
  devis_pas_pret: 'Ce devis n\'est pas encore prêt.',
  adresse_invalide: 'Adresse incomplète ou invalide.',
  adresse_inconnue: 'Choisis une adresse de livraison.',
  courriel_indisponible: 'Impossible d\'envoyer l\'e-mail pour le moment. Réessaie dans quelques minutes.',
  email_invalide: 'Cette adresse e-mail n\'est pas valide.',
  nom_invalide: 'Indique un nom (80 caractères maximum).',
  origine_refusee: 'Le serveur refuse les requêtes venant de cette adresse (ORIGINE_SITE).',
};

export class ErreurApi extends Error {
  constructor(statut, json) {
    // pas de JSON (ex. relais de Vite vers un serveur arrêté : 500 en texte brut) : le serveur ne répond pas
    const code = json?.erreur || (statut === 0 || statut >= 500 ? 'reseau' : 'erreur');
    super((MESSAGES[code] || code) + (json?.detail && !MESSAGES[code] ? ` : ${json.detail}` : ''));
    this.statut = statut;
    this.code = code;
    this.detail = json?.detail;
  }
}

export async function api(methode, chemin, corps) {
  const options = { method: methode, headers: {}, credentials: 'same-origin' };
  if (methode !== 'GET') options.headers['X-CSRF-Token'] = csrf;
  if (corps instanceof FormData) options.body = corps;
  else if (corps !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(corps);
  }
  let rep;
  try {
    rep = await fetch(BASE + chemin, options);
  } catch {
    throw new ErreurApi(0, { erreur: 'reseau' });
  }
  const json = (rep.headers.get('content-type') || '').includes('json') ? await rep.json() : null;
  if (!rep.ok) throw new ErreurApi(rep.status, json);
  return json;
}

// envoi d'un STL avec la progression (fetch ne la donne pas pour les envois)
export function envoyerStl(fichier, progression) {
  return new Promise((ok, ko) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/fichiers`);
    xhr.setRequestHeader('X-CSRF-Token', csrf);
    xhr.upload.onprogress = (e) => e.lengthComputable && progression?.(e.loaded / e.total);
    xhr.onload = () => {
      let json = null;
      try { json = JSON.parse(xhr.responseText); } catch { /* réponse vide */ }
      if (xhr.status >= 200 && xhr.status < 300) ok(json);
      else ko(new ErreurApi(xhr.status, json));
    };
    xhr.onerror = () => ko(new ErreurApi(0, { erreur: 'reseau' }));
    const fd = new FormData();
    fd.append('fichier', fichier, fichier.name);
    xhr.send(fd);
  });
}
