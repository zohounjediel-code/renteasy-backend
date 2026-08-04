const { verifierTransactionsEnCoursPeriodique } = require('../controllers/soldeController');

// Sans ce job, une transaction de solde (recharge ou retrait) ne se finalisait jamais tant
// que personne ne rappelait manuellement GET /solde/transactions/:id/verifier — ce qui
// n'arrive jamais dans le frontend actuel (aucun polling, aucun bouton "vérifier"). Résultat :
// une recharge réussie côté opérateur ne créditait jamais le solde, et un retrait échoué
// n'était jamais remboursé. Ce cron reprend automatiquement toutes les transactions "en_cours".
//
// Intervalle court (20s) volontairement différent du cron biens (1h) : une confirmation
// Mobile Money se joue en dizaines de secondes, pas en heures — l'utilisateur qui vient de
// confirmer sur son téléphone doit voir son solde se mettre à jour rapidement.
function demarrerCronSolde() {
  verifierTransactionsEnCoursPeriodique();
  setInterval(verifierTransactionsEnCoursPeriodique, 20 * 1000);
}

module.exports = { demarrerCronSolde };
