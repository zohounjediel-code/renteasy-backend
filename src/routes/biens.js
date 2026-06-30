const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const {
  creerBien,
  listerBiens,
  obtenirBien,
  modifierBien,
  supprimerBien,
} = require('../controllers/bienController');

// Toutes les routes biens nécessitent d'être connecté en tant que propriétaire
router.use(authentifier, autoriser('proprietaire', 'admin'));

router.post('/', creerBien);
router.get('/', listerBiens);
router.get('/:id', obtenirBien);
router.put('/:id', modifierBien);
router.delete('/:id', supprimerBien);

module.exports = router;
