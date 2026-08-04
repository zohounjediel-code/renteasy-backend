const express = require('express');
const router = express.Router();
const { authentifier } = require('../middleware/auth');
const { limiteurMessages } = require('../middleware/rateLimiters');
const { envoyerMessage, obtenirConversation, messagesNonLus } = require('../controllers/messageController');

router.use(limiteurMessages);
router.use(authentifier);

router.post('/', envoyerMessage);
router.get('/non-lus', messagesNonLus);
router.get('/:interlocuteur_id', obtenirConversation);

module.exports = router;
