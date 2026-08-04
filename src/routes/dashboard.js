const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const { obtenirDashboard } = require('../controllers/dashboardController');

router.get('/', authentifier, autoriser('proprietaire', 'admin', 'super_admin'), obtenirDashboard);

module.exports = router;
