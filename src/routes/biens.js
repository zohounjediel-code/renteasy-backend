const express = require('express');
const router = express.Router();
const { authentifier, autoriser } = require('../middleware/auth');
const { uploadPhotosBien } = require('../middleware/uploadPhotosBien');
const { limiteurDemandes } = require('../middleware/rateLimiters');
const { verifierAccesBien } = require('../utils/delegationAgent');
const {
  creerBien,
  listerBiens,
  obtenirBien,
  obtenirBienParNumero,
  modifierBien,
  supprimerBien,
  toggleMarche,
  listerMarche,
  ajouterPhotosBien,
  supprimerPhotoBien,
  listerReservationsBien,
  listerDisponibilitesBienMarche,
  signalerAnnonce,
} = require('../controllers/bienController');

// Routes publiques marché
router.get('/marche/liste', listerMarche);
router.get('/marche/:id/reservations', listerDisponibilitesBienMarche);

// Toutes les routes biens nécessitent d'être connecté
router.use(authentifier);

// Création : ouverte aussi à l'agent, qui doit passer proprietaire_id et être en délégation
// (vérifié par resoudreCibleAction côté contrôleur)
router.post('/', autoriser('proprietaire', 'admin', 'super_admin', 'agent'), creerBien);

// Vérifie les droits sur CE bien précis avant que multer ne touche au disque — sans ce
// contrôle en amont, un agent authentifié (même sans délégation sur ce bien précis) pouvait
// soumettre cette route avec des fichiers volumineux : multer les écrivait sur disque AVANT
// que la vérification d'accès (jusque-là seulement dans le contrôleur) ne rejette la requête,
// laissant des fichiers orphelins jamais nettoyés.
async function verifierAccesBienAvantUpload(req, res, next) {
  try {
    const bien = await verifierAccesBien(req, req.params.id);
    if (!bien) return res.status(404).json({ message: 'Bien non trouvé' });
    next();
  } catch (err) {
    console.error('Erreur vérification accès bien (upload photos) :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Photos : ouvertes aussi à l'agent sur un bien existant, tant qu'il agit en délégation pour
// le propriétaire de ce bien précis (vérifié par verifierAccesBien, maintenant avant l'upload)
router.post(
  '/:id/photos',
  autoriser('proprietaire', 'admin', 'super_admin', 'agent'),
  verifierAccesBienAvantUpload,
  uploadPhotosBien.array('photos', 8),
  ajouterPhotosBien
);
router.delete('/:id/photos', autoriser('proprietaire', 'admin', 'super_admin', 'agent'), supprimerPhotoBien);

// Signalement d'une annonce : ouvert à TOUT utilisateur connecté (locataire, propriétaire,
// agent...) qui tombe sur une annonce du marché, pas seulement aux propriétaires — d'où sa
// position avant la restriction de rôle ci-dessous.
router.post('/marche/:id/signaler', limiteurDemandes, signalerAnnonce);

// Le reste (consultation, modification, suppression de SES PROPRES biens) reste réservé
// au propriétaire — l'agent consulte via ses routes dédiées en lecture seule (/api/agent/...)
router.use(autoriser('proprietaire', 'admin', 'super_admin'));

router.get('/', listerBiens);
router.get('/numero/:numero', obtenirBienParNumero);
router.get('/:id', obtenirBien);
router.put('/:id', modifierBien);
router.delete('/:id', supprimerBien);
router.patch('/:id/marche', toggleMarche);
router.get('/:id/reservations', listerReservationsBien);

module.exports = router;
