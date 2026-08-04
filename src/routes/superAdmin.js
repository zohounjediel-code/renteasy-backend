const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const {
  obtenirStats, listerUtilisateurs, toggleActiverCompte,
  reassignerAgent, listerAgents, tousLesContrats, tousLesPaiements,
  tousLesBiens, tousLesLocataires,
  proprietairesDeAgent, monAgent, rapportFinancierRegional, journalGlobal,
  obtenirParametres, modifierCommission, modifierOperateurPaiement,
  fileModerationMarche, modererAnnonce, exporterRapportFinancier,
  listerAdmins, retrograderAdmin, listerSignalements, traiterSignalement,
  listerRappelsEnvoyes, listerErreurs
} = require('../controllers/superAdminController');

// Lecture : accessible à l'admin aussi (son propre dashboard/agents en dépendent).
// Activer/désactiver un compte : accessible à l'admin aussi (avec restriction interne : un admin
// ne peut pas désactiver un autre admin, seul un super_admin le peut — cf. toggleActiverCompte).
// Réassigner un agent : reste super_admin uniquement, pour garder une distinction réelle de
// privilège entre les deux rôles.
// Rapport financier régional : lecture seule (loyers/commissions/recouvrement par région),
// ouvert à admin comme super_admin — ne donne accès à aucune information de solde ou de
// retrait, qui reste exclusivement super_admin (routes /superadmin/contrats, /paiements
// ci-dessous, et tout /api/solde).
// Journal d'activité global : reste super_admin uniquement — c'est notamment ce qui permet de
// détecter un abus de la part d'un admin lui-même, ça n'aurait pas de sens qu'un admin y ait accès.
// Paramètres (taux de commission, clés API Mobile Money) : super_admin uniquement, pour les
// mêmes raisons que le journal — ce sont des réglages financiers et des secrets d'intégration.
router.use(authentifier);
router.get('/stats', autoriser('admin', 'super_admin'), obtenirStats);
router.get('/utilisateurs', autoriser('admin', 'super_admin'), listerUtilisateurs);
router.get('/agents', autoriser('admin', 'super_admin'), listerAgents);
router.get('/rapport-regional', autoriser('admin', 'super_admin'), rapportFinancierRegional);
router.patch('/utilisateurs/:id/toggle', autoriser('admin', 'super_admin'), toggleActiverCompte);
router.patch('/utilisateurs/:id/reassigner-agent', autoriser('super_admin'), reassignerAgent);
router.get('/admins', autoriser('super_admin'), listerAdmins);
router.patch('/utilisateurs/:id/retrograder', autoriser('super_admin'), retrograderAdmin);
router.get('/contrats', autoriser('super_admin'), tousLesContrats);
router.get('/paiements', autoriser('super_admin'), tousLesPaiements);
router.get('/paiements/export', autoriser('super_admin'), exporterRapportFinancier);
router.get('/biens', autoriser('super_admin'), tousLesBiens);
router.get('/locataires', autoriser('super_admin'), tousLesLocataires);
router.get('/journal', autoriser('super_admin'), journalGlobal);
router.get('/parametres', autoriser('super_admin'), obtenirParametres);
router.patch('/parametres/commission', autoriser('super_admin'), modifierCommission);
router.patch('/parametres/operateurs/:operateur', autoriser('super_admin'), modifierOperateurPaiement);
router.get('/marche', autoriser('super_admin'), fileModerationMarche);
router.patch('/marche/:id/moderer', autoriser('super_admin'), modererAnnonce);
router.get('/signalements', autoriser('super_admin'), listerSignalements);
router.patch('/signalements/:id', autoriser('super_admin'), traiterSignalement);
router.get('/rappels-echeances', autoriser('super_admin'), listerRappelsEnvoyes);
router.get('/erreurs', autoriser('super_admin'), listerErreurs);

module.exports = router;
module.exports.proprietairesDeAgent = proprietairesDeAgent;
module.exports.monAgent = monAgent;
