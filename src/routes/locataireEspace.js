const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const {
  dashboardLocataire,
  paiementsLocataire,
  quittanceLocataire,
  listerLiaisonsEnAttenteLocataire,
  accepterLiaison,
  refuserLiaison,
  listerContratsEnAttenteSignature,
  signerContrat,
  refuserContrat,
  obtenirContratLocataire,
  obtenirAgentDuContrat,
} = require('../controllers/locataireEspaceController');
const { telechargerContratPDF, demanderLocationMarche } = require('../controllers/contratController');
const { payerEcheanceSolde } = require('../controllers/paiementController');
const { soumettreDemandeResiliationLocataire } = require('../controllers/demandeController');

// Réservé au locataire lui-même : toutes les fonctions ci-dessous filtrent strictement sur
// l'identité du compte connecté (son propre user_id), y compris des actions sensibles (signer un
// contrat, payer une échéance). Un super_admin n'y a jamais eu d'accès fonctionnel réel malgré
// la permission précédente : mieux vaut la retirer plutôt que la laisser silencieusement cassée.
router.use(authentifier, autoriser('locataire'));

router.get('/dashboard', dashboardLocataire);
router.get('/paiements', paiementsLocataire);
router.get('/paiements/:id/quittance', quittanceLocataire);
router.get('/liaisons', listerLiaisonsEnAttenteLocataire);
router.post('/liaisons/:id/accepter', accepterLiaison);
router.post('/liaisons/:id/refuser', refuserLiaison);
router.get('/contrats-en-attente', listerContratsEnAttenteSignature);
router.get('/contrats/:id', obtenirContratLocataire);
router.get('/contrats/:id/pdf', telechargerContratPDF);
router.get('/contrats/:id/agent', obtenirAgentDuContrat);
router.post('/contrats/:id/signer', signerContrat);
router.post('/contrats/:id/refuser', refuserContrat);
router.post('/contrats/:id/demander-resiliation', soumettreDemandeResiliationLocataire);
router.post('/echeances/:id/payer', payerEcheanceSolde);
router.post('/marche/demander', demanderLocationMarche);

module.exports = router;
