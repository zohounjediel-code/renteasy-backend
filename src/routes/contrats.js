const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const {
  creerContrat,
  listerContrats,
  obtenirContrat,
  resilierContrat,
} = require('../controllers/contratController');

router.use(authentifier, autoriser('proprietaire', 'admin'));

router.post('/', creerContrat);
router.get('/', listerContrats);
router.get('/:id', obtenirContrat);
router.patch('/:id/resilier', resilierContrat);

module.exports = router;
