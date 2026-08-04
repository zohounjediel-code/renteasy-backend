const jwt = require('jsonwebtoken');

// Vérifie que la requête contient un token JWT valide
function authentifier(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentification requise' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, roles, nom }
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Token invalide ou expiré' });
  }
}

// Vérifie que l'utilisateur a au moins un des rôles autorisés
// Supporte les rôles multiples séparés par virgule (ex: "proprietaire,locataire")
function autoriser(...rolesAutorises) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(403).json({ message: 'Accès refusé' });
    }

    const rolesUtilisateur = (req.user.role || '').split(',').map(r => r.trim());
    const aAcces = rolesAutorises.some(r => rolesUtilisateur.includes(r));

    if (!aAcces) {
      return res.status(403).json({ message: 'Accès refusé pour ce rôle' });
    }
    next();
  };
}

module.exports = { authentifier, autoriser };
