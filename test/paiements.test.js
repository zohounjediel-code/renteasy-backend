// Tests fonctionnels de src/controllers/paiementController.js — le cœur du mouvement d'argent
// de la plateforme (encaissement d'un loyer, répartition solde locataire/propriétaire/RentEasy).
// Même technique que test/erreurs.test.js et test/rappelsEcheances.test.js : pool.query (et ici
// aussi pool.connect, pour les paiements par solde qui utilisent une transaction) sont mockés
// directement, pas de vraie base.
//
// genererQuittancePDF (src/utils/quittance.js) n'est PAS mocké : elle écrit un vrai PDF sur
// disque (comportement déjà non testé/vérifié manuellement d'après test/README.md), donc on la
// laisse tourner réellement et on supprime les fichiers produits après coup, plutôt que
// d'ajouter la complexité d'un mock de module pour un rendu déjà couvert visuellement ailleurs.
const { test, describe, mock, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pool = require('../src/config/database');
const { creerPaiement, payerEcheanceSolde } = require('../src/controllers/paiementController');

const FICHIERS_QUITTANCE_GENERES = [];

function fauxRes() {
  return {
    statutCode: 200,
    corps: null,
    status(code) { this.statutCode = code; return this; },
    json(payload) { this.corps = payload; return this; },
    headersSent: false,
  };
}

const ECHEANCE_BASE = {
  id: 'echeance-1',
  montant_du: 50000,
  statut: 'impayee',
  mois_concerne: '2026-07-01',
  bien_id: 'bien-1',
  locataire_id: 'locataire-1',
  loyer_mensuel: 50000,
  adresse: 'Rue 12',
  ville: 'Cotonou',
  quartier: 'Fidjrossè',
  numero_bien: 'BJ-001',
  proprietaire_id: 'proprietaire-1',
  locataire_nom: 'Jean K.',
  locataire_telephone: '+22900000000',
};

describe('creerPaiement', () => {
  let appelsQuery;
  let sommeDejaPayee;

  beforeEach(() => {
    appelsQuery = [];
    sommeDejaPayee = 0;

    mock.method(pool, 'query', async (sql, params = []) => {
      appelsQuery.push({ sql, params });

      if (sql.includes('FROM echeances e') && sql.includes('JOIN contrats c')) {
        return { rows: [ECHEANCE_BASE] };
      }
      if (sql.includes('SELECT id FROM paiements WHERE reference_transaction')) {
        return { rows: [] }; // pas de doublon par référence, sauf override dans un test dédié
      }
      if (sql.includes("date_paiement > NOW() - INTERVAL '30 seconds'")) {
        return { rows: [] }; // pas de doublon récent, sauf override dans un test dédié
      }
      if (sql.includes('SELECT COALESCE(SUM(montant), 0) AS total FROM paiements')) {
        return { rows: [{ total: sommeDejaPayee }] };
      }
      if (sql.includes('SELECT cle, valeur FROM parametres_plateforme')) {
        return { rows: [{ cle: 'taux_commission', valeur: '0.05' }] };
      }
      if (sql.includes('INSERT INTO paiements')) {
        const [echeance_id, montant, methode, reference_transaction, commission] = params;
        sommeDejaPayee += montant;
        const paiement = {
          id: `paiement-${appelsQuery.length}`,
          echeance_id, montant, methode, reference_transaction, commission_renteasy: commission,
          statut: 'reussi', date_paiement: '2026-07-05',
        };
        return { rows: [paiement] };
      }
      if (sql.includes('UPDATE echeances SET statut')) {
        return { rows: [] };
      }
      if (sql.includes('UPDATE paiements SET quittance_url')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT nom, email, telephone FROM users WHERE id')) {
        return { rows: [{ nom: 'Marie D.', email: 'marie@example.com', telephone: '+22911111111' }] };
      }
      if (sql.includes('INSERT INTO notifications')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT * FROM parametres_operateurs')) {
        return { rows: [] }; // aucun opérateur configuré -> SMS inactif, pas d'appel réseau
      }
      if (sql.includes('INSERT INTO journal_activite_agent')) {
        return { rows: [] };
      }
      throw new Error(`Requête SQL non mockée dans ce test : ${sql}`);
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  after(() => {
    for (const chemin of FICHIERS_QUITTANCE_GENERES) {
      if (fs.existsSync(chemin)) fs.unlinkSync(chemin);
    }
  });

  function reqBase(body, overridesUser = {}) {
    return { body, user: { id: 'proprietaire-1', role: 'proprietaire', ...overridesUser } };
  }

  test('rejette un montant négatif malgré son caractère "truthy" en JS', async () => {
    const req = reqBase({ echeance_id: 'echeance-1', montant: -5000, methode: 'especes' });
    const res = fauxRes();
    await creerPaiement(req, res);
    assert.equal(res.statutCode, 400);
    assert.match(res.corps.message, /entier strictement positif/);
  });

  test('rejette un montant non entier', async () => {
    const req = reqBase({ echeance_id: 'echeance-1', montant: 5000.5, methode: 'especes' });
    const res = fauxRes();
    await creerPaiement(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('rejette un montant à zéro', async () => {
    const req = reqBase({ echeance_id: 'echeance-1', montant: 0, methode: 'especes' });
    const res = fauxRes();
    await creerPaiement(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('refuse un propriétaire qui tente de payer l\'échéance d\'un autre propriétaire', async () => {
    const req = reqBase({ echeance_id: 'echeance-1', montant: 50000, methode: 'especes' }, { id: 'un-autre-proprietaire' });
    const res = fauxRes();
    await creerPaiement(req, res);
    assert.equal(res.statutCode, 403);
  });

  test('enregistre un paiement complet, calcule la commission à 5% et marque l\'échéance "payee"', async () => {
    const req = reqBase({ echeance_id: 'echeance-1', montant: 50000, methode: 'especes' });
    const res = fauxRes();
    await creerPaiement(req, res);

    assert.equal(res.statutCode, 201);
    assert.equal(res.corps.paiement.commission_renteasy, 2500); // 5% de 50000
    assert.equal(res.corps.statut_echeance, 'payee');
    assert.ok(res.corps.paiement.quittance_url.startsWith('quittances/'));
    FICHIERS_QUITTANCE_GENERES.push(path.join(__dirname, '..', res.corps.paiement.quittance_url));
  });

  test('un paiement partiel laisse l\'échéance au statut "partielle"', async () => {
    const req = reqBase({ echeance_id: 'echeance-1', montant: 20000, methode: 'especes' });
    const res = fauxRes();
    await creerPaiement(req, res);

    assert.equal(res.statutCode, 201);
    assert.equal(res.corps.statut_echeance, 'partielle');
    assert.equal(res.corps.paiement.commission_renteasy, 1000); // 5% de 20000
    FICHIERS_QUITTANCE_GENERES.push(path.join(__dirname, '..', res.corps.paiement.quittance_url));
  });

  test('refuse un montant qui dépasse le reste dû sur l\'échéance', async () => {
    const req = reqBase({ echeance_id: 'echeance-1', montant: 999999, methode: 'especes' });
    const res = fauxRes();
    await creerPaiement(req, res);
    assert.equal(res.statutCode, 400);
    assert.match(res.corps.message, /dépasse le reste dû/);
  });

  test('refuse un paiement sur une échéance déjà entièrement payée', async () => {
    sommeDejaPayee = 50000; // déjà soldée avant même ce paiement
    const req = reqBase({ echeance_id: 'echeance-1', montant: 10000, methode: 'especes' });
    const res = fauxRes();
    await creerPaiement(req, res);
    assert.equal(res.statutCode, 409);
    assert.match(res.corps.message, /déjà entièrement payée/);
  });

  test('refuse une référence de transaction déjà utilisée pour un paiement réussi (anti-doublon webhook/double-clic)', async () => {
    mock.method(pool, 'query', async (sql, params = []) => {
      if (sql.includes('SELECT id FROM paiements WHERE reference_transaction')) {
        return { rows: [{ id: 'paiement-existant' }] };
      }
      if (sql.includes('FROM echeances e') && sql.includes('JOIN contrats c')) {
        return { rows: [ECHEANCE_BASE] };
      }
      throw new Error(`Requête SQL non mockée : ${sql}`);
    });

    const req = reqBase({ echeance_id: 'echeance-1', montant: 50000, methode: 'mtn_momo', reference_transaction: 'REF-DEJA-VU' });
    const res = fauxRes();
    await creerPaiement(req, res);
    assert.equal(res.statutCode, 409);
  });

  test('404 sur une échéance inexistante', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM echeances e') && sql.includes('JOIN contrats c')) {
        return { rows: [] };
      }
      throw new Error(`Requête SQL non mockée : ${sql}`);
    });

    const req = reqBase({ echeance_id: 'echeance-inconnue', montant: 50000, methode: 'especes' });
    const res = fauxRes();
    await creerPaiement(req, res);
    assert.equal(res.statutCode, 404);
  });
});

describe('payerEcheanceSolde', () => {
  let soldes;
  let appelsClient;

  function client() {
    return {
      async query(sql, params = []) {
        appelsClient.push({ sql, params });

        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('SELECT solde FROM users WHERE id = $1 FOR UPDATE')) {
          return { rows: [{ solde: soldes[params[0]] ?? 0 }] };
        }
        if (sql.includes("role LIKE '%super_admin%'")) {
          return { rows: [{ id: 'super-admin-1' }] };
        }
        if (sql.includes('UPDATE users SET solde = solde -')) {
          soldes[params[1]] = (soldes[params[1]] ?? 0) - params[0];
          return { rows: [] };
        }
        if (sql.includes('UPDATE users SET solde = solde +')) {
          soldes[params[1]] = (soldes[params[1]] ?? 0) + params[0];
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO paiements')) {
          const [echeance_id, montant, commission, paye_par_agent_id] = params;
          return { rows: [{ id: 'paiement-solde-1', echeance_id, montant, commission_renteasy: commission, paye_par_agent_id, methode: 'solde_renteasy', statut: 'reussi', date_paiement: '2026-07-05' }] };
        }
        if (sql.includes('UPDATE echeances SET statut')) {
          return { rows: [] };
        }
        throw new Error(`Requête SQL (client transaction) non mockée : ${sql}`);
      },
      release() {},
    };
  }

  beforeEach(() => {
    appelsClient = [];
    soldes = { 'locataire-user-1': 50000, 'proprietaire-1': 0, 'super-admin-1': 0 };

    mock.method(pool, 'connect', async () => client());
    mock.method(pool, 'query', async (sql, params = []) => {
      if (sql.includes('FROM echeances e') && sql.includes('JOIN contrats c')) {
        return { rows: [{ ...ECHEANCE_BASE, locataire_user_id: 'locataire-user-1', proprietaire_agent_id: null }] };
      }
      if (sql.includes('SELECT COALESCE(SUM(montant), 0) AS total FROM paiements')) {
        return { rows: [{ total: 0 }] };
      }
      if (sql.includes('SELECT nom, email, telephone FROM users WHERE id')) {
        return { rows: [{ nom: 'Marie D.', email: 'marie@example.com', telephone: '+22911111111' }] };
      }
      if (sql.includes('INSERT INTO notifications')) return { rows: [] };
      if (sql.includes('SELECT * FROM parametres_operateurs')) return { rows: [] };
      return { rows: [] };
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  after(() => {
    const chemin = path.join(__dirname, '..', 'quittances', 'quittance-paiement-solde-1.pdf');
    if (fs.existsSync(chemin)) fs.unlinkSync(chemin);
  });

  test('répartit correctement le paiement entre solde locataire, part propriétaire et commission RentEasy', async () => {
    const req = { params: { id: 'echeance-1' }, body: {}, user: { id: 'locataire-user-1', role: 'locataire' } };
    const res = fauxRes();
    await payerEcheanceSolde(req, res);

    assert.equal(res.statutCode, 201);
    assert.equal(soldes['locataire-user-1'], 0);      // 50000 - 50000
    assert.equal(soldes['proprietaire-1'], 47500);    // 50000 - 5% de commission
    assert.equal(soldes['super-admin-1'], 2500);      // commission RentEasy
  });

  test('refuse le paiement si le solde du payeur est insuffisant, sans toucher aux autres soldes', async () => {
    soldes['locataire-user-1'] = 10000; // insuffisant pour les 50000 dus
    const req = { params: { id: 'echeance-1' }, body: {}, user: { id: 'locataire-user-1', role: 'locataire' } };
    const res = fauxRes();
    await payerEcheanceSolde(req, res);

    assert.equal(res.statutCode, 400);
    assert.match(res.corps.message, /Solde insuffisant/);
    assert.equal(soldes['locataire-user-1'], 10000);
    assert.equal(soldes['proprietaire-1'], 0);
    assert.ok(appelsClient.some(a => a.sql === 'ROLLBACK'), 'la transaction doit être annulée (ROLLBACK)');
  });

  test('refuse un locataire qui tente de payer l\'échéance de quelqu\'un d\'autre', async () => {
    const req = { params: { id: 'echeance-1' }, body: {}, user: { id: 'un-autre-locataire', role: 'locataire' } };
    const res = fauxRes();
    await payerEcheanceSolde(req, res);
    assert.equal(res.statutCode, 403);
  });

  test('un paiement partiel via solde calcule la commission uniquement sur le montant réellement payé', async () => {
    const req = { params: { id: 'echeance-1' }, body: { montant: 20000 }, user: { id: 'locataire-user-1', role: 'locataire' } };
    const res = fauxRes();
    await payerEcheanceSolde(req, res);

    assert.equal(res.statutCode, 201);
    assert.equal(res.corps.statut_echeance, 'partielle');
    assert.equal(soldes['super-admin-1'], 1000);   // 5% de 20000
    assert.equal(soldes['proprietaire-1'], 19000); // 20000 - 1000
  });
});
