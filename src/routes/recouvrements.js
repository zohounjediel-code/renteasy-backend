const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const { creerRecouvrement, listerRecouvrements } = require('../controllers/recouvrementController');

router.use(authentifier, autoriser('agent', 'admin', 'super_admin'));

router.post('/', creerRecouvrement);
router.get('/', listerRecouvrements);

module.exports = router;
