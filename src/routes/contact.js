const express = require('express');
const router = express.Router();
const { envoyerMessageContact } = require('../controllers/contactController');

// Route publique, sans authentification (visiteurs, demandes RGPD, comptes non créés).
router.post('/', envoyerMessageContact);

module.exports = router;
