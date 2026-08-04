const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const {
  creerContrat,
  listerContrats,
  obtenirContrat,
  resilierContrat,
  telechargerContratPDF,
  listerDemandesLocataireProprio,
  approuverDemandeLocataire,
  refuserDemandeLocataire,
} = require('../controllers/contratController');

router.use(authentifier);

// Création : ouverte aussi à l'agent, qui doit passer proprietaire_id et être en délégation
// (vérifié par resoudreCibleAction côté contrôleur)
router.post('/', autoriser('proprietaire', 'admin', 'super_admin', 'agent'), creerContrat);

// Traitement des demandes de location/réservation du marché : ouvert aussi à l'agent en
// délégation, qui peut approuver/signer ou refuser à la place du propriétaire
// (vérifié par estAutoriseSurProprietaire côté contrôleur)
router.post('/:id/approuver', autoriser('proprietaire', 'admin', 'super_admin', 'agent'), approuverDemandeLocataire);
router.post('/:id/refuser-demande', autoriser('proprietaire', 'admin', 'super_admin', 'agent'), refuserDemandeLocataire);

// Le reste reste réservé au propriétaire — l'agent consulte via ses routes dédiées
// en lecture seule (/api/agent/...)
router.use(autoriser('proprietaire', 'admin', 'super_admin'));

router.get('/', listerContrats);
router.get('/demandes-locataires', listerDemandesLocataireProprio);
router.get('/:id', obtenirContrat);
router.patch('/:id/resilier', resilierContrat);
router.get('/:id/pdf', telechargerContratPDF);

module.exports = router;
