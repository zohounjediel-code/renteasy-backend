const multer = require('multer');
const path = require('path');
const fs = require('fs');

const DOSSIER_PHOTOS = path.join(__dirname, '..', '..', 'biens_photos');

if (!fs.existsSync(DOSSIER_PHOTOS)) {
  fs.mkdirSync(DOSSIER_PHOTOS, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DOSSIER_PHOTOS),
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const nomFichier = `${req.params.id}-${Date.now()}-${Math.round(Math.random() * 1e6)}${extension}`;
    cb(null, nomFichier);
  },
});

function filtrerMedias(req, file, cb) {
  const typesImage = /jpeg|jpg|png|webp/;
  const typesVideo = /mp4|webm|mov|quicktime/;
  const extension = path.extname(file.originalname).toLowerCase();
  const estImage = typesImage.test(extension) && typesImage.test(file.mimetype);
  const estVideo = typesVideo.test(extension) || /^video\//.test(file.mimetype);
  if (estImage || estVideo) {
    return cb(null, true);
  }
  cb(new Error('Seules les images (JPEG, PNG, WEBP) et vidéos (MP4, WEBM, MOV) sont autorisées'));
}

const uploadPhotosBien = multer({
  storage,
  fileFilter: filtrerMedias,
  limits: { fileSize: 50 * 1024 * 1024, files: 8 }, // 50 Mo par fichier (vidéos), 8 fichiers max par envoi
});

module.exports = { uploadPhotosBien, DOSSIER_PHOTOS };
