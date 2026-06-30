const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const {
  creerLocataire,
  listerLocataires,
  obtenirLocataire,
  modifierLocataire,
} = require('../controllers/locataireController');

router.use(authentifier, autoriser('proprietaire', 'admin'));

router.post('/', creerLocataire);
router.get('/', listerLocataires);
router.get('/:id', obtenirLocataire);
router.put('/:id', modifierLocataire);

module.exports = router;
