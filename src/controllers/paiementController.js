const pool = require('../config/database');
const { genererQuittancePDF } = require('../utils/quittance');

const TAUX_COMMISSION = 0.05; // 5%, conforme au dossier bancaire

// Enregistrer un paiement sur une échéance
async function creerPaiement(req, res) {
  const { echeance_id, montant, methode, reference_transaction } = req.body;

  if (!echeance_id || !montant || !methode) {
    return res.status(400).json({ message: 'Champs obligatoires manquants (echeance_id, montant, methode)' });
  }

  try {
    // Récupère l'échéance avec tout le contexte nécessaire (bien, locataire, propriétaire)
    const contexte = await pool.query(
      `SELECT e.*, c.bien_id, c.locataire_id, c.loyer_mensuel,
              b.adresse, b.ville, b.quartier, b.proprietaire_id,
              l.nom AS locataire_nom, l.telephone AS locataire_telephone
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

    // Si la requête vient d'un propriétaire, vérifier que c'est bien son bien
    if (req.user.role === 'proprietaire' && echeance.proprietaire_id !== req.user.id) {
      return res.status(403).json({ message: 'Accès non autorisé à cette échéance' });
    }

    const commission = Math.round(montant * TAUX_COMMISSION);

    const resultatPaiement = await pool.query(
      `INSERT INTO paiements (echeance_id, montant, methode, reference_transaction, commission_renteasy, statut)
       VALUES ($1, $2, $3, $4, $5, 'reussi')
       RETURNING *`,
      [echeance_id, montant, methode, reference_transaction || null, commission]
    );

    const paiement = resultatPaiement.rows[0];

    // Met à jour le statut de l'échéance selon le montant payé au total
    const totalPaye = await pool.query(
      `SELECT COALESCE(SUM(montant), 0) AS total FROM paiements WHERE echeance_id = $1 AND statut = 'reussi'`,
      [echeance_id]
    );
    const montantTotal = parseInt(totalPaye.rows[0].total, 10);

    let nouveauStatut = 'partielle';
    if (montantTotal >= echeance.montant_du) {
      nouveauStatut = 'payee';
    }

    await pool.query('UPDATE echeances SET statut = $1 WHERE id = $2', [nouveauStatut, echeance_id]);

    // Génère la quittance PDF
    const cheminQuittance = await genererQuittancePDF({
      paiement,
      echeance,
      bien: echeance,
      locataire: { nom: echeance.locataire_nom, telephone: echeance.locataire_telephone },
    });

    await pool.query('UPDATE paiements SET quittance_url = $1 WHERE id = $2', [cheminQuittance, paiement.id]);

    return res.status(201).json({
      message: 'Paiement enregistré avec succès',
      paiement: { ...paiement, quittance_url: cheminQuittance },
      statut_echeance: nouveauStatut,
    });
  } catch (err) {
    console.error('Erreur création paiement :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de l\'enregistrement du paiement' });
  }
}

// Télécharger une quittance PDF
async function telechargerQuittance(req, res) {
  const { id } = req.params;
  const path = require('path');
  const fs = require('fs');

  try {
    const resultat = await pool.query('SELECT quittance_url FROM paiements WHERE id = $1', [id]);

    if (resultat.rows.length === 0 || !resultat.rows[0].quittance_url) {
      return res.status(404).json({ message: 'Quittance non trouvée' });
    }

    const cheminComplet = path.join(__dirname, '..', '..', resultat.rows[0].quittance_url);

    if (!fs.existsSync(cheminComplet)) {
      return res.status(404).json({ message: 'Fichier de quittance introuvable' });
    }

    return res.download(cheminComplet);
  } catch (err) {
    console.error('Erreur téléchargement quittance :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Lister les échéances impayées/en retard pour le propriétaire connecté
async function listerImpayes(req, res) {
  const proprietaire_id = req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT e.*, b.adresse, b.ville, l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM echeances e
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE b.proprietaire_id = $1
         AND e.statut IN ('impayee', 'en_attente', 'partielle')
         AND e.date_limite < NOW()
       ORDER BY e.date_limite ASC`,
      [proprietaire_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste impayés :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Historique des paiements pour le propriétaire connecté
async function listerPaiements(req, res) {
  const proprietaire_id = req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT p.*, e.mois_concerne, b.adresse, l.nom AS locataire_nom
       FROM paiements p
       JOIN echeances e ON e.id = p.echeance_id
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE b.proprietaire_id = $1
       ORDER BY p.date_paiement DESC`,
      [proprietaire_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste paiements :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = { creerPaiement, telechargerQuittance, listerImpayes, listerPaiements };
