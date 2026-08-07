const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

function formaterMontant(nombre) {
  return nombre.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

const LABELS_PERIODICITE = { journalier: 'par jour', hebdomadaire: 'par semaine', mensuel: 'par mois', annuel: 'par an' };
const JOURS_SEMAINE = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS_NOMS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

// Le jour d'échéance affiché doit correspondre au VRAI cycle du contrat : jour_echeance ne
// concerne que le loyer mensuel (repli à 5 en base même pour les autres périodicités, cf.
// creerContrat) — l'afficher tel quel pour un contrat hebdomadaire/annuel/journalier induisait
// en erreur sur un document légal signé par les deux parties.
function libelleJourEcheance(contrat) {
  const type = contrat.type_loyer || 'mensuel';
  if (type === 'hebdomadaire' && contrat.jour_semaine_echeance !== null && contrat.jour_semaine_echeance !== undefined) {
    return `chaque ${JOURS_SEMAINE[contrat.jour_semaine_echeance]}`;
  }
  if (type === 'annuel' && contrat.jour_echeance_annuel && contrat.mois_echeance_annuel) {
    return `chaque ${contrat.jour_echeance_annuel} ${MOIS_NOMS[contrat.mois_echeance_annuel - 1]}`;
  }
  if (type === 'journalier') return 'chaque jour';
  return `le ${contrat.jour_echeance} de chaque mois`;
}

function genererContratPDF({ contrat, bien, locataire, proprietaire }) {
  return new Promise((resolve, reject) => {
    const nomFichier = `contrat-${contrat.id}.pdf`;
    const dossier = path.join(__dirname, '..', '..', 'contrats_pdf');

    if (!fs.existsSync(dossier)) {
      fs.mkdirSync(dossier, { recursive: true });
    }

    const cheminFichier = path.join(dossier, nomFichier);
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(cheminFichier);

    doc.pipe(stream);

    // En-tête
    doc.fontSize(20).text('RentEasy Bénin', { align: 'center' });
    doc.fontSize(12).fillColor('#555').text('Contrat de location', { align: 'center' });
    doc.moveDown();
    doc.fillColor('#000');
    doc.fontSize(10).text(`Référence contrat : ${contrat.id}`);
    doc.text(`Date de création : ${new Date(contrat.created_at).toLocaleDateString('fr-FR')}`);
    doc.moveDown();

    // Parties
    doc.fontSize(12).text('ENTRE LES SOUSSIGNÉS', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).text('Le Propriétaire :');
    doc.text(`Nom : ${proprietaire.nom}`);
    doc.text(`Email : ${proprietaire.email}`);
    doc.text(`Téléphone : ${proprietaire.telephone}`);
    doc.moveDown(0.5);
    doc.text('Le Locataire :');
    doc.text(`Nom : ${locataire.nom}`);
    doc.text(`Téléphone : ${locataire.telephone}`);
    if (locataire.email) doc.text(`Email : ${locataire.email}`);
    if (locataire.numero_piece_identite) doc.text(`Pièce d'identité : ${locataire.numero_piece_identite}`);
    doc.moveDown();

    // Bien
    doc.fontSize(12).text('BIEN LOUÉ', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Adresse : ${bien.adresse || '—'}`);
    doc.text(`Ville : ${bien.ville}`);
    if (bien.quartier) doc.text(`Quartier : ${bien.quartier}`);
    doc.text(`Type : ${bien.type_bien}`);
    doc.moveDown();

    // Conditions
    doc.fontSize(12).text('CONDITIONS DE LOCATION', { underline: true });
    doc.moveDown(0.5);
    const LABELS_DUREE = { jours: 'jour(s)', semaines: 'semaine(s)', mois: 'mois', annees: 'année(s)' };
    doc.fontSize(10).text(`Date de début : ${new Date(contrat.date_debut).toLocaleDateString('fr-FR')}`);
    doc.text(`Durée du contrat : ${contrat.duree_valeur ? `${contrat.duree_valeur} ${LABELS_DUREE[contrat.duree_unite] || contrat.duree_unite} (fin le ${new Date(contrat.date_fin).toLocaleDateString('fr-FR')})` : 'Indéterminée'}`);
    doc.text(`Loyer (${LABELS_PERIODICITE[contrat.type_loyer] || LABELS_PERIODICITE.mensuel}) : ${formaterMontant(contrat.loyer_mensuel)} FCFA`);
    doc.text(`Jour d'échéance : ${libelleJourEcheance(contrat)}`);
    if (contrat.caution > 0) doc.text(`Caution : ${formaterMontant(contrat.caution)} FCFA`);
    doc.moveDown();

    // Clause RentEasy
    doc.fontSize(12).text('MANDAT DE GESTION', { underline: true });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#555').text(
      'Le propriétaire confie à RentEasy Bénin le mandat de gestion et de recouvrement des loyers ' +
      'dans le cadre du présent contrat. RentEasy Bénin percevra une commission de 5% sur chaque ' +
      'loyer collecté avec succès.'
    );
    doc.moveDown(2);

    // Signatures
    doc.fillColor('#000').fontSize(12).text('SIGNATURES', { underline: true });
    doc.moveDown();
    doc.fontSize(10);
    const ySignatures = doc.y;
    doc.text('Le Propriétaire :', 50, ySignatures);
    doc.text('Le Locataire :', 300, ySignatures);

    const zoneSignatureY = ySignatures + 18;

    if (contrat.signature_proprietaire && contrat.signature_proprietaire.startsWith('data:image')) {
      try {
        const base64 = contrat.signature_proprietaire.split(',')[1];
        doc.image(Buffer.from(base64, 'base64'), 50, zoneSignatureY, { width: 160, height: 60 });
      } catch (e) {
        doc.text('Signature : ___________________', 50, zoneSignatureY + 20);
      }
    } else {
      doc.text('Signature : ___________________', 50, zoneSignatureY + 20);
    }

    if (contrat.signature_locataire && contrat.signature_locataire.startsWith('data:image')) {
      try {
        const base64 = contrat.signature_locataire.split(',')[1];
        doc.image(Buffer.from(base64, 'base64'), 300, zoneSignatureY, { width: 160, height: 60 });
      } catch (e) {
        doc.text('Signature : ___________________', 300, zoneSignatureY + 20);
      }
    } else {
      doc.text('Signature : ___________________', 300, zoneSignatureY + 20);
    }

    doc.y = zoneSignatureY + 70;
    doc.text(`Date : ${contrat.date_signature_proprietaire ? new Date(contrat.date_signature_proprietaire).toLocaleDateString('fr-FR') : '___________________'}`, 50, doc.y);
    doc.text(`Date : ${contrat.date_signature_locataire ? new Date(contrat.date_signature_locataire).toLocaleDateString('fr-FR') : '___________________'}`, 300, doc.y - doc.currentLineHeight());

    doc.moveDown(2);
    doc.fontSize(8).fillColor('#aaa').text(
      `Document généré automatiquement par RentEasy Bénin · ${process.env.SUPPORT_EMAIL || 'renteasy243@gmail.com'}`,
      { align: 'center' }
    );

    doc.end();

    stream.on('finish', () => resolve(`contrats_pdf/${nomFichier}`));
    stream.on('error', reject);
  });
}

module.exports = { genererContratPDF };
