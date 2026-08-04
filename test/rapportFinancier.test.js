// Tests unitaires de genererRapportCSV (src/utils/rapportFinancier.js). Le PDF n'est pas testé
// ici (rendu binaire peu adapté à des assertions automatisées) — il a été vérifié manuellement
// par rendu visuel lors de son développement. Ce fichier couvre la partie la plus fragile du
// CSV : l'échappement des champs contenant le séparateur ";", des guillemets, ou des retours à
// la ligne, qui casserait silencieusement l'ouverture dans Excel sans ces tests.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { genererRapportCSV } = require('../src/utils/rapportFinancier');

// Faux res Express minimal : capture les en-têtes et le contenu envoyé par res.send()
function fauxRes() {
  return {
    headers: {},
    corps: null,
    setHeader(cle, valeur) { this.headers[cle] = valeur; },
    send(contenu) { this.corps = contenu; },
  };
}

const paiementExemple = {
  montant: 50000,
  commission_renteasy: 2500,
  methode: 'mtn_momo',
  reference_transaction: 'REF-001',
  statut: 'reussi',
  date_paiement: '2026-07-05',
  mois_concerne: '2026-07-01',
  numero_bien: 'BJ-001',
  adresse: 'Rue 12',
  ville: 'Cotonou',
  locataire_nom: 'Jean K.',
  proprietaire_nom: 'Marie D.',
};

describe('genererRapportCSV', () => {
  test('pose les bons en-têtes HTTP (type CSV, pièce jointe nommée avec la période)', () => {
    const res = fauxRes();
    genererRapportCSV(res, { paiements: [paiementExemple], dateDebut: '2026-07-01', dateFin: '2026-07-31' });
    assert.equal(res.headers['Content-Type'], 'text/csv; charset=utf-8');
    assert.match(res.headers['Content-Disposition'], /attachment; filename="rapport-financier_2026-07-01_au_2026-07-31\.csv"/);
  });

  test('commence par un BOM UTF-8 (indispensable pour les accents dans Excel)', () => {
    const res = fauxRes();
    genererRapportCSV(res, { paiements: [paiementExemple], dateDebut: '2026-07-01', dateFin: '2026-07-31' });
    assert.equal(res.corps.charCodeAt(0), 0xFEFF);
  });

  test('contient une ligne d\'en-têtes et une ligne par paiement', () => {
    const res = fauxRes();
    genererRapportCSV(res, { paiements: [paiementExemple, paiementExemple], dateDebut: '2026-07-01', dateFin: '2026-07-31' });
    const lignes = res.corps.replace('\uFEFF', '').split('\r\n');
    assert.match(lignes[0], /^Date de paiement;/);
    assert.equal(lignes.length, 1 + 2 + 1 + 1); // en-têtes + 2 paiements + ligne vide + total
  });

  test('échappe un champ contenant le séparateur ";" en l\'entourant de guillemets', () => {
    const res = fauxRes();
    const paiement = { ...paiementExemple, adresse: 'Rue 12; Immeuble B' };
    genererRapportCSV(res, { paiements: [paiement], dateDebut: '2026-07-01', dateFin: '2026-07-31' });
    assert.match(res.corps, /"Rue 12; Immeuble B"/);
  });

  test('échappe les guillemets internes en les doublant', () => {
    const res = fauxRes();
    const paiement = { ...paiementExemple, proprietaire_nom: 'Jean "JJ" Koffi' };
    genererRapportCSV(res, { paiements: [paiement], dateDebut: '2026-07-01', dateFin: '2026-07-31' });
    assert.match(res.corps, /"Jean ""JJ"" Koffi"/);
  });

  test('la ligne de total additionne correctement montants et commissions', () => {
    const res = fauxRes();
    const paiements = [
      { ...paiementExemple, montant: 50000, commission_renteasy: 2500 },
      { ...paiementExemple, montant: 30000, commission_renteasy: 1500 },
    ];
    genererRapportCSV(res, { paiements, dateDebut: '2026-07-01', dateFin: '2026-07-31' });
    const ligneTotal = res.corps.split('\r\n').find(l => l.startsWith('TOTAL'));
    assert.ok(ligneTotal, 'la ligne TOTAL doit être présente');
    assert.match(ligneTotal, /80000/);
    assert.match(ligneTotal, /4000/);
  });

  test('un rapport sans paiement ne plante pas et produit un total à zéro', () => {
    const res = fauxRes();
    genererRapportCSV(res, { paiements: [], dateDebut: '2026-07-01', dateFin: '2026-07-31' });
    const ligneTotal = res.corps.split('\r\n').find(l => l.startsWith('TOTAL'));
    assert.match(ligneTotal, /TOTAL;;;;;;;;;0;0;/);
  });
});
