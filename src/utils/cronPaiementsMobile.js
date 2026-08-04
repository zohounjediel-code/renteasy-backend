const { verifierPaiementsMobileEnCoursPeriodique } = require('../controllers/mobilemoneyController');

// Même raisonnement et même intervalle que cronSolde.js : un paiement de loyer Mobile Money ne
// se finalisait jamais tant que personne ne rappelait manuellement GET /mobilemoney/statut/:reference
// — ce qui n'arrive que si le locataire reste sur l'écran de paiement jusqu'à la confirmation.
// S'il ferme l'app juste après avoir validé sur son téléphone, le paiement restait "en_cours"
// indéfiniment : le propriétaire n'était jamais crédité, personne n'était notifié. Ce cron
// reprend automatiquement tous les paiements Mobile Money "en_cours".
function demarrerCronPaiementsMobile() {
  verifierPaiementsMobileEnCoursPeriodique();
  setInterval(verifierPaiementsMobileEnCoursPeriodique, 20 * 1000);
}

module.exports = { demarrerCronPaiementsMobile };
