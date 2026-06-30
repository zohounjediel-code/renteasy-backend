const pool = require('../config/database');
const { creerEcheancesPourContrat } = require('../utils/echeances');

// Créer un contrat : lie un bien (du propriétaire connecté) à un locataire
async function creerContrat(req, res) {
  const proprietaire_id = req.user.id;
  const { bien_id, locataire_id, date_debut, jour_echeance, loyer_mensuel, caution } = req.body;

  if (!bien_id || !locataire_id || !date_debut || !loyer_mensuel) {
    return res.status(400).json({ message: 'Champs obligatoires manquants (bien_id, locataire_id, date_debut, loyer_mensuel)' });
  }

  try {
    // Vérifie que le bien appartient bien au propriétaire connecté
    const bien = await pool.query('SELECT * FROM biens WHERE id = $1 AND proprietaire_id = $2', [bien_id, proprietaire_id]);
    if (bien.rows.length === 0) {
      return res.status(404).json({ message: 'Bien non trouvé ou non autorisé' });
    }

    // Vérifie qu'il n'y a pas déjà un contrat actif sur ce bien
    const contratExistant = await pool.query(
      "SELECT id FROM contrats WHERE bien_id = $1 AND statut = 'actif'",
      [bien_id]
    );
    if (contratExistant.rows.length > 0) {
      return res.status(409).json({ message: 'Ce bien a déjà un contrat actif' });
    }

    const resultatContrat = await pool.query(
      `INSERT INTO contrats (bien_id, locataire_id, date_debut, jour_echeance, loyer_mensuel, caution)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [bien_id, locataire_id, date_debut, jour_echeance || 5, loyer_mensuel, caution || 0]
    );

    const contrat = resultatContrat.rows[0];

    // Génère automatiquement les 12 prochaines échéances mensuelles
    await creerEcheancesPourContrat(pool, contrat, 12);

    // Marque le bien comme occupé
    await pool.query("UPDATE biens SET statut = 'occupe', updated_at = NOW() WHERE id = $1", [bien_id]);

    return res.status(201).json({
      message: 'Contrat créé avec succès, échéances générées pour 12 mois',
      contrat,
    });
  } catch (err) {
    console.error('Erreur création contrat :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la création du contrat' });
  }
}

// Lister les contrats du propriétaire connecté
async function listerContrats(req, res) {
  const proprietaire_id = req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT c.*, b.adresse, b.ville, l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE b.proprietaire_id = $1
       ORDER BY c.created_at DESC`,
      [proprietaire_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste contrats :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la récupération des contrats' });
  }
}

// Détail d'un contrat avec ses échéances
async function obtenirContrat(req, res) {
  const { id } = req.params;
  const proprietaire_id = req.user.id;

  try {
    const contrat = await pool.query(
      `SELECT c.*, b.adresse, b.ville, b.proprietaire_id, l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE c.id = $1`,
      [id]
    );

    if (contrat.rows.length === 0 || contrat.rows[0].proprietaire_id !== proprietaire_id) {
      return res.status(404).json({ message: 'Contrat non trouvé' });
    }

    const echeances = await pool.query(
      'SELECT * FROM echeances WHERE contrat_id = $1 ORDER BY mois_concerne ASC',
      [id]
    );

    return res.json({ ...contrat.rows[0], echeances: echeances.rows });
  } catch (err) {
    console.error('Erreur détail contrat :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Résilier un contrat
async function resilierContrat(req, res) {
  const { id } = req.params;
  const proprietaire_id = req.user.id;

  try {
    const contrat = await pool.query(
      `SELECT c.*, b.proprietaire_id FROM contrats c JOIN biens b ON b.id = c.bien_id WHERE c.id = $1`,
      [id]
    );

    if (contrat.rows.length === 0 || contrat.rows[0].proprietaire_id !== proprietaire_id) {
      return res.status(404).json({ message: 'Contrat non trouvé' });
    }

    await pool.query("UPDATE contrats SET statut = 'resilie' WHERE id = $1", [id]);
    await pool.query("UPDATE biens SET statut = 'libre', updated_at = NOW() WHERE id = $1", [contrat.rows[0].bien_id]);

    return res.json({ message: 'Contrat résilié avec succès' });
  } catch (err) {
    console.error('Erreur résiliation contrat :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la résiliation' });
  }
}

module.exports = { creerContrat, listerContrats, obtenirContrat, resilierContrat };
