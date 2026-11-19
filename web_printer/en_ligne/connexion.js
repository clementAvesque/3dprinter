// Connexion en deux étapes : mot de passe, puis code 2FA (ou code de secours).
let secours = false;

function erreur(id, texte) {
  $(id).textContent = texte;
  $(id).hidden = !texte;
}

$('etape-mdp').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  erreur('erreur-mdp', '');
  $('btn-mdp').disabled = true;
  const r = await api('POST', '/auth/login', { email: $('email').value.trim(), motdepasse: $('motdepasse').value });
  $('btn-mdp').disabled = false;
  if (!r.ok) return erreur('erreur-mdp', texteErreur(r.json));
  memoriserCsrf(r.json.csrf);
  $('motdepasse').value = '';                     // le mot de passe ne reste pas dans la page
  $('etape-mdp').hidden = true;
  $('etape-code').hidden = false;
  $('code').focus();
});

$('etape-code').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  erreur('erreur-code', '');
  const code = secours ? $('secours').value.trim() : $('code').value.trim();
  if (!code) return;
  $('btn-code').disabled = true;
  const r = await api('POST', '/auth/2fa', { code });
  $('btn-code').disabled = false;
  if (!r.ok) {
    // l'étape 2FA dure 5 min : au-delà, on recommence au mot de passe
    if (r.statut === 401 && r.json?.erreur === 'non_connecte') {
      retour();
      return erreur('erreur-mdp', 'Délai dépassé (5 min) : recommence.');
    }
    $('code').value = '';
    return erreur('erreur-code', texteErreur(r.json));
  }
  memoriserCsrf(r.json.csrf);
  location.href = 'index.html';
});

// chiffres seulement ; l'envoi se fait avec « Se connecter » (ou Entrée)
$('code').addEventListener('input', () => {
  $('code').value = $('code').value.replace(/\D/g, '').slice(0, 6);
});

$('lien-secours').addEventListener('click', () => {
  secours = !secours;
  $('champ-secours').hidden = !secours;
  $('code').closest('label').hidden = secours;
  $('code').required = !secours;
  $('lien-secours').textContent = secours ? 'Utiliser le code de l\'application' : 'Je n\'ai pas mon téléphone : utiliser un code de secours';
  (secours ? $('secours') : $('code')).focus();
});

function retour() {
  $('etape-code').hidden = true;
  $('etape-mdp').hidden = false;
  $('motdepasse').focus();
}
$('lien-retour').addEventListener('click', retour);

// déjà connecté : directement à l'application
api('GET', '/me').then((r) => { if (r.ok) { memoriserCsrf(r.json.csrf); location.href = 'index.html'; } });
