<script setup>
// Espace compte : commandes, devis (commande groupée, publication dans la galerie), publications, adresses,
// fichiers gardés, profil (nom, pseudo), mot de passe, déconnexion et suppression du compte.
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSession } from '../stores/session.js';
import { api } from '../api.js';

const session = useSession();
const route = useRoute();
const routeur = useRouter();

const ONGLETS = [['commandes', 'Commandes'], ['devis', 'Devis'], ['galerie', 'Mes publications'], ['adresses', 'Adresses'],
  ['fichiers', 'Fichiers'], ['profil', 'Profil et sécurité']];
const onglet = computed(() => (ONGLETS.some(([k]) => k === route.query.onglet) ? route.query.onglet : 'commandes'));
const aller = (k) => routeur.replace({ query: { onglet: k } });

const devis = ref([]), commandes = ref([]), fichiers = ref([]), adresses = ref([]), publications = ref([]);
const erreur = ref(''), message = ref('');

const STATUTS_DEVIS = { attente: 'en file pour la découpe', decoupe: 'découpe en cours', pret: 'prêt', erreur: 'découpe impossible' };
const STATUTS_COMMANDE = {
  en_attente_paiement: 'en attente de paiement', abandonnee: 'abandonnée', payee: 'payée, en vérification',
  validee: 'validée, envoi à l\'impression', dans_un_lot: 'en attente d\'impression', en_impression: 'en cours d\'impression',
  suspendue: 'en préparation', imprimee: 'imprimée, bientôt envoyée', expediee: 'envoyée', livree: 'livrée', remboursee: 'remboursée',
};
// une commande se publie dans la galerie dès que l'atelier l'a validée (pas besoin d'attendre l'impression)
const PUBLIABLE = ['validee', 'dans_un_lot', 'en_impression', 'suspendue', 'imprimee', 'expediee', 'livree'];
const date = (ms) => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const euros = (cts) => `${(cts / 100).toFixed(2).replace('.', ',')} €`;
const PAYS = [['FR', 'France'], ['BE', 'Belgique'], ['CH', 'Suisse'], ['LU', 'Luxembourg'], ['MC', 'Monaco']];

function signaler(texte) { message.value = texte; erreur.value = ''; setTimeout(() => { if (message.value === texte) message.value = ''; }, 4000); }
async function essayer(fn) {
  erreur.value = '';
  try { return await fn(); } catch (e) { erreur.value = e.message; return undefined; }
}

async function charger() {
  await essayer(async () => {
    [devis.value, commandes.value, fichiers.value, adresses.value, publications.value] = await Promise.all([
      api('GET', '/devis'), api('GET', '/commandes'), api('GET', '/fichiers'), api('GET', '/adresses'), api('GET', '/publications')]);
  });
}
onMounted(charger);
watch(onglet, () => { erreur.value = ''; message.value = ''; });

// ---------------------------------------------------------------- devis : commande groupée
const commandable = (d) => d.statut === 'pret' && (!d.commande || ['en_attente_paiement', 'abandonnee'].includes(d.commande.statut));
const coches = ref([]);
const MAX_GROUPE = 5;
const nbCommandables = computed(() => devis.value.filter(commandable).length);
function commanderSelection() {
  if (coches.value.length) routeur.push(`/commande/${coches.value.join(',')}`);
}

// ---------------------------------------------------------------- galerie : publier un projet validé
const publiable = (d) => !d.galerie && !d.publication && d.statut === 'pret' && d.commande && PUBLIABLE.includes(d.commande.statut);
const publication = reactive({ devis: null, titre: '' });
function preparerPublication(d) {
  publication.devis = d.id;
  publication.titre = d.pieces.map((p) => p.nom.replace(/\.stl$/i, '')).slice(0, 2).join(' + ').slice(0, 60);
}
async function publier(d) {
  if (!session.client?.pseudo) { erreur.value = 'Choisis d\'abord un pseudo dans « Profil et sécurité » : il signe tes projets.'; return; }
  const r = await essayer(() => api('POST', `/devis/${d.id}/publier`, { titre: publication.titre.trim() }));
  if (!r) return;
  publication.devis = null;
  signaler(`« ${r.titre} » est dans la galerie, signé ${r.auteur}.`);
  await charger();
}
async function retirer(id) {
  if (!confirm('Retirer ce projet de la galerie ? Tu pourras le republier plus tard.')) return;
  if (await essayer(() => api('DELETE', `/publications/${id}`))) { signaler('Projet retiré de la galerie.'); await charger(); }
}
async function republier(p) {
  if (!confirm("Republier ce projet ? Les visiteurs pourront ouvrir ses fichiers STL dans leur atelier pour l'ajuster et le commander.")) return;
  if (await essayer(() => api('POST', `/devis/${p.devis_id}/publier`, { titre: p.titre }))) { signaler('Projet de nouveau visible.'); await charger(); }
}

// ---------------------------------------------------------------- fichiers
async function supprimerFichier(f) {
  if (!confirm(`Supprimer définitivement ${f.nom} ?`)) return;
  if (await essayer(() => api('DELETE', `/fichiers/${f.id}`))) fichiers.value = fichiers.value.filter((x) => x.id !== f.id);
}

// ---------------------------------------------------------------- adresses
const vide = () => ({ nom_complet: session.client?.nom || '', ligne1: '', ligne2: '', code_postal: '', ville: '', pays: 'FR', telephone: '' });
const adresse = reactive(vide());
const ajoutAdresse = ref(false);
async function ajouterAdresse() {
  const corps = Object.fromEntries(Object.entries(adresse).map(([k, v]) => [k, v.trim()]).filter(([k, v]) => v || k === 'pays'));
  if (await essayer(() => api('POST', '/adresses', corps))) {
    Object.assign(adresse, vide());
    ajoutAdresse.value = false;
    adresses.value = await api('GET', '/adresses');
    signaler('Adresse enregistrée.');
  }
}
async function supprimerAdresse(a) {
  if (!confirm('Supprimer cette adresse ?')) return;
  if (await essayer(() => api('DELETE', `/adresses/${a.id}`))) adresses.value = adresses.value.filter((x) => x.id !== a.id);
}

// ---------------------------------------------------------------- profil, mot de passe, compte
const profil = reactive({ nom: '', pseudo: '' });
watch(() => session.client, (c) => { profil.nom = c?.nom || ''; profil.pseudo = c?.pseudo || ''; }, { immediate: true });
async function enregistrerProfil() {
  const r = await essayer(() => api('PATCH', '/moi', { nom: profil.nom.trim(), pseudo: profil.pseudo.trim() || null }));
  if (r) { session.mettreAJour(r.client); signaler('Profil enregistré.'); }
}

const mdp = reactive({ ancien: '', nouveau: '', confirmation: '' });
async function changerMotDePasse() {
  if (mdp.nouveau !== mdp.confirmation) { erreur.value = 'Les deux nouveaux mots de passe ne sont pas identiques.'; return; }
  if (await essayer(() => api('PATCH', '/moi/mot-de-passe', { ancien: mdp.ancien, nouveau: mdp.nouveau }))) {
    Object.assign(mdp, { ancien: '', nouveau: '', confirmation: '' });
    signaler('Mot de passe changé. Tes autres appareils ont été déconnectés.');
  }
}

const suppression = reactive({ ouverte: false, motdepasse: '', sur: false });
async function supprimerCompte() {
  if (await essayer(() => api('DELETE', '/moi', { motdepasse: suppression.motdepasse }))) {
    session.mettreAJour(null);
    routeur.push('/');
  }
}

async function deconnexion() {
  await session.deconnexion();
  routeur.push('/');
}
</script>

<template>
  <main class="espace">
    <header class="haut">
      <div>
        <h1>Mon compte</h1>
        <p class="discret">{{ session.client?.nom }} · {{ session.client?.email }}<template v-if="session.client?.pseudo"> · pseudo <b>{{ session.client.pseudo }}</b></template></p>
      </div>
      <button class="secondaire" @click="deconnexion">Se déconnecter</button>
    </header>

    <div class="mise-en-page">
      <nav class="menu" aria-label="Rubriques du compte">
        <button v-for="[k, t] in ONGLETS" :key="k" type="button" :class="{ actif: onglet === k }" :aria-current="onglet === k ? 'page' : undefined"
                @click="aller(k)">
          {{ t }}
          <small v-if="k === 'commandes' && commandes.length">{{ commandes.length }}</small>
          <small v-else-if="k === 'devis' && devis.length">{{ devis.length }}</small>
          <small v-else-if="k === 'galerie' && publications.filter((p) => !p.retiree_le).length">{{ publications.filter((p) => !p.retiree_le).length }}</small>
        </button>
      </nav>

      <div class="rubrique">
        <p v-if="erreur" class="erreur" role="alert">{{ erreur }}</p>
        <p v-if="message" class="info" role="status">{{ message }}</p>

        <!-- commandes -->
        <section v-if="onglet === 'commandes'" class="carte">
          <h2>Commandes</h2>
          <p v-if="!commandes.length" class="discret">Aucune commande pour l'instant.</p>
          <ul class="liste">
            <li v-for="c in commandes" :key="c.id">
              <span>Commande {{ c.ref }} · {{ date(c.cree_le) }}<template v-if="c.devis_ids?.length > 1"> · {{ c.devis_ids.length }} devis</template></span>
              <small class="discret">{{ STATUTS_COMMANDE[c.statut] }}<template v-if="c.numero_suivi"> · suivi {{ c.numero_suivi }}</template></small>
              <b>{{ euros(c.total_cts) }}</b>
            </li>
          </ul>
        </section>

        <!-- devis -->
        <section v-else-if="onglet === 'devis'" class="carte">
          <h2>Devis</h2>
          <p v-if="!devis.length" class="discret">Aucun devis. <RouterLink to="/" class="lien">Dépose tes STL dans l'atelier</RouterLink> ou choisis un projet de la galerie.</p>
          <p v-else-if="nbCommandables > 1" class="discret">Un projet sur plusieurs devis ? Coche-les (5 au plus) pour les commander
            ensemble : un seul paiement et un seul colis.</p>
          <ul class="liste">
            <li v-for="d in devis" :key="d.id" class="ligne-devis">
              <div class="ligne">
                <label v-if="nbCommandables > 1" class="coche" :class="{ inactive: !commandable(d) }">
                  <input v-model="coches" type="checkbox" :value="d.id" :aria-label="`choisir le devis ${d.ref}`"
                         :disabled="!commandable(d) || (coches.length >= MAX_GROUPE && !coches.includes(d.id))">
                </label>
                <div class="grow">
                  <RouterLink :to="`/devis/${d.id}`" class="lien">Devis {{ d.ref }}</RouterLink>
                  <small v-if="d.galerie" class="origine"> · d'après « {{ d.galerie.titre }} » de {{ d.galerie.auteur }}</small>
                  <br><small class="discret">{{ date(d.cree_le) }} · {{ d.pieces.length }} fichier(s) · {{ STATUTS_DEVIS[d.statut] }}<template
                    v-if="d.commande && !['en_attente_paiement', 'abandonnee'].includes(d.commande.statut)"> · commande {{ d.commande.ref }}</template></small>
                </div>
                <b v-if="d.total_cts != null">{{ euros(d.prix_matiere_cts) }}</b>
                <span v-if="d.publication" class="pastille-galerie" title="visible dans la galerie">dans la galerie</span>
                <button v-else-if="publiable(d) && publication.devis !== d.id" class="secondaire petit" type="button" @click="preparerPublication(d)">
                  Publier dans la galerie
                </button>
              </div>
              <form v-if="publication.devis === d.id" class="publier" @submit.prevent="publier(d)">
                <label>Titre du projet<input v-model="publication.titre" maxlength="60" required placeholder="Ex. Support de vélo"></label>
                <p class="discret petit">Il sera visible par tous, signé
                  <b>{{ session.client?.pseudo || '(choisis d\'abord un pseudo dans Profil et sécurité)' }}</b>. Les visiteurs voient l'aperçu 3D
                  et peuvent ouvrir tes fichiers STL dans leur atelier pour les ajuster (taille, quantités, réglages) et les commander.
                  Tu peux le retirer à tout moment.</p>
                <div class="boutons">
                  <button class="primaire" :disabled="!session.client?.pseudo">Publier</button>
                  <button class="secondaire" type="button" @click="publication.devis = null">Annuler</button>
                </div>
              </form>
            </li>
          </ul>
          <button v-if="nbCommandables > 1" class="primaire commander" :disabled="!coches.length" @click="commanderSelection">
            Commander la sélection<template v-if="coches.length"> ({{ coches.length }} devis)</template>
          </button>
        </section>

        <!-- publications -->
        <section v-else-if="onglet === 'galerie'" class="carte">
          <h2>Mes publications</h2>
          <p class="discret">Tes projets, partagés dans la galerie sous ton pseudo. Pour en publier un, va dans <button class="lien"
            type="button" @click="aller('devis')">Devis</button> : le bouton apparaît dès que ta commande est validée par l'atelier.</p>
          <p v-if="!publications.length" class="discret">Aucune publication pour l'instant.</p>
          <ul class="liste">
            <li v-for="p in publications" :key="p.id">
              <span><b>{{ p.titre }}</b><br><small class="discret">devis {{ p.devis_ref }} · publié le {{ date(p.cree_le) }}<template v-if="p.choisie">
                · choisi {{ p.choisie }} fois</template></small></span>
              <template v-if="p.retiree_le">
                <small class="discret">retiré</small>
                <button class="secondaire petit" type="button" @click="republier(p)">Republier</button>
              </template>
              <button v-else class="secondaire petit" type="button" @click="retirer(p.id)">Retirer</button>
            </li>
          </ul>
        </section>

        <!-- adresses -->
        <section v-else-if="onglet === 'adresses'" class="carte">
          <div class="titre-ligne">
            <h2>Adresses de livraison</h2>
            <button v-if="!ajoutAdresse" class="secondaire petit" type="button" @click="ajoutAdresse = true">Ajouter une adresse</button>
          </div>
          <p v-if="!adresses.length && !ajoutAdresse" class="discret">Aucune adresse enregistrée : elle te sera demandée à ta première commande.</p>
          <ul class="liste">
            <li v-for="a in adresses" :key="a.id">
              <span><b>{{ a.nom_complet }}</b><br><small class="discret">{{ a.ligne1 }}<template v-if="a.ligne2">, {{ a.ligne2 }}</template>,
                {{ a.code_postal }} {{ a.ville }} ({{ a.pays }})<template v-if="a.telephone"> · {{ a.telephone }}</template></small></span>
              <button class="icone" aria-label="supprimer cette adresse" title="supprimer" @click="supprimerAdresse(a)">✕</button>
            </li>
          </ul>
          <form v-if="ajoutAdresse" class="formulaire-compte" @submit.prevent="ajouterAdresse">
            <label class="large">Nom complet<input v-model="adresse.nom_complet" maxlength="100" required autocomplete="name"></label>
            <label class="large">Adresse<input v-model="adresse.ligne1" maxlength="150" required autocomplete="address-line1"></label>
            <label class="large">Complément <small class="discret">(facultatif)</small><input v-model="adresse.ligne2" maxlength="150" autocomplete="address-line2"></label>
            <label>Code postal<input v-model="adresse.code_postal" maxlength="10" required autocomplete="postal-code"></label>
            <label>Ville<input v-model="adresse.ville" maxlength="80" required autocomplete="address-level2"></label>
            <label>Pays<select v-model="adresse.pays" autocomplete="country"><option v-for="[c, n] in PAYS" :key="c" :value="c">{{ n }}</option></select></label>
            <label>Téléphone <small class="discret">(facultatif)</small><input v-model="adresse.telephone" maxlength="20" inputmode="tel" autocomplete="tel"></label>
            <div class="boutons large">
              <button class="primaire">Enregistrer</button>
              <button class="secondaire" type="button" @click="ajoutAdresse = false">Annuler</button>
            </div>
          </form>
        </section>

        <!-- fichiers -->
        <section v-else-if="onglet === 'fichiers'" class="carte">
          <h2>Mes fichiers</h2>
          <p class="discret">Les fichiers jamais commandés sont supprimés au bout de 30 jours, ceux d'une commande au bout de 2 ans
            (et pas tant qu'un projet publié s'en sert). Tu peux les supprimer avant, sauf pendant qu'une commande en a besoin ;
            supprimer le fichier d'un projet publié le retire de la galerie.</p>
          <p v-if="!fichiers.length" class="discret">Aucun fichier gardé.</p>
          <ul class="liste">
            <li v-for="f in fichiers" :key="f.id">
              <span>{{ f.nom }}</span>
              <small class="discret">supprimé le {{ date(f.expire_le) }}</small>
              <button class="icone" aria-label="supprimer" title="supprimer" @click="supprimerFichier(f)">✕</button>
            </li>
          </ul>
        </section>

        <!-- profil et sécurité -->
        <template v-else-if="onglet === 'profil'">
          <section class="carte">
            <h2>Profil</h2>
            <form class="formulaire-compte" @submit.prevent="enregistrerProfil">
              <label>Nom<small class="discret">pour les livraisons et les e-mails</small><input v-model="profil.nom" maxlength="80" required autocomplete="name"></label>
              <label>Pseudo<small class="discret">signe tes projets dans la galerie (unique)</small>
                <input v-model="profil.pseudo" maxlength="24" placeholder="Ex. Clem_3D" autocomplete="nickname"></label>
              <p class="discret petit large">E-mail : {{ session.client?.email }}</p>
              <div class="boutons large"><button class="primaire">Enregistrer</button></div>
            </form>
          </section>

          <section class="carte">
            <h2>Mot de passe</h2>
            <form class="formulaire-compte" @submit.prevent="changerMotDePasse">
              <label class="large">Mot de passe actuel<input v-model="mdp.ancien" type="password" required autocomplete="current-password"></label>
              <label>Nouveau mot de passe<input v-model="mdp.nouveau" type="password" required minlength="12" autocomplete="new-password"></label>
              <label>Confirmation<input v-model="mdp.confirmation" type="password" required minlength="12" autocomplete="new-password"></label>
              <p class="discret petit large">12 caractères au moins. Tes autres appareils seront déconnectés.</p>
              <div class="boutons large"><button class="primaire">Changer le mot de passe</button></div>
            </form>
          </section>

          <section class="carte danger">
            <h2>Supprimer mon compte</h2>
            <p class="discret">Efface ton compte, tes fichiers, tes devis non commandés, tes adresses et tes publications. Tes commandes passées
              et leurs factures sont gardées anonymement (obligation comptable). Impossible pendant une commande en cours. Définitif.</p>
            <button v-if="!suppression.ouverte" class="secondaire rouge" type="button" @click="suppression.ouverte = true">Supprimer mon compte…</button>
            <form v-else class="formulaire-compte" @submit.prevent="supprimerCompte">
              <label class="large">Ton mot de passe<input v-model="suppression.motdepasse" type="password" required autocomplete="current-password"></label>
              <label class="case large"><input v-model="suppression.sur" type="checkbox"> Je comprends que c'est définitif.</label>
              <div class="boutons large">
                <button class="rouge plein" :disabled="!suppression.sur || !suppression.motdepasse">Supprimer définitivement</button>
                <button class="secondaire" type="button" @click="Object.assign(suppression, { ouverte: false, motdepasse: '', sur: false })">Annuler</button>
              </div>
            </form>
          </section>
        </template>
      </div>
    </div>
  </main>
</template>

<style scoped>
.espace { width: 100%; max-width: 1100px; margin: 0 auto; padding: 28px 20px 40px; display: flex; flex-direction: column; gap: 20px; }
.haut { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.haut h1 { margin: 0 0 4px; }
.haut p { margin: 0; }
.mise-en-page { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 20px; align-items: start; }
.menu { position: sticky; top: 76px; display: flex; flex-direction: column; gap: 4px; }
.menu button { display: flex; justify-content: space-between; align-items: center; gap: 8px; text-align: left; border: 0; background: transparent;
  padding: 10px 12px; color: var(--discret); }
.menu button:hover { background: var(--fond-champ); color: var(--texte); }
.menu button.actif { background: var(--fond-carte); color: var(--texte); font-weight: 600; box-shadow: inset 3px 0 0 var(--accent), 0 1px 3px rgba(0, 0, 0, .08); }
.menu small { min-width: 22px; padding: 0 6px; border-radius: 999px; background: var(--fond-champ); text-align: center; font-size: 12px; color: var(--discret); }
.rubrique { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.titre-ligne { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.titre-ligne h2 { margin: 0; }
.ligne-devis { flex-direction: column; align-items: stretch !important; }
.ligne { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.grow { flex: 1; min-width: 0; }
.origine { color: var(--accent); }
.coche { display: flex; align-items: center; }
.coche input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
.coche.inactive { opacity: .35; }
.commander { align-self: flex-start; margin-top: 10px; }
.pastille-galerie { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; color: var(--ok);
  background: color-mix(in srgb, var(--ok) 12%, transparent); }
button.petit { padding: 6px 12px; font-size: 14px; }
.petit { font-size: 13px; margin: 0; }
.publier { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 12px; background: var(--fond-champ); }
.publier label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
.boutons { display: flex; gap: 8px; flex-wrap: wrap; }
.formulaire-compte { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; margin-top: 6px; }
.formulaire-compte label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; min-width: 0; }
.formulaire-compte label small { font-size: 12px; }
.formulaire-compte .large { grid-column: 1 / -1; }
.formulaire-compte select { padding: 10px 12px; border-radius: 10px; border: 1px solid var(--bord-fort); background: var(--fond-champ); }
.case { flex-direction: row !important; align-items: center; gap: 8px !important; }
.case input { width: 18px; height: 18px; accent-color: var(--danger); }
.danger { border-color: color-mix(in srgb, var(--danger) 35%, var(--bord)); }
button.rouge { color: var(--danger); }
button.rouge:hover:not(:disabled) { border-color: var(--danger); }
button.rouge.plein { background: var(--danger); border-color: var(--danger); color: #fff; font-weight: 600; }

@media (max-width: 760px) {
  .espace { padding: 20px 16px 32px; }
  .mise-en-page { grid-template-columns: minmax(0, 1fr); }
  .menu { position: static; flex-direction: row; overflow-x: auto; padding-bottom: 4px; scrollbar-width: thin; }
  .menu button { white-space: nowrap; flex: none; }
  .menu button.actif { box-shadow: inset 0 -3px 0 var(--accent); }
  .formulaire-compte { grid-template-columns: minmax(0, 1fr); }
}
</style>
