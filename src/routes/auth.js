const express = require('express');
const router = express.Router();
const { inscrire, connecter, activerCompte, creerAgent, creerAdmin, ajouterRole, demanderReinitialisationMotDePasse, reinitialiserMotDePasse } = require('../controllers/authController');
const { authentifier, autoriser } = require('../middleware/auth');

router.post('/inscription', inscrire);
router.post('/connexion', connecter);
router.post('/activer-compte', activerCompte);
router.post('/mot-de-passe-oublie', demanderReinitialisationMotDePasse);
router.post('/reinitialiser-mot-de-passe', reinitialiserMotDePasse);

// Création de comptes par les admins
router.post('/creer-agent', authentifier, autoriser('admin', 'super_admin'), creerAgent);
router.post('/creer-admin', authentifier, autoriser('super_admin'), creerAdmin);
router.post('/ajouter-role', authentifier, autoriser('proprietaire', 'locataire'), ajouterRole);

module.exports = router;
