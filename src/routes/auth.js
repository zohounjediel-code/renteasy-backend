const express = require('express');
const router = express.Router();
const { inscrire, connecter } = require('../controllers/authController');

router.post('/inscription', inscrire);
router.post('/connexion', connecter);

module.exports = router;
