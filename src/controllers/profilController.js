const pool = require('../config/database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { listerJournalProprietaire } = require('../utils/journalAgent');
const { definirCookieAuth } = require('../utils/authCookie');

// Récupérer son profil
async function obtenirProfil(req, res) {
  const user_id = req.user.id;
  try {
    const resultat = await pool.query(
      `SELECT id, nom, email, telephone, role, ville, numero_piece_identite,
              compte_active, actif, solde, autorise_agent_gestion, agent_id, created_at
       FROM users WHERE id = $1`,
      [user_id]
    );
    if (resultat.rows.length === 0) return res.status(404).json({ message: 'Utilisateur non trouvé' });
    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur profil :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Autoriser ou révoquer la délégation "agir au nom de moi" pour son agent assigné.
// Réversible à tout moment par le propriétaire. N'affecte jamais les enregistrements déjà
// créés par l'agent : la traçabilité (effectue_par_agent_id) reste permanente.
async function modifierDelegationAgent(req, res) {
  const user_id = req.user.id;
  const { autorise } = req.body;

  if (typeof autorise !== 'boolean') {
    return res.status(400).json({ message: 'Le champ autorise (booléen) est requis' });
  }

  try {
    const verif = await pool.query(`SELECT agent_id, role FROM users WHERE id = $1`, [user_id]);
    if (verif.rows.length === 0) return res.status(404).json({ message: 'Utilisateur non trouvé' });
    if (!(verif.rows[0].role || '').includes('proprietaire')) {
      return res.status(403).json({ message: 'Réservé aux comptes propriétaires' });
    }
    if (autorise && !verif.rows[0].agent_id) {
      return res.status(400).json({ message: "Vous n'avez pas d'agent assigné pour l'instant" });
    }

    await pool.query('UPDATE users SET autorise_agent_gestion = $1 WHERE id = $2', [autorise, user_id]);

    return res.json({
      message: autorise
        ? 'Votre agent peut désormais gérer vos biens, contrats et locataires en votre nom.'
        : "L'autorisation a été révoquée. Votre agent ne peut plus agir en votre nom.",
      autorise_agent_gestion: autorise,
    });
  } catch (err) {
    console.error('Erreur modification délégation agent :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Modifier ses informations
async function modifierProfil(req, res) {
  const user_id = req.user.id;
  const { nom, telephone, ville, numero_piece_identite } = req.body;

  try {
    const resultat = await pool.query(
      `UPDATE users SET
        nom = COALESCE($1, nom),
        telephone = COALESCE($2, telephone),
        ville = COALESCE($3, ville),
        numero_piece_identite = COALESCE($4, numero_piece_identite),
        updated_at = NOW()
       WHERE id = $5
       RETURNING id, nom, email, telephone, role, ville, numero_piece_identite`,
      [nom || null, telephone || null, ville || null, numero_piece_identite || null, user_id]
    );

    // Le nom est embarqué dans le payload du JWT (utilisé pour l'affichage sans requête
    // supplémentaire) : on réémet un token à jour pour que le cookie reflète le nouveau nom.
    const token = jwt.sign(
      { id: resultat.rows[0].id, role: resultat.rows[0].role, nom: resultat.rows[0].nom },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
    definirCookieAuth(res, token);

    return res.json({ utilisateur: resultat.rows[0] });
  } catch (err) {
    console.error('Erreur modification profil :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Changer son mot de passe
async function changerMotDePasse(req, res) {
  const user_id = req.user.id;
  const { ancien_mot_de_passe, nouveau_mot_de_passe } = req.body;

  if (!ancien_mot_de_passe || !nouveau_mot_de_passe) {
    return res.status(400).json({ message: 'Ancien et nouveau mot de passe requis' });
  }
  if (nouveau_mot_de_passe.length < 8) {
    return res.status(400).json({ message: 'Le nouveau mot de passe doit contenir au moins 8 caractères' });
  }

  try {
    const user = await pool.query('SELECT mot_de_passe_hash FROM users WHERE id = $1', [user_id]);
    const valide = await bcrypt.compare(ancien_mot_de_passe, user.rows[0].mot_de_passe_hash);
    if (!valide) return res.status(401).json({ message: 'Ancien mot de passe incorrect' });

    const hash = await bcrypt.hash(nouveau_mot_de_passe, 10);
    await pool.query('UPDATE users SET mot_de_passe_hash = $1 WHERE id = $2', [hash, user_id]);

    return res.json({ message: 'Mot de passe modifié avec succès !' });
  } catch (err) {
    console.error('Erreur changement mdp :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = { obtenirProfil, modifierProfil, changerMotDePasse, modifierDelegationAgent, journalAgentProprietaire };

// Historique horodaté de tout ce que l'agent a fait au nom du propriétaire connecté
async function journalAgentProprietaire(req, res) {
  try {
    const journal = await listerJournalProprietaire(req.user.id);
    return res.json(journal);
  } catch (err) {
    console.error('Erreur journal agent (propriétaire) :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}
