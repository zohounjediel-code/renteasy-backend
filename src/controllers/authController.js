const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');

const SALT_ROUNDS = 10;

// Inscription d'un nouvel utilisateur (propriétaire par défaut à ce stade ;
// les agents/admins sont créés manuellement par un admin dans une future route)
async function inscrire(req, res) {
  const { nom, email, telephone, mot_de_passe, ville } = req.body;

  if (!nom || !email || !telephone || !mot_de_passe) {
    return res.status(400).json({ message: 'Champs obligatoires manquants' });
  }

  try {
    const existant = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR telephone = $2',
      [email, telephone]
    );

    if (existant.rows.length > 0) {
      return res.status(409).json({ message: 'Un compte existe déjà avec cet email ou ce téléphone' });
    }

    const hash = await bcrypt.hash(mot_de_passe, SALT_ROUNDS);

    const resultat = await pool.query(
      `INSERT INTO users (nom, email, telephone, mot_de_passe_hash, role, ville)
       VALUES ($1, $2, $3, $4, 'proprietaire', $5)
       RETURNING id, nom, email, telephone, role, ville, created_at`,
      [nom, email, telephone, hash, ville || null]
    );

    const utilisateur = resultat.rows[0];
    const token = genererToken(utilisateur);

    return res.status(201).json({ utilisateur, token });
  } catch (err) {
    console.error('Erreur inscription :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de l\'inscription' });
  }
}

// Connexion
async function connecter(req, res) {
  const { email, mot_de_passe } = req.body;

  if (!email || !mot_de_passe) {
    return res.status(400).json({ message: 'Email et mot de passe requis' });
  }

  try {
    const resultat = await pool.query('SELECT * FROM users WHERE email = $1 AND actif = true', [email]);

    if (resultat.rows.length === 0) {
      return res.status(401).json({ message: 'Identifiants incorrects' });
    }

    const utilisateur = resultat.rows[0];
    const motDePasseValide = await bcrypt.compare(mot_de_passe, utilisateur.mot_de_passe_hash);

    if (!motDePasseValide) {
      return res.status(401).json({ message: 'Identifiants incorrects' });
    }

    const token = genererToken(utilisateur);
    delete utilisateur.mot_de_passe_hash;

    return res.json({ utilisateur, token });
  } catch (err) {
    console.error('Erreur connexion :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la connexion' });
  }
}

function genererToken(utilisateur) {
  return jwt.sign(
    { id: utilisateur.id, role: utilisateur.role, nom: utilisateur.nom },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

module.exports = { inscrire, connecter };
