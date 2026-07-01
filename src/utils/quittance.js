const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// Génère un PDF de quittance et le sauvegarde sur disque.
// Retourne le chemin relatif du fichier généré.
function genererQuittancePDF({ paiement, echeance, contrat, bien, locataire }) {
  return new Promise((resolve, reject) => {
    const nomFichier = `quittance-${paiement.id}.pdf`;
    const dossier = path.join(__dirname, '..', '..', 'quittances');

    if (!fs.existsSync(dossier)) {
      fs.mkdirSync(dossier, { recursive: true });
    }

    const cheminFichier = path.join(dossier, nomFichier);
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(cheminFichier);

    doc.pipe(stream);

    // En-tête
    doc.fontSize(20).text('RentEasy Bénin', { align: 'center' });
    doc.fontSize(12).fillColor('#555').text('Quittance de loyer', { align: 'center' });
    doc.moveDown(2);
    doc.fillColor('#000');

    // Informations générales
    doc.fontSize(10).text(`Référence quittance : ${paiement.id}`);
    doc.text(`Date de paiement : ${new Date(paiement.date_paiement).toLocaleDateString('fr-FR')}`);
    doc.text(`Mois concerné : ${new Date(echeance.mois_concerne).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}`);
    doc.moveDown();

    // Bien
    doc.fontSize(12).text('Bien loué', { underline: true });
    doc.fontSize(10).text(`Adresse : ${bien.adresse}, ${bien.quartier || ''} ${bien.ville}`);
    doc.moveDown();

    // Locataire
    doc.fontSize(12).text('Locataire', { underline: true });
    doc.fontSize(10).text(`Nom : ${locataire.nom}`);
    doc.text(`Téléphone : ${locataire.telephone}`);
    doc.moveDown();

    // Détail du paiement
    doc.fontSize(12).text('Détail du paiement', { underline: true });
    doc.fontSize(10).text(`Montant payé : ${formaterMontant(paiement.montant)} FCFA`);
    doc.text(`Méthode de paiement : ${formaterMethode(paiement.methode)}`);
    if (paiement.reference_transaction) {
      doc.text(`Référence transaction : ${paiement.reference_transaction}`);
    }
    doc.text(`Commission RentEasy (5%) : ${formaterMontant(paiement.commission_renteasy)} FCFA`);
    doc.moveDown();

    doc.fontSize(10).fillColor('#555').text(
      'Cette quittance est générée automatiquement par la plateforme RentEasy Bénin et fait foi de paiement.',
      { align: 'left' }
    );

    doc.end();

    stream.on('finish', () => resolve(`quittances/${nomFichier}`));
    stream.on('error', reject);
  });
}

// Formate un nombre avec des espaces normaux comme séparateurs de milliers
// (toLocaleString insère un espace insécable que la police par défaut de pdfkit affiche mal)
function formaterMontant(nombre) {
  return nombre.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function formaterMethode(methode) {
  const labels = {
    mtn_momo: 'MTN Mobile Money',
    moov_money: 'Moov Money',
    especes: 'Espèces',
    virement: 'Virement bancaire',
  };
  return labels[methode] || methode;
}

module.exports = { genererQuittancePDF };
