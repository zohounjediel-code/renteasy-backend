const pool = require('../config/database');
const { enregistrerErreur } = require('../utils/erreurs');
const { demanderPaiementMTN, verifierStatutMTN } = require('../utils/mtnMomo');
const { demanderPaiementMoov, verifierStatutMoov, demanderPaiementCeltiis, verifierStatutCeltiis } = require('../utils/moovCeltiis');
const { genererQuittancePDF } = require('../utils/quittance');
const { notifier, echapperHtml } = require('../utils/notifications');
const { obtenirTauxCommission } = require('../utils/parametres');

// Initier un paiement Mobile Money
// Le locataire reçoit une notification push sur son téléphone et confirme
async function initierPaiementMobile(req, res) {
  const { echeance_id, methode, telephone_payeur } = req.body;

  if (!echeance_id || !methode || !telephone_payeur) {
    return res.status(400).json({
      message: 'Champs requis : echeance_id, methode (mtn_momo | moov_money | celtiis_pay), telephone_payeur',
    });
  }

  const methodesAutorisees = ['mtn_momo', 'moov_money', 'celtiis_pay'];
  if (!methodesAutorisees.includes(methode)) {
    return res.status(400).json({ message: `Méthode invalide. Utilisez : ${methodesAutorisees.join(', ')}` });
  }

  try {
    // Récupère le contexte de l'échéance
    const contexte = await pool.query(
      `SELECT e.*, c.loyer_mensuel, b.adresse, b.proprietaire_id, l.nom AS locataire_nom
       FROM echeances e
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE e.id = $1`,
      [echeance_id]
    );

    if (contexte.rows.length === 0) {
      return res.status(404).json({ message: 'Échéance non trouvée' });
    }

    const echeance = contexte.rows[0];

    if (req.user.role === 'proprietaire' && echeance.proprietaire_id !== req.user.id) {
      return res.status(403).json({ message: 'Accès non autorisé' });
    }

    if (echeance.statut === 'payee') {
      return res.status(409).json({ message: 'Cette échéance est déjà payée' });
    }

    // Ne jamais redemander le montant total si des paiements partiels ont déjà été réglés
    // (ex: une tranche payée en espèces ou via le solde RentEasy) — sans ce calcul, le mobile
    // money redemandait systématiquement le montant_du complet, quel que soit le reste réel dû.
    const totalPayeRes = await pool.query(
      `SELECT COALESCE(SUM(montant), 0) AS total FROM paiements WHERE echeance_id = $1 AND statut = 'reussi'`,
      [echeance_id]
    );
    const dejaPaye = parseInt(totalPayeRes.rows[0].total, 10);
    const reste = echeance.montant_du - dejaPaye;

    if (reste <= 0) {
      return res.status(409).json({ message: 'Cette échéance est déjà entièrement payée' });
    }

    const montant = reste;
    const description = `Loyer ${new Date(echeance.mois_concerne).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })} - ${echeance.adresse}`;

    let referenceTransaction;

    // Aiguillage selon l'opérateur
    if (methode === 'mtn_momo') {
      referenceTransaction = await demanderPaiementMTN({
        montant,
        telephone: telephone_payeur,
        description,
      });
    } else if (methode === 'moov_money') {
      const result = await demanderPaiementMoov({ montant, telephone: telephone_payeur, description });
      referenceTransaction = result.reference || result.transactionId;
    } else if (methode === 'celtiis_pay') {
      const result = await demanderPaiementCeltiis({ montant, telephone: telephone_payeur, description });
      referenceTransaction = result.reference || result.transactionId;
    }

    // Crée un paiement en statut "en_cours" dans la base
    const tauxCommission = await obtenirTauxCommission();
    await pool.query(
      `INSERT INTO paiements (echeance_id, montant, methode, reference_transaction, commission_renteasy, statut)
       VALUES ($1, $2, $3, $4, $5, 'en_cours')`,
      [echeance_id, montant, methode, referenceTransaction, Math.round(montant * tauxCommission)]
    );

    return res.status(202).json({
      message: 'Demande de paiement envoyée. Le locataire va recevoir une notification sur son téléphone.',
      reference_transaction: referenceTransaction,
      montant,
      methode,
    });
  } catch (err) {
    console.error('Erreur initiation paiement mobile :', err.message);
    return res.status(500).json({ message: 'Erreur lors de l\'initiation du paiement : ' + err.message });
  }
}

// Vérifier le statut d'un paiement Mobile Money (à appeler après que le locataire a confirmé)
async function verifierPaiementMobile(req, res) {
  const { reference } = req.params;
  const { methode } = req.query;

  if (!methode) {
    return res.status(400).json({ message: 'Paramètre requis : methode (mtn_momo | moov_money | celtiis_pay)' });
  }

  try {
    const resultat = await finaliserPaiementMobile({ reference, methode });
    return res.json(resultat);
  } catch (err) {
    console.error('Erreur vérification paiement mobile :', err.message);
    return res.status(500).json({ message: 'Erreur lors de la vérification : ' + err.message });
  }
}

// Logique de finalisation, factorisée pour être appelée aussi bien par la route ci-dessus
// (déclenchée par le frontend pendant que la personne regarde son écran de paiement) que par le
// job périodique ci-dessous (verifierPaiementsMobileEnCoursPeriodique), qui rattrape les
// paiements dont la confirmation n'a jamais été redemandée — cf. commentaire sur ce job.
async function finaliserPaiementMobile({ reference, methode }) {
  let resultatOperateur;

  if (methode === 'mtn_momo') {
    resultatOperateur = await verifierStatutMTN(reference);
  } else if (methode === 'moov_money') {
    resultatOperateur = await verifierStatutMoov(reference);
  } else if (methode === 'celtiis_pay') {
    resultatOperateur = await verifierStatutCeltiis(reference);
  }

  // Si le paiement est confirmé, on finalise en base
  if (resultatOperateur.statut === 'SUCCESSFUL') {
    // AND statut != 'reussi' : empêche un double-traitement si ce webhook/appel est reçu
    // plusieurs fois pour la même transaction (l'opérateur peut renvoyer le même statut
    // plusieurs fois) — sans ce garde-fou, le propriétaire serait crédité plusieurs fois.
    const paiement = await pool.query(
      `UPDATE paiements SET statut = 'reussi' WHERE reference_transaction = $1 AND statut != 'reussi' RETURNING *`,
      [reference]
    );

    if (paiement.rows.length > 0) {
      const p = paiement.rows[0];

      // Récupère le contexte (propriétaire à créditer, infos pour la quittance et la notif)
      const contexte = await pool.query(
        `SELECT e.*, b.adresse, b.ville, b.quartier, b.numero_bien, b.proprietaire_id,
                l.nom AS locataire_nom, l.telephone AS locataire_telephone
         FROM echeances e
         JOIN contrats c ON c.id = e.contrat_id
         JOIN biens b ON b.id = c.bien_id
         JOIN locataires l ON l.id = c.locataire_id
         WHERE e.id = $1`,
        [p.echeance_id]
      );

      if (contexte.rows.length > 0) {
        const ctx = contexte.rows[0];

        // Crédite le propriétaire (montant moins commission) et la commission RentEasy au
        // super admin — sans ça, l'argent reçu par mobile money n'atterrit jamais dans le
        // solde du propriétaire, contrairement à un paiement par solde RentEasy.
        const client = await pool.connect();
        let nouveauStatut;
        try {
          await client.query('BEGIN');

          const superAdminRes = await client.query(
            "SELECT id FROM users WHERE role LIKE '%super_admin%' ORDER BY created_at ASC LIMIT 1"
          );

          const commission = p.commission_renteasy || 0;
          const partProprietaire = p.montant - commission;

          await client.query('UPDATE users SET solde = solde + $1 WHERE id = $2', [partProprietaire, ctx.proprietaire_id]);
          if (superAdminRes.rows.length > 0) {
            await client.query('UPDATE users SET solde = solde + $1 WHERE id = $2', [commission, superAdminRes.rows[0].id]);
          }

          // Recalcule le total réellement payé (comme creerPaiement/payerEcheanceSolde) au lieu
          // de forcer 'payee' à l'aveugle — un paiement partiel (cash/agent) a pu être enregistré
          // pendant que ce paiement Mobile Money était encore "en_cours".
          const totalPayeRes = await client.query(
            `SELECT COALESCE(SUM(montant), 0) AS total FROM paiements WHERE echeance_id = $1 AND statut = 'reussi'`,
            [p.echeance_id]
          );
          const totalPaye = parseInt(totalPayeRes.rows[0].total, 10);
          nouveauStatut = totalPaye >= ctx.montant_du ? 'payee' : 'partielle';

          await client.query('UPDATE echeances SET statut = $1 WHERE id = $2', [nouveauStatut, p.echeance_id]);

          await client.query('COMMIT');
        } catch (errTransaction) {
          await client.query('ROLLBACK');
          throw errTransaction;
        } finally {
          client.release();
        }

        // Notifie le propriétaire — comme pour un paiement par solde RentEasy
        const proprietaireInfo = await pool.query('SELECT nom, email, telephone FROM users WHERE id = $1', [ctx.proprietaire_id]);
        if (proprietaireInfo.rows.length > 0) {
          await notifier({
            user_id: ctx.proprietaire_id,
            email: proprietaireInfo.rows[0].email,
            nom: proprietaireInfo.rows[0].nom,
            telephone: proprietaireInfo.rows[0].telephone,
            sms: `RentEasy : ${ctx.locataire_nom} a payé ${p.montant.toLocaleString('fr-FR')} FCFA par ${p.methode} pour le bien ${ctx.numero_bien}.`,
            titre: nouveauStatut === 'payee' ? 'Loyer payé' : 'Paiement partiel reçu',
            message: `${ctx.locataire_nom} a payé ${p.montant.toLocaleString('fr-FR')} FCFA par ${p.methode} pour le bien ${ctx.numero_bien}.`,
            type: 'paiement',
            lien: '/paiements',
            sujet_email: '[RentEasy] Paiement reçu',
            contenu_email: `
              <h2>Paiement reçu</h2>
              <p>Bonjour ${echapperHtml(proprietaireInfo.rows[0].nom)},</p>
              <p><strong>${echapperHtml(ctx.locataire_nom)}</strong> a payé <strong>${p.montant.toLocaleString('fr-FR')} FCFA</strong> par ${p.methode} pour le bien ${ctx.numero_bien}.</p>
            `,
          });
        }

        // Génère la quittance PDF
        const cheminQuittance = await genererQuittancePDF({
          paiement: p,
          echeance: ctx,
          bien: ctx,
          locataire: { nom: ctx.locataire_nom, telephone: ctx.locataire_telephone },
        });
        await pool.query('UPDATE paiements SET quittance_url = $1 WHERE id = $2', [cheminQuittance, p.id]);
      }
    }
  } else if (resultatOperateur.statut === 'FAILED') {
    await pool.query(
      "UPDATE paiements SET statut = 'echoue' WHERE reference_transaction = $1 AND statut != 'reussi'",
      [reference]
    );
  }

  return {
    reference,
    statut: resultatOperateur.statut, // PENDING | SUCCESSFUL | FAILED
    details: resultatOperateur.details,
  };
}

// Sans ce job, un paiement de loyer Mobile Money ne se finalisait jamais tant que personne ne
// rappelait GET /mobilemoney/statut/:reference — ce qui n'arrive que si le locataire reste sur
// l'écran de paiement jusqu'à confirmation. S'il ferme l'app ou perd la connexion juste après
// avoir confirmé sur son téléphone, le paiement restait bloqué "en_cours" indéfiniment, sans que
// ni lui ni le propriétaire ne soit jamais notifié — même bug que celui déjà corrigé côté solde
// (cf. cronSolde.js), resté ouvert ici jusqu'à ce correctif.
async function verifierPaiementsMobileEnCoursPeriodique() {
  try {
    const enCours = await pool.query(
      `SELECT reference_transaction, methode FROM paiements
       WHERE statut = 'en_cours' AND reference_transaction IS NOT NULL
         AND methode IN ('mtn_momo', 'moov_money', 'celtiis_pay')
         AND date_paiement < NOW() - INTERVAL '20 seconds'`
    );

    for (const p of enCours.rows) {
      try {
        await finaliserPaiementMobile({ reference: p.reference_transaction, methode: p.methode });
      } catch (errUne) {
        console.error(`Erreur vérification périodique paiement mobile ${p.reference_transaction} :`, errUne.message);
      }
    }
  } catch (err) {
    enregistrerErreur({ erreur: err });
  }
}

module.exports = { initierPaiementMobile, verifierPaiementMobile, verifierPaiementsMobileEnCoursPeriodique };
