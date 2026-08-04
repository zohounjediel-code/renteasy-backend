const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const { limiteurPaiements } = require('../middleware/rateLimiters');
const {
  creerPaiement,
  telechargerQuittance,
  listerImpayes,
  listerPaiements,
  payerEcheanceSolde,
} = require('../controllers/paiementController');

router.use(limiteurPaiements);

router.use(authentifier);

// Seul un agent (collecte terrain) ou un admin peut désormais enregistrer un paiement manuel
router.post('/', autoriser('agent', 'admin', 'super_admin'), creerPaiement);
router.get('/', autoriser('proprietaire', 'admin', 'super_admin'), listerPaiements);
router.get('/impayes', autoriser('proprietaire', 'agent', 'admin', 'super_admin'), listerImpayes);
router.get('/:id/quittance', autoriser('proprietaire', 'agent', 'admin', 'super_admin'), telechargerQuittance);

// L'agent paie une échéance avec SON PROPRE solde, pour le compte d'un locataire dont il a
// recouvré l'argent en espèces (ou autre moyen hors app) sur le terrain. Fonctionne aussi pour
// un paiement partiel (tranche). Vérifié : l'agent doit être assigné au propriétaire du bien
// concerné (même logique d'autorisation que le reste du recouvrement terrain).
router.post('/:id/payer-solde', autoriser('agent', 'admin', 'super_admin'), payerEcheanceSolde);

module.exports = router;
