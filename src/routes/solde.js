const express = require('express');
const router = express.Router();
const { authentifier } = require('../middleware/auth');
const { obtenirSolde, rechargerSolde, retirerSolde, verifierTransaction } = require('../controllers/soldeController');

router.use(authentifier);

router.get('/', obtenirSolde);
router.post('/recharger', rechargerSolde);
router.post('/retirer', retirerSolde);
router.get('/transactions/:id/verifier', verifierTransaction);

module.exports = router;
