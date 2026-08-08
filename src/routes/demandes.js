const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const { limiteurDemandes } = require('../middleware/rateLimiters');
const {
  soumettreDemandeContrat,
  listerDemandes,
  approuverDemande,
  annulerDemande,
  finaliserResiliationContrat,
  renouvelerContrat,
} = require('../controllers/demandeController');

// Ce routeur est monté sur '/api' (pas '/api/demandes', les chemins ci-dessous mélangent
// '/contrats/:id/demande' et '/demandes') : un router.use(limiteurDemandes) global toucherait
// donc TOUTE requête '/api/*', pas seulement les demandes. Le limiteur est donc posé route par
// route.

// Propriétaire soumet une demande sur un contrat
router.post('/contrats/:id/demande', limiteurDemandes, authentifier, autoriser('proprietaire', 'admin', 'super_admin'), soumettreDemandeContrat);

// Agent : liste et traitement des demandes
router.get('/demandes', authentifier, autoriser('agent', 'admin', 'super_admin'), listerDemandes);
router.patch('/demandes/:id/approuver', limiteurDemandes, authentifier, autoriser('agent', 'admin', 'super_admin'), approuverDemande);
router.patch('/demandes/:id/annuler', limiteurDemandes, authentifier, autoriser('agent', 'admin', 'super_admin'), annulerDemande);

// Agent : fin de contrat automatique (résiliation ou renouvellement)
router.post('/demandes/:id/finaliser-resiliation', limiteurDemandes, authentifier, autoriser('agent', 'admin', 'super_admin'), finaliserResiliationContrat);
router.post('/demandes/:id/renouveler', limiteurDemandes, authentifier, autoriser('agent', 'admin', 'super_admin'), renouvelerContrat);

module.exports = router;
