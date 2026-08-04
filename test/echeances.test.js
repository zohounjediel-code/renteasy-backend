// Tests unitaires de src/utils/echeances.js — logique de calcul de dates la plus critique et la
// plus sujette aux régressions silencieuses du projet (plusieurs bugs réels y ont déjà été
// trouvés et corrigés, cf. commentaires dans echeances.js lui-même).
//
// Exécution : npm test (depuis renteasy-backend), ou directement `node --test test/`.
// Ces tests supposent un serveur en UTC (comme ce conteneur) — cf. note dans le README de test.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  ajouterPeriode,
  calculerEcheanceDepuisDebut,
  genererDatesEcheances,
} = require('../src/utils/echeances');

describe('ajouterPeriode', () => {
  test('mensuel : avance d\'un mois', () => {
    const d = ajouterPeriode('2026-01-15', 'mensuel', 1);
    assert.equal(d.toISOString().slice(0, 10), '2026-02-15');
  });

  test('mensuel : gère le passage d\'année', () => {
    const d = ajouterPeriode('2026-12-10', 'mensuel', 2);
    assert.equal(d.toISOString().slice(0, 10), '2027-02-10');
  });

  test('hebdomadaire : avance de n*7 jours', () => {
    const d = ajouterPeriode('2026-01-01', 'hebdomadaire', 3);
    assert.equal(d.toISOString().slice(0, 10), '2026-01-22');
  });

  test('journalier : avance de n jours', () => {
    const d = ajouterPeriode('2026-01-30', 'journalier', 5);
    assert.equal(d.toISOString().slice(0, 10), '2026-02-04');
  });

  test('annuel : avance de n années', () => {
    const d = ajouterPeriode('2026-06-15', 'annuel', 1);
    assert.equal(d.toISOString().slice(0, 10), '2027-06-15');
  });

  test('n=0 renvoie la même date (utilisé pour tester la période de départ)', () => {
    const d = ajouterPeriode('2026-03-01', 'mensuel', 0);
    assert.equal(d.toISOString().slice(0, 10), '2026-03-01');
  });
});

describe('calculerEcheanceDepuisDebut', () => {
  test('mensuel : reprend le quantième de la date de début', () => {
    const r = calculerEcheanceDepuisDebut('2026-03-17', 'mensuel');
    assert.equal(r.jour_echeance, 17);
    assert.equal(r.jour_semaine_echeance, null);
  });

  test('mensuel : plafonne à 28 pour un début en fin de mois (évite les mois sans jour 29-31)', () => {
    const r = calculerEcheanceDepuisDebut('2026-01-31', 'mensuel');
    assert.equal(r.jour_echeance, 28);
  });

  test('hebdomadaire : retient le jour de la semaine du début', () => {
    // 2026-01-01 est un jeudi (getDay() = 4)
    const r = calculerEcheanceDepuisDebut('2026-01-01', 'hebdomadaire');
    assert.equal(r.jour_semaine_echeance, 4);
    assert.equal(r.jour_echeance, null);
  });

  test('annuel : retient le jour et le mois du début', () => {
    const r = calculerEcheanceDepuisDebut('2026-07-04', 'annuel');
    assert.equal(r.jour_echeance_annuel, 4);
    assert.equal(r.mois_echeance_annuel, 7);
  });

  test('journalier : aucun jour particulier', () => {
    const r = calculerEcheanceDepuisDebut('2026-01-01', 'journalier');
    assert.deepEqual(r, { jour_echeance: null, jour_semaine_echeance: null, jour_echeance_annuel: null, mois_echeance_annuel: null });
  });
});

describe('genererDatesEcheances', () => {
  test('mensuel : la période de démarrage elle-même n\'est jamais une échéance', () => {
    const contrat = { date_debut: '2026-01-15', type_loyer: 'mensuel', jour_echeance: 15, loyer_mensuel: 50000 };
    const echeances = genererDatesEcheances(contrat);
    assert.ok(echeances.length > 0);
    assert.notEqual(echeances[0].mois_concerne, '2026-01-15');
    assert.equal(echeances[0].mois_concerne, '2026-02-15');
  });

  test('mensuel : génère 12 échéances par défaut quand aucune date de fin n\'est fixée', () => {
    const contrat = { date_debut: '2026-01-01', type_loyer: 'mensuel', jour_echeance: 1, loyer_mensuel: 50000 };
    const echeances = genererDatesEcheances(contrat);
    assert.equal(echeances.length, 12);
  });

  test('mensuel : s\'arrête à la date de fin du contrat', () => {
    const contrat = { date_debut: '2026-01-01', date_fin: '2026-04-01', type_loyer: 'mensuel', jour_echeance: 1, loyer_mensuel: 50000 };
    const echeances = genererDatesEcheances(contrat);
    // Échéances attendues : février, mars (avril = date_fin elle-même, exclue par périodeDebut > fin
    // uniquement si strictement après ; ici périodeDebut du 4e mois == fin donc incluse)
    assert.ok(echeances.length >= 2);
    for (const e of echeances) {
      assert.ok(new Date(e.mois_concerne) <= new Date(contrat.date_fin));
    }
  });

  test('hebdomadaire : ancre chaque échéance sur le même jour de semaine que le début', () => {
    // 2026-01-01 est un jeudi
    const contrat = { date_debut: '2026-01-01', type_loyer: 'hebdomadaire', jour_semaine_echeance: 4, loyer_mensuel: 10000 };
    const echeances = genererDatesEcheances(contrat, null, 4);
    for (const e of echeances) {
      assert.equal(new Date(e.mois_concerne).getUTCDay(), 4);
    }
  });

  test('annuel : ancre chaque échéance sur le même jour/mois que le début', () => {
    const contrat = { date_debut: '2026-03-10', type_loyer: 'annuel', jour_echeance_annuel: 10, mois_echeance_annuel: 3, loyer_mensuel: 600000 };
    const echeances = genererDatesEcheances(contrat, null, 3);
    for (const e of echeances) {
      const d = new Date(e.mois_concerne);
      assert.equal(d.getUTCDate(), 10);
      assert.equal(d.getUTCMonth(), 2); // mars = index 2
    }
  });

  // Régression : un contrat plus court qu'une période complète du type de loyer choisi (ex :
  // bail "mensuel" de 10 jours) ne générait auparavant AUCUNE échéance — le loyer n'était jamais
  // réclamé. Le filet de rattrapage dans genererDatesEcheances doit produire une échéance unique,
  // due à la date de fin.
  test('régression : contrat plus court qu\'une période complète produit une échéance unique due à la date de fin', () => {
    const contrat = { date_debut: '2026-01-01', date_fin: '2026-01-10', type_loyer: 'mensuel', jour_echeance: 1, loyer_mensuel: 50000 };
    const echeances = genererDatesEcheances(contrat);
    assert.equal(echeances.length, 1);
    assert.equal(echeances[0].date_limite, '2026-01-10');
  });

  test('régression : bail hebdomadaire de quelques jours produit aussi une échéance unique', () => {
    const contrat = { date_debut: '2026-01-01', date_fin: '2026-01-04', type_loyer: 'hebdomadaire', jour_semaine_echeance: 4, loyer_mensuel: 15000 };
    const echeances = genererDatesEcheances(contrat);
    assert.equal(echeances.length, 1);
  });
});
