// Page « Mon profil » : identité, changement de mot de passe, appareils connectés, codes de secours.
const ROLES = { lecteur: 'Lecteur', operateur: 'Opérateur', admin: 'Administrateur' };

async function demarrer() {
  const me = await api('GET', '/me');
  if (!me.ok) return;                                    // 401 : commun.js renvoie à la connexion
  memoriserCsrf(me.json.csrf);
  const u = me.json.utilisateur;
  $('nom').textContent = u.nom;
  $('email').textContent = u.email;
  $('mdp-compte').value = u.email;
  $('initiale').textContent = (u.nom || u.email).trim().charAt(0).toUpperCase();
  $('role').textContent = ROLES[u.role] || u.role;
  chargerSessions();
  chargerSecours();
}

// ---------------------------------------------------------------- mot de passe

const regles = () => {
  const n = $('mdp-nouveau').value, c = $('mdp-confirme').value, a = $('mdp-ancien').value;
  return {
    'r-longueur': n.length >= 12,
    'r-varie': new Set(n).size >= 5,
    'r-pareil': n !== '' && n === c,
    'r-change': n !== '' && n !== a,
  };
};

function verifier() {
  const r = regles();
  for (const [id, ok] of Object.entries(r)) $(id).classList.toggle('ok', ok);
  $('btn-mdp').disabled = !$('mdp-ancien').value || !Object.values(r).every(Boolean);
}
['mdp-ancien', 'mdp-nouveau', 'mdp-confirme'].forEach((id) => $(id).addEventListener('input', () => {
  $('mdp-erreur').hidden = true;
  $('mdp-ok').hidden = true;
  verifier();
}));

$('mdp-voir').addEventListener('change', () => {
  const type = $('mdp-voir').checked ? 'text' : 'password';
  ['mdp-ancien', 'mdp-nouveau', 'mdp-confirme'].forEach((id) => { $(id).type = type; });
});

$('form-mdp').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('btn-mdp').disabled = true;
  $('btn-mdp').textContent = 'Vérification…';
  const r = await api('PATCH', '/me/password', { ancien: $('mdp-ancien').value, nouveau: $('mdp-nouveau').value });
  $('btn-mdp').textContent = 'Changer le mot de passe';
  if (!r.ok) {
    const e = r.json?.erreur;
    $('mdp-erreur').textContent = e === 'ancien_mot_de_passe_invalide' ? 'Le mot de passe actuel est incorrect.'
      : e === 'mot_de_passe_refuse' ? `Nouveau mot de passe refusé : ${r.json.detail}.` : texteErreur(r.json);
    $('mdp-erreur').hidden = false;
    if (e === 'ancien_mot_de_passe_invalide') $('mdp-ancien').select();
    return verifier();
  }
  // les mots de passe ne restent pas dans la page
  ['mdp-ancien', 'mdp-nouveau', 'mdp-confirme'].forEach((id) => { $(id).value = ''; });
  $('mdp-voir').checked = false;
  $('mdp-voir').dispatchEvent(new Event('change'));
  $('mdp-ok').hidden = false;
  verifier();
  chargerSessions();                                     // les autres sessions viennent d'être fermées
});

// ---------------------------------------------------------------- appareils connectés

function appareil(ua = '') {
  const nav = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//.test(ua) ? 'curl' : 'Navigateur';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${nav} · ${os}` : nav;
}

function depuis(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'à l\'instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function chargerSessions() {
  const r = await api('GET', '/me/sessions');
  if (!r.ok) return;
  $('nb-sessions').textContent = `${r.json.length} appareil${r.json.length > 1 ? 's' : ''}`;
  $('sessions').replaceChildren(...r.json.map((s) => {
    const li = document.createElement('li');
    const texte = document.createElement('div');
    texte.className = 'grow';
    const titre = document.createElement('p');
    titre.className = 'fichier-en-cours';
    titre.textContent = appareil(s.agent_nav || '');
    const info = document.createElement('p');
    info.className = 'muted small';
    info.textContent = `${s.ip || 'IP inconnue'} · actif ${depuis(s.vu)} · connecté ${depuis(s.cree)}`;
    texte.append(titre, info);
    li.append(texte);
    if (s.courante) {
      const b = document.createElement('span');
      b.className = 'badge READY';
      b.textContent = 'cet appareil';
      li.append(b);
    } else {
      const b = document.createElement('button');
      b.className = 'fantome danger';
      b.textContent = 'Déconnecter';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const d = await api('DELETE', `/me/sessions/${encodeURIComponent(s.pub_id)}`);
        if (!d.ok) { b.disabled = false; return toast(texteErreur(d.json), true); }
        toast('Appareil déconnecté');
        chargerSessions();
      });
      li.append(b);
    }
    return li;
  }));
}

// ---------------------------------------------------------------- codes de secours

async function chargerSecours() {
  const r = await api('GET', '/me/2fa');
  if (!r.ok) return;
  const n = r.json.codes_secours_restants;
  $('nb-secours').textContent = `${n} restant${n > 1 ? 's' : ''}`;
  $('nb-secours').className = `badge ${n === 0 ? 'ERROR' : n <= 3 ? 'BREAK' : 'READY'}`;
}

$('btn-secours').addEventListener('click', async () => {
  if (!confirm('Générer de nouveaux codes ? Les anciens ne marcheront plus.')) return;
  $('btn-secours').disabled = true;
  const r = await api('POST', '/me/2fa/codes-secours', {});   // demande le code 2FA si besoin
  $('btn-secours').disabled = false;
  if (!r.ok) return r.json?.erreur === 'annule' ? null : toast(texteErreur(r.json), true);
  $('secours-liste').replaceChildren(...r.json.codes_secours.map((c) => {
    const li = document.createElement('li');
    li.textContent = c;
    return li;
  }));
  $('secours-nouveaux').hidden = false;
  chargerSecours();
});

$('btn-copier').addEventListener('click', async () => {
  const codes = [...$('secours-liste').children].map((li) => li.textContent).join('\n');
  try { await navigator.clipboard.writeText(codes); toast('Codes copiés'); } catch { toast('Copie impossible : recopie-les à la main', true); }
});

// ---------------------------------------------------------------- divers

$('conf-annuler').addEventListener('click', () => $('confirmation').close());
$('deconnexion').addEventListener('click', async () => {
  await api('POST', '/auth/logout', {});
  memoriserCsrf('');
  location.href = PAGE_CONNEXION;
});

demarrer();
