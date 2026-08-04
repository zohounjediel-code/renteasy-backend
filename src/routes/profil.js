const express = require('express');
const router = express.Router();
const { authentifier } = require('../middleware/auth');
const { obtenirProfil, modifierProfil, changerMotDePasse, modifierDelegationAgent, journalAgentProprietaire } = require('../controllers/profilController');

router.use(authentifier);

router.get('/', obtenirProfil);
router.put('/', modifierProfil);
router.patch('/mot-de-passe', changerMotDePasse);
router.patch('/delegation-agent', modifierDelegationAgent);
router.get('/journal-agent', journalAgentProprietaire);

module.exports = router;
