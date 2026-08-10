const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const { proprietairesDeAgent } = require('../controllers/superAdminController');
const {
  dashboardProprietaireAgent,
  biensProprietaireAgent,
  bienProprietaireAgent,
  locatairesProprietaireAgent,
  contratsProprietaireAgent,
  contratProprietaireAgent,
  impayesProprietaireAgent,
  paiementsProprietaireAgent,
  performanceAgent,
  monJournalAgent,
  journalProprietaireAgent,
  demandesMarcheAgent,
} = require('../controllers/agentController');

// Toutes les routes agent sont en LECTURE SEULE : un agent consulte les comptes de ses
// propriétaires assignés pour du support client, mais ne peut rien modifier depuis cet espace.
router.use(authentifier, autoriser('agent', 'admin', 'super_admin'));

router.get('/performance', performanceAgent);
router.get('/mon-journal', monJournalAgent);
router.get('/mes-proprietaires', proprietairesDeAgent);
router.get('/demandes-marche', demandesMarcheAgent);

router.get('/proprietaires/:proprietaireId/dashboard', dashboardProprietaireAgent);
router.get('/proprietaires/:proprietaireId/biens', biensProprietaireAgent);
router.get('/proprietaires/:proprietaireId/biens/:bienId', bienProprietaireAgent);
router.get('/proprietaires/:proprietaireId/locataires', locatairesProprietaireAgent);
router.get('/proprietaires/:proprietaireId/contrats', contratsProprietaireAgent);
router.get('/proprietaires/:proprietaireId/contrats/:contratId', contratProprietaireAgent);
router.get('/proprietaires/:proprietaireId/impayes', impayesProprietaireAgent);
router.get('/proprietaires/:proprietaireId/paiements', paiementsProprietaireAgent);
router.get('/proprietaires/:proprietaireId/journal', journalProprietaireAgent);

module.exports = router;
