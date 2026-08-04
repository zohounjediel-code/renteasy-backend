const PDFDocument = require('pdfkit');

function formaterMontant(nombre) {
  return Math.round(nombre).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

// Échappe une valeur pour un champ CSV. Séparateur ";" (pas ",") car c'est ce qu'Excel en
// paramètres régionaux français attend par défaut — sinon chaque ligne atterrit dans une seule
// colonne à l'ouverture.
function champCSV(valeur) {
  const str = String(valeur ?? '');
  if (/[";\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Génère le CSV et l'envoie directement en réponse HTTP (téléchargement).
function genererRapportCSV(res, { paiements, dateDebut, dateFin }) {
  const entetes = [
    'Date de paiement', 'Mois concerné', 'N° bien', 'Adresse', 'Ville',
    'Locataire', 'Propriétaire', 'Méthode', 'Référence',
    'Montant (FCFA)', 'Commission RentEasy (FCFA)', 'Statut',
  ];
  const lignes = [entetes.map(champCSV).join(';')];

  for (const p of paiements) {
    lignes.push([
      new Date(p.date_paiement).toLocaleDateString('fr-FR'),
      new Date(p.mois_concerne).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
      p.numero_bien || '',
      p.adresse,
      p.ville,
      p.locataire_nom,
      p.proprietaire_nom,
      p.methode,
      p.reference_transaction || '',
      p.montant,
      p.commission_renteasy,
      p.statut,
    ].map(champCSV).join(';'));
  }

  const totalMontant = paiements.reduce((s, p) => s + p.montant, 0);
  const totalCommission = paiements.reduce((s, p) => s + p.commission_renteasy, 0);
  lignes.push('');
  lignes.push(['TOTAL', '', '', '', '', '', '', '', '', totalMontant, totalCommission, ''].map(champCSV).join(';'));

  // BOM UTF-8 en tête : sans lui, Excel affiche mal les accents français à l'ouverture directe.
  const contenu = '\uFEFF' + lignes.join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="rapport-financier_${dateDebut}_au_${dateFin}.csv"`);
  return res.send(contenu);
}

// Génère le PDF et le stream directement en réponse HTTP (téléchargement).
function genererRapportPDF(res, { paiements, dateDebut, dateFin }) {
  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="rapport-financier_${dateDebut}_au_${dateFin}.pdf"`);
  doc.pipe(res);

  const colonnes = [
    { titre: 'Date', largeur: 55 },
    { titre: 'Mois', largeur: 75 },
    { titre: 'N° bien', largeur: 60 },
    { titre: 'Adresse', largeur: 150 },
    { titre: 'Locataire', largeur: 100 },
    { titre: 'Propriétaire', largeur: 100 },
    { titre: 'Méthode', largeur: 70 },
    { titre: 'Montant', largeur: 80 },
    { titre: 'Commission', largeur: 80 },
  ];
  const xDepart = doc.page.margins.left;
  const largeurTotale = colonnes.reduce((s, c) => s + c.largeur, 0);

  function dessinerEnteteColonnes() {
    const y = doc.y;
    doc.rect(xDepart, y, largeurTotale, 18).fill('#7c3aed');
    let x = xDepart;
    doc.fontSize(8).fillColor('#fff');
    for (const col of colonnes) {
      doc.text(col.titre, x + 4, y + 5, { width: col.largeur - 6, lineBreak: false });
      x += col.largeur;
    }
    doc.y = y + 18;
    doc.fillColor('#000');
  }

  function nouvellePageSiNecessaire() {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage();
      doc.y = doc.page.margins.top;
      dessinerEnteteColonnes();
    }
  }

  // En-tête du rapport
  doc.fontSize(16).fillColor('#000').text('RentEasy Bénin', xDepart, doc.y);
  doc.fontSize(11).fillColor('#555').text('Rapport financier des paiements');
  doc.fontSize(9).text(`Période : du ${new Date(dateDebut).toLocaleDateString('fr-FR')} au ${new Date(dateFin).toLocaleDateString('fr-FR')}`);
  doc.text(`Généré le ${new Date().toLocaleDateString('fr-FR')} à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`);
  doc.moveDown();
  doc.fillColor('#000');
  dessinerEnteteColonnes();

  let ligneAlternee = false;
  for (const p of paiements) {
    nouvellePageSiNecessaire();
    const y = doc.y;
    const hauteurLigne = 16;

    if (ligneAlternee) {
      doc.rect(xDepart, y, largeurTotale, hauteurLigne).fill('#f5f3ff');
    }
    ligneAlternee = !ligneAlternee;

    const valeurs = [
      new Date(p.date_paiement).toLocaleDateString('fr-FR'),
      new Date(p.mois_concerne).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' }),
      p.numero_bien || '',
      `${p.adresse}, ${p.ville}`,
      p.locataire_nom,
      p.proprietaire_nom,
      p.methode,
      `${formaterMontant(p.montant)} F`,
      `${formaterMontant(p.commission_renteasy)} F`,
    ];
    let x = xDepart;
    doc.fontSize(8).fillColor('#000');
    valeurs.forEach((val, i) => {
      doc.text(String(val), x + 4, y + 4, { width: colonnes[i].largeur - 6, ellipsis: true, lineBreak: false });
      x += colonnes[i].largeur;
    });
    doc.y = y + hauteurLigne;
  }

  const totalMontant = paiements.reduce((s, p) => s + p.montant, 0);
  const totalCommission = paiements.reduce((s, p) => s + p.commission_renteasy, 0);

  nouvellePageSiNecessaire();
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#000').text(
    `${paiements.length} paiement(s) — Total encaissé : ${formaterMontant(totalMontant)} FCFA — Commission RentEasy : ${formaterMontant(totalCommission)} FCFA`,
    xDepart, doc.y, { width: largeurTotale }
  );

  doc.end();
}

module.exports = { genererRapportCSV, genererRapportPDF };
