const express = require('express');
const router = express.Router();
const { authentifier } = require('../middleware/auth');
const { listerNotifications, marquerLue, marquerToutesLues } = require('../controllers/notificationController');

router.use(authentifier);

router.get('/', listerNotifications);
router.patch('/:id/lire', marquerLue);
router.patch('/lire-tout', marquerToutesLues);

module.exports = router;
