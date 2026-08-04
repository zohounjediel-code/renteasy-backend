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

router.use(limiteurDemandes);

// Propriétaire soumet une demande sur un contrat
router.post('/contrats/:id/demande', authentifier, autoriser('proprietaire', 'admin', 'super_admin'), soumettreDemandeContrat);

// Agent : liste et traitement des demandes
router.get('/demandes', authentifier, autoriser('agent', 'admin', 'super_admin'), listerDemandes);
router.patch('/demandes/:id/approuver', authentifier, autoriser('agent', 'admin', 'super_admin'), approuverDemande);
router.patch('/demandes/:id/annuler', authentifier, autoriser('agent', 'admin', 'super_admin'), annulerDemande);

// Agent : fin de contrat automatique (résiliation ou renouvellement)
router.post('/demandes/:id/finaliser-resiliation', authentifier, autoriser('agent', 'admin', 'super_admin'), finaliserResiliationContrat);
router.post('/demandes/:id/renouveler', authentifier, autoriser('agent', 'admin', 'super_admin'), renouvelerContrat);

module.exports = router;
