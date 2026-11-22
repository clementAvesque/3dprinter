'use strict';
// Paiements et remboursements par Stripe (API HTTP directe, sans SDK).
//
// Réglages (fly secrets, jamais dans le code) :
//   STRIPE_CLE_SECRETE      sk_test_... (mode test) puis sk_live_... (réel)
//   STRIPE_SECRET_WEBHOOK   whsec_...   signature des webhooks (scripts/stripe_configurer.py)
// Sans eux, toute opération d'argent répond « paiement_non_configure » au lieu de faire semblant.
//
// Le montant payé est TOUJOURS calculé par le serveur (devis découpé par Orca), jamais par le navigateur.

const crypto = require('node:crypto');

class ErreurPaiement extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
    this.detail = detail;
  }
}

const TOLERANCE_WEBHOOK_S = 300;     // signature plus vieille que 5 min : refusée (rejeu)

// objet -> corps « application/x-www-form-urlencoded » à la façon de Stripe (a[b][0][c]=...)
function formulaire(obj, prefixe = '', paires = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const cle = prefixe ? `${prefixe}[${k}]` : k;
    if (typeof v === 'object') formulaire(v, cle, paires);
    else paires.push(`${encodeURIComponent(cle)}=${encodeURIComponent(String(v))}`);
  }
  return paires.join('&');
}

function creerPaiements(config, { fetch: fetchFn = globalThis.fetch } = {}) {
  const S = config.stripe || {};
  const configure = Boolean(S.cleSecrete && S.secretWebhook);
  const mode = !configure ? 'aucun' : S.cleSecrete.startsWith('sk_live_') ? 'reel' : 'test';

  async function appeler(chemin, corps, idempotence) {
    if (!configure) throw new ErreurPaiement('paiement_non_configure', 'Stripe n\'est pas encore branché');
    let rep;
    try {
      rep = await fetchFn(`${S.api}${chemin}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${S.cleSecrete}`, 'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': idempotence, 'Stripe-Version': S.version },
        body: formulaire(corps),
        signal: AbortSignal.timeout(20e3),
      });
    } catch (e) {
      throw new ErreurPaiement('paiement_indisponible', `Stripe injoignable : ${e.message}`);
    }
    const json = await rep.json().catch(() => ({}));
    if (!rep.ok) throw new ErreurPaiement('paiement_refuse', `Stripe (HTTP ${rep.status}) : ${json.error?.message || 'erreur'}`);
    return json;
  }

  return {
    configure,
    mode,

    // page de paiement Stripe pour une commande ; retourne { id, url }
    async creerSession({ commande, email, devis, urlSite }) {
      const s = await appeler('/v1/checkout/sessions', {
        mode: 'payment',
        locale: 'fr',
        customer_email: email,
        client_reference_id: String(commande.id),
        metadata: { commande_id: String(commande.id) },
        payment_intent_data: { metadata: { commande_id: String(commande.id) }, receipt_email: email },
        // une ligne par devis (commande groupée) + une seule livraison
        line_items: [
          ...devis.map((d) => ({ quantity: 1, price_data: { currency: 'eur', unit_amount: d.prix_matiere_cts,
            product_data: { name: `Impression 3D · devis ${d.uuid.slice(0, 8).toUpperCase()}`, description: `${d.poids_g} g de PLA (poids calculé par OrcaSlicer)` } } })),
          { quantity: 1, price_data: { currency: 'eur', unit_amount: commande.livraison_cts,
            product_data: { name: devis.length > 1 ? `Livraison groupée (${devis.length} devis)` : 'Livraison' } } },
        ],
        // adresses publiques (UUID) : le numéro interne de la commande ne sort pas du serveur
        success_url: `${urlSite}/merci?commande=${commande.uuid}`,
        cancel_url: devis.length > 1 ? `${urlSite}/compte` : `${urlSite}/devis/${devis[0].uuid}`,
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60,      // 1 h pour payer
      }, `session-commande-${commande.id}-${commande.cree_le}`);
      return { id: s.id, url: s.url };
    },

    // ferme une page de paiement encore ouverte (nouvel essai du client : pas de double paiement possible)
    async expirerSession(id) {
      return appeler(`/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {}, `expiration-${id}`);
    },

    // remboursement intégral d'une commande payée
    async rembourser(commande) {
      if (!commande.stripe_paiement_id) throw new ErreurPaiement('paiement_introuvable', `commande ${commande.id} sans paiement Stripe`);
      return appeler('/v1/refunds', { payment_intent: commande.stripe_paiement_id, metadata: { commande_id: String(commande.id) } },
        `remboursement-commande-${commande.id}`);
    },

    // vérifie l'en-tête Stripe-Signature (HMAC SHA-256 de "t.corps") ; retourne l'événement ou lève une erreur
    lireWebhook(corps, entete, maintenant = Date.now()) {
      if (!configure) throw new ErreurPaiement('paiement_non_configure');
      const parties = String(entete || '').split(',').map((p) => p.split('='));
      const t = Number(parties.find(([k]) => k === 't')?.[1]);
      const signatures = parties.filter(([k]) => k === 'v1').map(([, v]) => v);
      if (!Number.isInteger(t) || !signatures.length) throw new ErreurPaiement('signature_invalide', 'en-tête absent ou mal formé');
      if (Math.abs(maintenant / 1000 - t) > TOLERANCE_WEBHOOK_S) throw new ErreurPaiement('signature_invalide', 'signature trop ancienne');
      const attendu = crypto.createHmac('sha256', S.secretWebhook).update(`${t}.`).update(corps).digest();
      const ok = signatures.some((s) => /^[0-9a-f]{64}$/.test(s) && crypto.timingSafeEqual(Buffer.from(s, 'hex'), attendu));
      if (!ok) throw new ErreurPaiement('signature_invalide', 'signature incorrecte');
      return JSON.parse(corps.toString('utf8'));
    },
  };
}

module.exports = { creerPaiements, ErreurPaiement, formulaire };
