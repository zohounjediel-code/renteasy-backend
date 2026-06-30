const pool = require('../config/database');

// Créer un locataire
async function creerLocataire(req, res) {
  const { nom, telephone, email, numero_piece_identite } = req.body;

  if (!nom || !telephone) {
    return res.status(400).json({ message: 'Nom et téléphone obligatoires' });
  }

  try {
    const resultat = await pool.query(
      `INSERT INTO locataires (nom, telephone, email, numero_piece_identite)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [nom, telephone, email || null, numero_piece_identite || null]
    );
    return res.status(201).json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur création locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la création du locataire' });
  }
}

// Lister tous les locataires liés aux biens du propriétaire connecté
async function listerLocataires(req, res) {
  const proprietaire_id = req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT DISTINCT l.*
       FROM locataires l
       JOIN contrats c ON c.locataire_id = l.id
       JOIN biens b ON b.id = c.bien_id
       WHERE b.proprietaire_id = $1
       ORDER BY l.created_at DESC`,
      [proprietaire_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste locataires :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la récupération des locataires' });
  }
}

// Récupérer le détail d'un locataire
async function obtenirLocataire(req, res) {
  const { id } = req.params;

  try {
    const resultat = await pool.query('SELECT * FROM locataires WHERE id = $1', [id]);

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Locataire non trouvé' });
    }

    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur détail locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Modifier un locataire
async function modifierLocataire(req, res) {
  const { id } = req.params;
  const { nom, telephone, email, numero_piece_identite } = req.body;

  try {
    const resultat = await pool.query(
      `UPDATE locataires SET
        nom = COALESCE($1, nom),
        telephone = COALESCE($2, telephone),
        email = COALESCE($3, email),
        numero_piece_identite = COALESCE($4, numero_piece_identite)
       WHERE id = $5
       RETURNING *`,
      [nom, telephone, email, numero_piece_identite, id]
    );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Locataire non trouvé' });
    }

    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur modification locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la modification' });
  }
}

module.exports = { creerLocataire, listerLocataires, obtenirLocataire, modifierLocataire };
