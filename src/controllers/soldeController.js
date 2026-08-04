const pool = require('../config/database');
const { enregistrerErreur } = require('../utils/erreurs');
const { demanderPaiementMTN, verifierStatutMTN, demanderTransfertMTN, verifierStatutTransfertMTN } = require('../utils/mtnMomo');
const {
  demanderPaiementMoov, verifierStatutMoov, demanderTransfertMoov, verifierStatutTransfertMoov,
  demanderPaiementCeltiis, verifierStatutCeltiis, demanderTransfertCeltiis, verifierStatutTransfertCeltiis,
} = require('../utils/moovCeltiis');

const METHODES_AUTORISEES = ['mtn_momo', 'moov_money', 'celtiis_pay'];

// Récupérer le solde et l'historique des transactions de l'utilisateur connecté
async function obtenirSolde(req, res) {
  const user_id = req.user.id;

  try {
    const user = await pool.query('SELECT solde FROM users WHERE id = $1', [user_id]);
    const transactions = await pool.query(
      'SELECT * FROM transactions_solde WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
      [user_id]
    );

    return res.json({
      solde: user.rows[0]?.solde || 0,
      transactions: transactions.rows,
    });
  } catch (err) {
    console.error('Erreur récupération solde :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Recharger son solde depuis Mobile Money (prélèvement sur le numéro renseigné)
async function rechargerSolde(req, res) {
  const user_id = req.user.id;
  const { montant, methode, telephone } = req.body;

  if (!montant || !methode || !telephone) {
    return res.status(400).json({ message: 'Champs requis : montant, methode (mtn_momo | moov_money | celtiis_pay), telephone' });
  }
  if (!METHODES_AUTORISEES.includes(methode)) {
    return res.status(400).json({ message: `Méthode invalide. Utilisez : ${METHODES_AUTORISEES.join(', ')}` });
  }
  if (parseInt(montant) <= 0) {
    return res.status(400).json({ message: 'Le montant doit être supérieur à 0' });
  }

  try {
    const montantInt = parseInt(montant);
    const description = 'Recharge de solde RentEasy';
    let referenceTransaction;

    if (methode === 'mtn_momo') {
      referenceTransaction = await demanderPaiementMTN({ montant: montantInt, telephone, description });
    } else if (methode === 'moov_money') {
      const result = await demanderPaiementMoov({ montant: montantInt, telephone, description });
      referenceTransaction = result.reference || result.transactionId;
    } else {
      const result = await demanderPaiementCeltiis({ montant: montantInt, telephone, description });
      referenceTransaction = result.reference || result.transactionId;
    }

    const transaction = await pool.query(
      `INSERT INTO transactions_solde (user_id, type, montant, methode, telephone, reference_transaction, statut)
       VALUES ($1, 'recharge', $2, $3, $4, $5, 'en_cours')
       RETURNING *`,
      [user_id, montantInt, methode, telephone, referenceTransaction]
    );

    return res.status(202).json({
      message: 'Demande de prélèvement envoyée. Confirmez sur votre téléphone pour finaliser la recharge.',
      transaction: transaction.rows[0],
    });
  } catch (err) {
    console.error('Erreur recharge solde :', err.message);
    return res.status(500).json({ message: 'Erreur lors de la recharge : ' + err.message });
  }
}

// Retirer de son solde vers Mobile Money (transfert vers le numéro renseigné)
async function retirerSolde(req, res) {
  const user_id = req.user.id;
  const { montant, methode, telephone } = req.body;

  if (!montant || !methode || !telephone) {
    return res.status(400).json({ message: 'Champs requis : montant, methode (mtn_momo | moov_money | celtiis_pay), telephone' });
  }
  if (!METHODES_AUTORISEES.includes(methode)) {
    return res.status(400).json({ message: `Méthode invalide. Utilisez : ${METHODES_AUTORISEES.join(', ')}` });
  }

  const montantInt = parseInt(montant);
  if (montantInt <= 0) {
    return res.status(400).json({ message: 'Le montant doit être supérieur à 0' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const user = await client.query('SELECT solde FROM users WHERE id = $1 FOR UPDATE', [user_id]);
    const soldeActuel = user.rows[0]?.solde || 0;

    if (montantInt > soldeActuel) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `Solde insuffisant. Solde disponible : ${soldeActuel} FCFA` });
    }

    // Débite immédiatement le solde (sera remboursé automatiquement si le transfert échoue)
    await client.query('UPDATE users SET solde = solde - $1 WHERE id = $2', [montantInt, user_id]);

    const description = 'Retrait de solde RentEasy';
    let referenceTransaction;

    if (methode === 'mtn_momo') {
      referenceTransaction = await demanderTransfertMTN({ montant: montantInt, telephone, description });
    } else if (methode === 'moov_money') {
      const result = await demanderTransfertMoov({ montant: montantInt, telephone, description });
      referenceTransaction = result.reference || result.transactionId;
    } else {
      const result = await demanderTransfertCeltiis({ montant: montantInt, telephone, description });
      referenceTransaction = result.reference || result.transactionId;
    }

    const transaction = await client.query(
      `INSERT INTO transactions_solde (user_id, type, montant, methode, telephone, reference_transaction, statut)
       VALUES ($1, 'retrait', $2, $3, $4, $5, 'en_cours')
       RETURNING *`,
      [user_id, montantInt, methode, telephone, referenceTransaction]
    );

    await client.query('COMMIT');

    return res.status(202).json({
      message: 'Retrait initié. Les fonds seront transférés sur votre numéro sous peu.',
      transaction: transaction.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erreur retrait solde :', err.message);
    return res.status(500).json({ message: 'Erreur lors du retrait : ' + err.message });
  } finally {
    client.release();
  }
}

// Interroge l'opérateur mobile money pour UNE transaction "en_cours" et finalise si besoin
// (crédite le solde pour une recharge réussie, rembourse le solde pour un retrait échoué).
// Extrait de verifierTransaction pour être réutilisable à la fois depuis l'appel HTTP et
// depuis le job planifié ci-dessous (verifierTransactionsEnCoursPeriodique) — sans ce second
// appelant, une transaction ne se finalisait JAMAIS si personne ne rappelait manuellement
// cette route (ex : l'utilisateur ferme l'onglet avant de confirmer sur son téléphone) :
// une recharge réussie ne créditait alors jamais le solde, et un retrait échoué n'était
// jamais remboursé.
async function finaliserTransactionSolde(t) {
  if (t.statut !== 'en_cours') {
    return { statut: t.statut, dejaTraitee: true };
  }

  let resultatOperateur;
  if (t.type === 'recharge') {
    if (t.methode === 'mtn_momo') resultatOperateur = await verifierStatutMTN(t.reference_transaction);
    else if (t.methode === 'moov_money') resultatOperateur = await verifierStatutMoov(t.reference_transaction);
    else resultatOperateur = await verifierStatutCeltiis(t.reference_transaction);
  } else {
    if (t.methode === 'mtn_momo') resultatOperateur = await verifierStatutTransfertMTN(t.reference_transaction);
    else if (t.methode === 'moov_money') resultatOperateur = await verifierStatutTransfertMoov(t.reference_transaction);
    else resultatOperateur = await verifierStatutTransfertCeltiis(t.reference_transaction);
  }

  if (resultatOperateur.statut === 'SUCCESSFUL') {
    // "AND statut = 'en_cours'" : garde-fou anti double-traitement si cette fonction est
    // appelée deux fois en parallèle pour la même transaction (ex : le job planifié et une
    // vérification manuelle au même instant) — seule la première écriture doit créditer.
    const maj = await pool.query(
      "UPDATE transactions_solde SET statut = 'reussi', updated_at = NOW() WHERE id = $1 AND statut = 'en_cours' RETURNING *",
      [t.id]
    );
    if (maj.rows.length > 0 && t.type === 'recharge') {
      // Le prélèvement a réussi : on crédite le solde
      await pool.query('UPDATE users SET solde = solde + $1 WHERE id = $2', [t.montant, t.user_id]);
    }
    // Pour un retrait réussi, le solde a déjà été débité à l'initiation, rien à refaire
  } else if (resultatOperateur.statut === 'FAILED') {
    const maj = await pool.query(
      "UPDATE transactions_solde SET statut = 'echoue', updated_at = NOW() WHERE id = $1 AND statut = 'en_cours' RETURNING *",
      [t.id]
    );
    if (maj.rows.length > 0 && t.type === 'retrait') {
      // Le transfert a échoué : on rembourse le solde débité à l'initiation
      await pool.query('UPDATE users SET solde = solde + $1 WHERE id = $2', [t.montant, t.user_id]);
    }
  }

  return { statut: resultatOperateur.statut, details: resultatOperateur.details };
}

// Vérifier le statut d'une transaction de solde et finaliser (créditer/rembourser)
async function verifierTransaction(req, res) {
  const { id } = req.params;
  const user_id = req.user.id;

  try {
    const transaction = await pool.query(
      'SELECT * FROM transactions_solde WHERE id = $1 AND user_id = $2',
      [id, user_id]
    );

    if (transaction.rows.length === 0) {
      return res.status(404).json({ message: 'Transaction non trouvée' });
    }

    const t = transaction.rows[0];
    const resultat = await finaliserTransactionSolde(t);

    return res.json({ statut: resultat.statut, transaction: t });
  } catch (err) {
    console.error('Erreur vérification transaction solde :', err.message);
    return res.status(500).json({ message: 'Erreur lors de la vérification : ' + err.message });
  }
}

// Rattrapage automatique : reprend TOUTES les transactions restées "en_cours" (recharge
// ou retrait), qu'un appel du frontend n'a jamais relancées pour vérifier. Appelée
// périodiquement par utils/cronSolde.js. Le délai de 20 secondes laisse le temps à
// l'opérateur de traiter la demande avant qu'on l'interroge, pour éviter de le solliciter
// inutilement pour une transaction qui n'a même pas eu le temps d'aboutir.
async function verifierTransactionsEnCoursPeriodique() {
  try {
    const enCours = await pool.query(
      `SELECT * FROM transactions_solde WHERE statut = 'en_cours' AND created_at < NOW() - INTERVAL '20 seconds'`
    );

    for (const t of enCours.rows) {
      try {
        await finaliserTransactionSolde(t);
      } catch (errUne) {
        console.error(`Erreur vérification périodique transaction solde ${t.id} :`, errUne.message);
      }
    }
  } catch (err) {
    enregistrerErreur({ erreur: err });
  }
}

module.exports = {
  obtenirSolde,
  rechargerSolde,
  retirerSolde,
  verifierTransaction,
  verifierTransactionsEnCoursPeriodique,
};
