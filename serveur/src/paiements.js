'use strict';
// Paiements et remboursements (Stripe). Étape 4 de la conception : tant que Stripe n'est pas branché,
// toute opération d'argent répond « paiement_non_configure » au lieu de faire semblant.

class ErreurPaiement extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
    this.detail = detail;
  }
}

function creerPaiements() {
  return {
    configure: false,
    async rembourser() {
      throw new ErreurPaiement('paiement_non_configure', 'Stripe n\'est pas encore branché (étape 4)');
    },
  };
}

module.exports = { creerPaiements, ErreurPaiement };
