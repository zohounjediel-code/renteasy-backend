// Script à exécuter UNE SEULE FOIS pour corriger les échéances des contrats déjà actifs
// qui auraient été générées avec l'ancienne logique (toujours mensuelle).
//
// Utilisation : depuis renteasy-backend, lancer :
//   node scripts/regenererEcheances.js
//
// Ce script :
// 1. Pour chaque contrat actif, supprime les échéances FUTURES non payées ("en_attente")
//    qui ne correspondent pas à la bonne périodicité
// 2. Régénère les échéances correctement à partir d'aujourd'hui (ou de la date de début
//    si le contrat n'a pas encore démarré), en respectant le type de loyer et la durée
//
// Les échéances déjà payées, partielles ou impayées (passées) ne sont JAMAIS touchées.

require('dotenv').config();
const pool = require('../src/config/database');
const { creerEcheancesPourContrat } = require('../src/utils/echeances');

async function main() {
  const contrats = await pool.query(`SELECT * FROM contrats WHERE statut = 'actif'`);
  console.log(`${contrats.rows.length} contrat(s) actif(s) trouvé(s).`);

  for (const contrat of contrats.rows) {
    // Supprime uniquement les échéances futures non encore dues (jamais celles déjà passées/payées)
    const supprimees = await pool.query(
      `DELETE FROM echeances WHERE contrat_id = $1 AND statut = 'en_attente' AND date_limite >= CURRENT_DATE RETURNING id`,
      [contrat.id]
    );

    await creerEcheancesPourContrat(pool, contrat);

    console.log(
      `Contrat ${contrat.id} (${contrat.type_loyer}) : ${supprimees.rows.length} échéance(s) future(s) supprimée(s) et régénérée(s) correctement.`
    );
  }

  console.log('Terminé.');
  process.exit(0);
}

main().catch(err => {
  console.error('Erreur :', err);
  process.exit(1);
});
