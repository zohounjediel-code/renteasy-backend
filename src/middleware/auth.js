const jwt = require('jsonwebtoken');
const { NOM_COOKIE } = require('../utils/authCookie');

// Vérifie que la requête contient un token JWT valide. Le cookie httpOnly est la source
// normale (posé automatiquement par le navigateur) ; l'en-tête Authorization reste accepté en
// repli pour ne rien casser côté clients non-navigateur éventuels.
function authentifier(req, res, next) {
  const authHeader = req.headers.authorization;
  const tokenHeader = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  const token = req.cookies?.[NOM_COOKIE] || tokenHeader;

  if (!token) {
    return res.status(401).json({ message: 'Authentification requise' });
  }

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
