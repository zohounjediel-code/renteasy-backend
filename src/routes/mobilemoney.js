const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const { initierPaiementMobile, verifierPaiementMobile } = require('../controllers/mobilemoneyController');

router.use(authentifier);

// Initier un paiement (propriétaire ou agent peut déclencher)
router.post('/initier', autoriser('proprietaire', 'agent', 'admin'), initierPaiementMobile);

// Vérifier le statut (polling depuis le frontend après notification)
router.get('/statut/:reference', autoriser('proprietaire', 'agent', 'admin'), verifierPaiementMobile);

module.exports = router;
