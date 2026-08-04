const pool = require('../config/database');
const { completerEcheancesContratsActifs } = require('./echeances');
const { detecterFinsDeContrat, escaladerDemandesBloquees } = require('../controllers/demandeController');
const { enregistrerErreur } = require('./erreurs');

// Met à jour le statut des biens en fonction des contrats actifs dont la période
// couvre la date du jour. Un bien devient "occupé" (et sort du marché) dès que la
// date de début d'un contrat actif arrive, et redevient "libre" dès que la période
// se termine (sans être remis sur le marché automatiquement).
async function mettreAJourStatutsBiens() {
  try {
    // Fait passer en "impayée" toute échéance encore "en_attente" dont la date limite est dépassée
    const versImpayee = await pool.query(`
      UPDATE echeances SET statut = 'impayee'
      WHERE statut = 'en_attente' AND date_limite < CURRENT_DATE
      RETURNING id
    `);
    if (versImpayee.rows.length > 0) {
      console.log(`[cron biens] ${versImpayee.rows.length} échéance(s) passée(s) en impayée`);
    }

    const versOccupe = await pool.query(`
      UPDATE biens b SET statut = 'occupe', sur_le_marche = false, description_marche = NULL, updated_at = NOW()
      WHERE b.statut != 'occupe'
        AND EXISTS (
          SELECT 1 FROM contrats c
          WHERE c.bien_id = b.id AND c.statut = 'actif'
            AND c.date_debut <= CURRENT_DATE
            AND (c.date_fin IS NULL OR c.date_fin >= CURRENT_DATE)
        )
      RETURNING b.id, b.numero_bien
    `);

    const versLibre = await pool.query(`
      UPDATE biens b SET statut = 'libre', updated_at = NOW()
      WHERE b.statut = 'occupe'
        AND NOT EXISTS (
          SELECT 1 FROM contrats c
          WHERE c.bien_id = b.id AND c.statut = 'actif'
            AND c.date_debut <= CURRENT_DATE
            AND (c.date_fin IS NULL OR c.date_fin >= CURRENT_DATE)
        )
      RETURNING b.id, b.numero_bien
    `);

    if (versOccupe.rows.length > 0 || versLibre.rows.length > 0) {
      console.log(
        `[cron biens] ${versOccupe.rows.length} bien(s) passé(s) occupé, ${versLibre.rows.length} bien(s) passé(s) libre`
      );
    }

    await completerEcheancesContratsActifs(pool);
    await detecterFinsDeContrat(pool);
    await escaladerDemandesBloquees(pool);
  } catch (err) {
    enregistrerErreur({ erreur: err });
  }
}

// Lance la vérification immédiatement au démarrage, puis toutes les heures
// (suffisant pour refléter le changement de jour sans dépendance supplémentaire).
function demarrerCronBiens() {
  mettreAJourStatutsBiens();
  setInterval(mettreAJourStatutsBiens, 60 * 60 * 1000);
}

module.exports = { mettreAJourStatutsBiens, demarrerCronBiens };
