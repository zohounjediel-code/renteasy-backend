const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const { limiteurPaiements } = require('../middleware/rateLimiters');
const { initierPaiementMobile, verifierPaiementMobile } = require('../controllers/mobilemoneyController');

router.use(limiteurPaiements);
router.use(authentifier);

// Initier un paiement (propriétaire ou agent peut déclencher)
router.post('/initier', autoriser('proprietaire', 'agent', 'admin', 'super_admin'), initierPaiementMobile);

// Vérifier le statut (polling depuis le frontend après notification)
router.get('/statut/:reference', autoriser('proprietaire', 'agent', 'admin', 'super_admin'), verifierPaiementMobile);

module.exports = router;
