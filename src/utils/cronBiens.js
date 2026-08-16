const pool = require('../config/database');
const { completerEcheancesContratsActifs } = require('./echeances');
const { detecterFinsDeContrat, escaladerDemandesBloquees } = require('../controllers/demandeController');
const { enregistrerErreur } = require('./erreurs');
const { obtenirTauxCommission } = require('./parametres');
const { verifierAlerteCautionFaible, notifierCautionFaible } = require('./caution');
const { notifier } = require('./notifications');

// Pour chaque échéance qui vient de passer "impayée", couvre automatiquement ce qui est dû par
// la caution du contrat, si elle en a — le propriétaire est payé exactement comme pour un
// paiement classique (même commission RentEasy), seule la source de l'argent change. Sépare
// volontairement le mouvement d'argent (transaction) de la notification (après coup), comme
// partout ailleurs où de l'argent bouge.
async function couvrirImpayesParCaution(echeanceIds) {
  if (echeanceIds.length === 0) return;

  const tauxCommission = await obtenirTauxCommission();
  const superAdminRes = await pool.query("SELECT id FROM users WHERE role LIKE '%super_admin%' ORDER BY created_at ASC LIMIT 1");
  const superAdminId = superAdminRes.rows[0]?.id;
  if (!superAdminId) {
    console.error('[caution] Compte super admin introuvable, déductions caution suspendues ce passage');
    return;
  }

  for (const echeanceId of echeanceIds) {
    try {
      const contexte = await pool.query(
        `SELECT e.id, e.montant_du, e.contrat_id, c.caution_solde, b.proprietaire_id, b.numero_bien
         FROM echeances e
         JOIN contrats c ON c.id = e.contrat_id
         JOIN biens b ON b.id = c.bien_id
         WHERE e.id = $1`,
        [echeanceId]
      );
      if (contexte.rows.length === 0) continue;
      const e = contexte.rows[0];
      if (e.caution_solde <= 0) continue;

      const dejaPayeRes = await pool.query(
        `SELECT COALESCE(SUM(montant), 0) AS total FROM paiements WHERE echeance_id = $1 AND statut = 'reussi'`,
        [echeanceId]
      );
      const reste = e.montant_du - parseInt(dejaPayeRes.rows[0].total, 10);
      if (reste <= 0) continue;

      const montantCouvert = Math.min(reste, e.caution_solde);
      const commission = Math.round(montantCouvert * tauxCommission);
      const partProprietaire = montantCouvert - commission;

      const client = await pool.connect();
      let nouveauStatut;
      try {
        await client.query('BEGIN');

        await client.query('UPDATE contrats SET caution_solde = caution_solde - $1 WHERE id = $2', [montantCouvert, e.contrat_id]);
        await client.query('UPDATE users SET solde = solde + $1 WHERE id = $2', [partProprietaire, e.proprietaire_id]);
        await client.query('UPDATE users SET solde = solde + $1 WHERE id = $2', [commission, superAdminId]);

        await client.query(
          `INSERT INTO paiements (echeance_id, montant, methode, commission_renteasy, statut)
           VALUES ($1, $2, 'caution', $3, 'reussi')`,
          [echeanceId, montantCouvert, commission]
        );
        await client.query(
          `INSERT INTO caution_mouvements (contrat_id, type, montant, echeance_id) VALUES ($1, 'deduction', $2, $3)`,
          [e.contrat_id, montantCouvert, echeanceId]
        );

        nouveauStatut = montantCouvert >= reste ? 'payee' : 'partielle';
        await client.query('UPDATE echeances SET statut = $1 WHERE id = $2', [nouveauStatut, echeanceId]);

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const infoAlerte = await verifierAlerteCautionFaible(pool, e.contrat_id);
      await notifierCautionFaible(infoAlerte);

      const proprietaireInfo = await pool.query('SELECT nom, email FROM users WHERE id = $1', [e.proprietaire_id]);
      await notifier({
        user_id: e.proprietaire_id,
        email: proprietaireInfo.rows[0]?.email,
        nom: proprietaireInfo.rows[0]?.nom,
        titre: 'Loyer impayé couvert par la caution',
        message: `Le loyer impayé de ${montantCouvert.toLocaleString('fr-FR')} FCFA pour le bien ${e.numero_bien} a été prélevé sur la caution du locataire, faute de paiement.`,
        type: 'paiement',
        lien: '/paiements',
      });

      console.log(`[caution] Échéance ${echeanceId} couverte par la caution du contrat ${e.contrat_id} (${montantCouvert} FCFA)`);
    } catch (err) {
      console.error(`[caution] Erreur déduction échéance ${echeanceId} :`, err.message);
    }
  }
}

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

    // Tente de couvrir chacune de ces échéances par la caution du contrat, si disponible.
    await couvrirImpayesParCaution(versImpayee.rows.map(r => r.id));

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
