const { envoyerRappelsEcheances } = require('./rappelsEcheances');

// Une fois par jour suffit — contrairement aux crons de paiement (toutes les 20s), les rappels
// sont à la granularité du jour, pas de la minute. On tourne aussi au démarrage pour ne pas
// attendre 24h après un déploiement avant le premier passage (sans risque de double-envoi : la
// table rappels_echeances_envoyes rend chaque rappel idempotent, cf. rappelsEcheances.js).
function demarrerCronRappelsEcheances() {
  envoyerRappelsEcheances();
  setInterval(envoyerRappelsEcheances, 24 * 60 * 60 * 1000);
}

module.exports = { demarrerCronRappelsEcheances };
