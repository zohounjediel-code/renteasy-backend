const pool = require('../config/database');

// Résout pour QUI une action de création (bien / contrat / locataire) doit être effectuée,
// et si elle est effectuée par un agent au nom d'un propriétaire (délégation).
//
// - Cas normal : le propriétaire connecté agit pour lui-même.
//   → { proprietaire_id: <son id>, effectue_par_agent_id: null }
//
// - Cas délégation : un agent envoie req.body.proprietaire_id pour agir au nom d'un
//   propriétaire qui lui est assigné ET qui a explicitement coché "Autoriser mon agent à
//   gérer mes biens/contrats". Sans ces deux conditions réunies, l'accès est refusé.
//   → { proprietaire_id: <id du propriétaire ciblé>, effectue_par_agent_id: <id de l'agent> }
//
// Retourne null si l'action n'est pas autorisée (à traiter comme un 403 par l'appelant).
async function resoudreCibleAction(req) {
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const proprietaireIdCible = req.body.proprietaire_id;

  // Un propriétaire agissant sur son propre compte n'a pas besoin de préciser proprietaire_id.
  if (roles.includes('proprietaire') && !proprietaireIdCible) {
    return { proprietaire_id: req.user.id, effectue_par_agent_id: null };
  }

  // Toute action ciblant un AUTRE compte que le sien nécessite d'être un agent en délégation.
  if (!proprietaireIdCible) return null;
  if (!roles.includes('agent') && !roles.includes('admin') && !roles.includes('super_admin')) return null;

  const resultat = await pool.query(
    `SELECT id, agent_id, autorise_agent_gestion FROM users WHERE id = $1 AND role LIKE '%proprietaire%'`,
    [proprietaireIdCible]
  );
  if (resultat.rows.length === 0) return null;
  const proprietaire = resultat.rows[0];

  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  if (!estAdmin) {
    if (proprietaire.agent_id !== req.user.id) return null;
    if (!proprietaire.autorise_agent_gestion) return null;
  }

  // Un admin qui agit "au nom de" n'est pas un agent : pas de traçabilité effectue_par_agent_id
  // dans ce cas (usage support technique interne, distinct de la délégation agent-propriétaire).
  return {
    proprietaire_id: proprietaire.id,
    effectue_par_agent_id: roles.includes('agent') ? req.user.id : null,
  };
}

// Vérifie qu'un agent (en délégation) ou le propriétaire lui-même est autorisé à agir sur un
// bien déjà existant (ex: ajouter/supprimer des photos juste après sa création). Distinct de
// resoudreCibleAction qui gère la création de nouvelles ressources.
async function verifierAccesBien(req, bienId) {
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const resultat = await pool.query(
    `SELECT b.*, u.agent_id, u.autorise_agent_gestion
     FROM biens b JOIN users u ON u.id = b.proprietaire_id
     WHERE b.id = $1`,
    [bienId]
  );
  if (resultat.rows.length === 0) return null;
  const bien = resultat.rows[0];

  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const estProprietaireDuBien = roles.includes('proprietaire') && bien.proprietaire_id === req.user.id;
  const estAgentEnDelegation = roles.includes('agent') && bien.agent_id === req.user.id && bien.autorise_agent_gestion;

  if (!estAdmin && !estProprietaireDuBien && !estAgentEnDelegation) return null;

  return bien;
}

module.exports = { resoudreCibleAction, verifierAccesBien, estAutoriseSurProprietaire, resoudreProprietaireConsulte };

// Résout quel propriétaire une requête de LECTURE (liste/détail biens, contrats, locataires,
// paiements, dashboard) doit cibler.
//  - Le propriétaire consultant son propre compte n'a rien à préciser → son propre id.
//  - Un admin/super_admin doit explicitement préciser ?proprietaire_id=... en query : il n'est
//    propriétaire d'aucun bien lui-même, donc sans ce paramètre il n'y a rien à montrer.
//    Contrairement à resoudreCibleAction (création), l'admin n'a pas besoin d'autorisation
//    supplémentaire ici : la supervision en lecture lui est ouverte sur n'importe quel compte.
// Retourne null si la requête ne peut être rattachée à aucun propriétaire (à traiter comme un
// 400/403 par l'appelant).
function resoudreProprietaireConsulte(req) {
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const proprietaireIdCible = req.query.proprietaire_id;

  if (roles.includes('proprietaire') && !proprietaireIdCible) {
    return req.user.id;
  }
  if ((roles.includes('admin') || roles.includes('super_admin')) && proprietaireIdCible) {
    return proprietaireIdCible;
  }
  return null;
}

// Vérifie que l'utilisateur connecté (le propriétaire lui-même, son agent en délégation, ou un
// admin) est autorisé à agir sur une ressource appartenant à `proprietaireId`. Version générique
// utilisée quand la ressource (contrat, demande...) est déjà chargée et qu'il ne reste qu'à
// vérifier le droit d'accès à son propriétaire.
async function estAutoriseSurProprietaire(req, proprietaireId) {
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  if (roles.includes('admin') || roles.includes('super_admin')) return true;
  if (roles.includes('proprietaire') && req.user.id === proprietaireId) return true;
  if (roles.includes('agent')) {
    const resultat = await pool.query('SELECT agent_id, autorise_agent_gestion FROM users WHERE id = $1', [proprietaireId]);
    if (resultat.rows.length === 0) return false;
    return resultat.rows[0].agent_id === req.user.id && resultat.rows[0].autorise_agent_gestion;
  }
  return false;
}
