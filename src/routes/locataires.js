const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const {
  rechercherLocataire,
  demanderLiaisonLocataire,
  listerLocataires,
  listerLiaisonsEnAttente,
  annulerLiaison,
  obtenirLocataire,
  modifierLocataire,
  supprimerLocataire,
} = require('../controllers/locataireController');

router.use(authentifier);

// Recherche + demande de liaison : ouvertes aussi à l'agent, qui doit passer proprietaire_id
// et être en délégation (vérifié par resoudreCibleAction côté contrôleur)
router.get('/rechercher', autoriser('proprietaire', 'admin', 'super_admin', 'agent'), rechercherLocataire);
router.post('/demander', autoriser('proprietaire', 'admin', 'super_admin', 'agent'), demanderLiaisonLocataire);

// Le reste reste réservé au propriétaire — l'agent consulte via ses routes dédiées
// en lecture seule (/api/agent/...)
router.use(autoriser('proprietaire', 'admin', 'super_admin'));

router.get('/en-attente', listerLiaisonsEnAttente);
router.delete('/en-attente/:id', annulerLiaison);
router.get('/', listerLocataires);
router.get('/:id', obtenirLocataire);
router.put('/:id', modifierLocataire);
router.delete('/:id', supprimerLocataire);

module.exports = router;
