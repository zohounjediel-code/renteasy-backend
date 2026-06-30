const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const {
  creerPaiement,
  telechargerQuittance,
  listerImpayes,
  listerPaiements,
} = require('../controllers/paiementController');

router.use(authentifier);

// Un agent peut aussi enregistrer un paiement collecté sur le terrain
router.post('/', autoriser('proprietaire', 'agent', 'admin'), creerPaiement);
router.get('/', autoriser('proprietaire', 'admin'), listerPaiements);
router.get('/impayes', autoriser('proprietaire', 'agent', 'admin'), listerImpayes);
router.get('/:id/quittance', autoriser('proprietaire', 'agent', 'admin'), telechargerQuittance);

module.exports = router;
