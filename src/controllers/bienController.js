const pool = require('../config/database');

// Créer un bien (propriétaire connecté uniquement)
async function creerBien(req, res) {
  const { adresse, ville, quartier, type_bien, loyer_mensuel } = req.body;
  const proprietaire_id = req.user.id;

  if (!adresse || !ville || !type_bien || !loyer_mensuel) {
    return res.status(400).json({ message: 'Champs obligatoires manquants (adresse, ville, type_bien, loyer_mensuel)' });
  }

  try {
    const resultat = await pool.query(
      `INSERT INTO biens (proprietaire_id, adresse, ville, quartier, type_bien, loyer_mensuel)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [proprietaire_id, adresse, ville, quartier || null, type_bien, loyer_mensuel]
    );
    return res.status(201).json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur création bien :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la création du bien' });
  }
}

// Lister les biens du propriétaire connecté
async function listerBiens(req, res) {
  const proprietaire_id = req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT b.*,
        (SELECT COUNT(*) FROM contrats c WHERE c.bien_id = b.id AND c.statut = 'actif') AS contrat_actif
       FROM biens b
       WHERE b.proprietaire_id = $1
       ORDER BY b.created_at DESC`,
      [proprietaire_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste biens :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la récupération des biens' });
  }
}

// Récupérer le détail d'un bien (avec vérification d'appartenance)
async function obtenirBien(req, res) {
  const { id } = req.params;
  const proprietaire_id = req.user.id;

  try {
    const resultat = await pool.query(
      'SELECT * FROM biens WHERE id = $1 AND proprietaire_id = $2',
      [id, proprietaire_id]
    );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Bien non trouvé' });
    }

    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur détail bien :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Modifier un bien
async function modifierBien(req, res) {
  const { id } = req.params;
  const proprietaire_id = req.user.id;
  const { adresse, ville, quartier, type_bien, loyer_mensuel, statut } = req.body;

  try {
    const verif = await pool.query('SELECT id FROM biens WHERE id = $1 AND proprietaire_id = $2', [id, proprietaire_id]);
    if (verif.rows.length === 0) {
      return res.status(404).json({ message: 'Bien non trouvé' });
    }

    const resultat = await pool.query(
      `UPDATE biens SET
        adresse = COALESCE($1, adresse),
        ville = COALESCE($2, ville),
        quartier = COALESCE($3, quartier),
        type_bien = COALESCE($4, type_bien),
        loyer_mensuel = COALESCE($5, loyer_mensuel),
        statut = COALESCE($6, statut),
        updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [adresse, ville, quartier, type_bien, loyer_mensuel, statut, id]
    );

    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur modification bien :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la modification' });
  }
}

// Supprimer un bien
async function supprimerBien(req, res) {
  const { id } = req.params;
  const proprietaire_id = req.user.id;

  try {
    const resultat = await pool.query(
      'DELETE FROM biens WHERE id = $1 AND proprietaire_id = $2 RETURNING id',
      [id, proprietaire_id]
    );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Bien non trouvé' });
    }

    return res.json({ message: 'Bien supprimé avec succès' });
  } catch (err) {
    console.error('Erreur suppression bien :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la suppression' });
  }
}

module.exports = { creerBien, listerBiens, obtenirBien, modifierBien, supprimerBien };
