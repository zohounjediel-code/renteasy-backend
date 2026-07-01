const pool = require('../config/database');
const { demanderPaiementMTN, verifierStatutMTN } = require('../utils/mtnMomo');
const { demanderPaiementMoov, verifierStatutMoov, demanderPaiementCeltiis, verifierStatutCeltiis } = require('../utils/moovCeltiis');
const { genererQuittancePDF } = require('../utils/quittance');

const TAUX_COMMISSION = 0.05;

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

    const montant = echeance.montant_du;
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
    await pool.query(
      `INSERT INTO paiements (echeance_id, montant, methode, reference_transaction, commission_renteasy, statut)
       VALUES ($1, $2, $3, $4, $5, 'en_cours')`,
      [echeance_id, montant, methode, referenceTransaction, Math.round(montant * TAUX_COMMISSION)]
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
      const paiement = await pool.query(
        `UPDATE paiements SET statut = 'reussi' WHERE reference_transaction = $1 RETURNING *`,
        [reference]
      );

      if (paiement.rows.length > 0) {
        const p = paiement.rows[0];

        // Met à jour le statut de l'échéance
        await pool.query("UPDATE echeances SET statut = 'payee' WHERE id = $1", [p.echeance_id]);

        // Génère la quittance PDF
        const contexte = await pool.query(
          `SELECT e.*, b.adresse, b.ville, b.quartier, l.nom AS locataire_nom, l.telephone AS locataire_telephone
           FROM echeances e
           JOIN contrats c ON c.id = e.contrat_id
           JOIN biens b ON b.id = c.bien_id
           JOIN locataires l ON l.id = c.locataire_id
           WHERE e.id = $1`,
          [p.echeance_id]
        );

        if (contexte.rows.length > 0) {
          const ctx = contexte.rows[0];
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
        "UPDATE paiements SET statut = 'echoue' WHERE reference_transaction = $1",
        [reference]
      );
    }

    return res.json({
      reference,
      statut: resultatOperateur.statut, // PENDING | SUCCESSFUL | FAILED
      details: resultatOperateur.details,
    });
  } catch (err) {
    console.error('Erreur vérification paiement mobile :', err.message);
    return res.status(500).json({ message: 'Erreur lors de la vérification : ' + err.message });
  }
}

module.exports = { initierPaiementMobile, verifierPaiementMobile };
