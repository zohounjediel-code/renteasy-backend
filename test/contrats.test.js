// Tests fonctionnels de src/controllers/contratController.js — accent sur les vérifications
// d'autorisation (un propriétaire ne doit jamais voir/résilier le contrat d'un autre) et sur les
// garde-fous métier à la création (bien libre, tarif proposé, locataire confirmé, pas de
// collision de dates). Même technique que test/paiements.test.js : pool.query mocké sur
// l'instance partagée. BREVO_API_KEY est effacée (cf. test/auth.test.js) pour qu'aucun email
// réel ne parte pendant creerContrat, qui notifie le locataire.
const { test, describe, mock, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/database');
const { creerContrat, obtenirContrat, resilierContrat, payerCautionSolde } = require('../src/controllers/contratController');

let brevoKeyOriginale;
before(() => {
  brevoKeyOriginale = process.env.BREVO_API_KEY;
  delete process.env.BREVO_API_KEY;
});
after(() => {
  if (brevoKeyOriginale) process.env.BREVO_API_KEY = brevoKeyOriginale;
});

function fauxRes() {
  return {
    statutCode: 200,
    corps: null,
    status(code) { this.statutCode = code; return this; },
    json(payload) { this.corps = payload; return this; },
  };
}

const BIEN_LIBRE = { id: 'bien-1', numero_bien: 'BJ-001', proprietaire_id: 'prop-1', statut: 'libre', tarifs: {} };
const LOCATAIRE_CONFIRME = { id: 'loc-1', nom: 'Jean K.', email: 'jean@test.local', user_id: 'user-loc-1', statut: 'confirme' };

function reqBase(overrides = {}) {
  return {
    body: {
      numero_bien: 'BJ-001', locataire_id: 'loc-1', date_debut: '2026-08-10',
      type_loyer: 'mensuel', loyer_mensuel: 50000, signature_proprietaire: 'Jean Propriétaire',
      ...overrides,
    },
    user: { id: 'prop-1', role: 'proprietaire' },
  };
}

// Configure les branches communes à un creerContrat qui va au bout (bien trouvé, locataire
// confirmé, pas de collision, insertion réussie) ; chaque test peut surcharger une branche pour
// tester un cas d'échec précis.
function mockerCreationStandard({ bien = BIEN_LIBRE, locataire = LOCATAIRE_CONFIRME, collision = [] } = {}) {
  mock.method(pool, 'query', async (sql, params) => {
    if (sql.includes('SELECT * FROM biens WHERE numero_bien')) return { rows: bien ? [bien] : [] };
    if (sql.includes('FROM locataires WHERE id = $1 AND proprietaire_id')) return { rows: locataire ? [locataire] : [] };
    if (sql.includes('WHERE c.bien_id = $1') && sql.includes('statut IN')) return { rows: collision };
    if (sql.includes('INSERT INTO contrats')) {
      return { rows: [{ id: 'contrat-1', bien_id: bien.id, locataire_id: params[1], statut: 'en_attente_signature', caution: params[6], statut_caution: 'en_attente' }] };
    }
    if (sql.includes('SELECT nom FROM users WHERE id')) return { rows: [{ nom: 'Jean Propriétaire' }] };
    return { rows: [] }; // notifications, journal agent, etc. — non pertinents pour ces tests
  });
}

describe('creerContrat', () => {
  test('renvoie 403 si l\'utilisateur n\'est pas autorisé à agir pour ce propriétaire', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] })); // proprietaire_id cible introuvable pour un agent
    const req = reqBase({ proprietaire_id: 'prop-inconnu' });
    req.user = { id: 'agent-1', role: 'agent' };
    const res = fauxRes();
    await creerContrat(req, res);
    assert.equal(res.statutCode, 403);
  });

  test('renvoie 400 si un champ obligatoire manque', async () => {
    const req = reqBase({ numero_bien: undefined });
    const res = fauxRes();
    await creerContrat(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 400 si la signature électronique est vide', async () => {
    const req = reqBase({ signature_proprietaire: '   ' });
    const res = fauxRes();
    await creerContrat(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 404 si le bien n\'appartient pas à ce propriétaire', async () => {
    mockerCreationStandard({ bien: null });
    const req = reqBase();
    const res = fauxRes();
    await creerContrat(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('renvoie 409 si le bien n\'est pas libre', async () => {
    mockerCreationStandard({ bien: { ...BIEN_LIBRE, statut: 'occupe' } });
    const req = reqBase();
    const res = fauxRes();
    await creerContrat(req, res);
    assert.equal(res.statutCode, 409);
  });

  test('renvoie 400 si le type de loyer n\'est pas dans les tarifs proposés par ce bien', async () => {
    mockerCreationStandard({ bien: { ...BIEN_LIBRE, tarifs: { annuel: 500000 } } });
    const req = reqBase({ type_loyer: 'mensuel' });
    const res = fauxRes();
    await creerContrat(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 404 si le locataire n\'est pas dans la liste de ce propriétaire', async () => {
    mockerCreationStandard({ locataire: null });
    const req = reqBase();
    const res = fauxRes();
    await creerContrat(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('renvoie 409 si le locataire n\'a pas encore confirmé la liaison', async () => {
    mockerCreationStandard({ locataire: { ...LOCATAIRE_CONFIRME, statut: 'en_attente' } });
    const req = reqBase();
    const res = fauxRes();
    await creerContrat(req, res);
    assert.equal(res.statutCode, 409);
  });

  test('renvoie 409 en cas de collision avec un contrat existant sur la même période', async () => {
    mockerCreationStandard({ collision: [{ id: 'contrat-existant', date_debut: '2026-08-01', date_fin: null }] });
    const req = reqBase();
    const res = fauxRes();
    await creerContrat(req, res);
    assert.equal(res.statutCode, 409);
  });

  test('crée le contrat en attente de signature locataire quand tout est valide', async () => {
    mockerCreationStandard();
    const req = reqBase();
    const res = fauxRes();
    await creerContrat(req, res);
    assert.equal(res.statutCode, 201);
    assert.equal(res.corps.contrat.statut, 'en_attente_signature');
  });

  test('calcule automatiquement la caution à 3 fois le loyer, quelle que soit la valeur envoyée par le client', async () => {
    mockerCreationStandard();
    const req = reqBase({ loyer_mensuel: 50000, caution: 1 }); // caution envoyée par erreur/malice : doit être ignorée
    const res = fauxRes();
    await creerContrat(req, res);
    assert.equal(res.statutCode, 201);
    assert.equal(res.corps.contrat.caution, 150000);
    assert.equal(res.corps.contrat.statut_caution, 'en_attente');
  });
});

describe('obtenirContrat', () => {
  test('renvoie 404 si le contrat n\'existe pas', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = { params: { id: 'c1' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await obtenirContrat(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('un propriétaire ne peut PAS accéder au contrat d\'un autre propriétaire', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM contrats c') && sql.includes('JOIN biens')) {
        return { rows: [{ id: 'c1', proprietaire_id: 'un-autre-proprietaire' }] };
      }
      return { rows: [] };
    });
    const req = { params: { id: 'c1' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await obtenirContrat(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('le propriétaire du contrat y accède, avec ses échéances', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM contrats c') && sql.includes('JOIN biens')) {
        return { rows: [{ id: 'c1', proprietaire_id: 'prop-1' }] };
      }
      if (sql.includes('FROM echeances WHERE contrat_id')) return { rows: [{ id: 'e1' }, { id: 'e2' }] };
      return { rows: [] };
    });
    const req = { params: { id: 'c1' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await obtenirContrat(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(res.corps.echeances.length, 2);
  });

  test('un admin accède à n\'importe quel contrat', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM contrats c') && sql.includes('JOIN biens')) {
        return { rows: [{ id: 'c1', proprietaire_id: 'quelquun-dautre' }] };
      }
      return { rows: [] };
    });
    const req = { params: { id: 'c1' }, user: { id: 'admin-1', role: 'admin' } };
    const res = fauxRes();
    await obtenirContrat(req, res);
    assert.equal(res.statutCode, 200);
  });
});

describe('resilierContrat', () => {
  test('renvoie 404 si le contrat n\'appartient pas à ce propriétaire', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM contrats c JOIN biens')) return { rows: [{ id: 'c1', proprietaire_id: 'un-autre' }] };
      return { rows: [] };
    });
    const req = { params: { id: 'c1' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await resilierContrat(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('résilie le contrat, libère le bien, et supprime uniquement les échéances futures en attente', async () => {
    const appelsQuery = [];
    mock.method(pool, 'query', async (sql, params) => {
      appelsQuery.push({ sql, params });
      if (sql.includes('FROM contrats c JOIN biens')) return { rows: [{ id: 'c1', bien_id: 'bien-1', proprietaire_id: 'prop-1' }] };
      return { rows: [] };
    });
    // resilierContrat ouvre désormais une transaction (le transfert de caution modifie un solde) :
    // pool.connect doit aussi être mocké, cf. test/paiements.test.js pour le modèle. caution_solde
    // à 0 fait ressortir transfererCautionFinContrat immédiatement (rien d'autre à mocker).
    mock.method(pool, 'connect', async () => ({
      async query(sql, params) {
        appelsQuery.push({ sql, params });
        if (sql.includes('caution_solde') && sql.includes('FROM contrats c')) {
          return { rows: [{ caution_solde: 0, numero_bien: 'BIEN-1', locataire_user_id: null, locataire_nom: 'Test' }] };
        }
        return { rows: [] };
      },
      release() {},
    }));
    const req = { params: { id: 'c1' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await resilierContrat(req, res);
    assert.equal(res.statutCode, 200);

    const sqlContrat = appelsQuery.find(a => a.sql.includes("SET statut = 'resilie'"));
    const sqlBien = appelsQuery.find(a => a.sql.includes("UPDATE biens SET statut = 'libre'"));
    const sqlEcheances = appelsQuery.find(a => a.sql.includes('DELETE FROM echeances'));
    assert.ok(sqlContrat, 'le contrat doit être marqué résilié');
    assert.ok(sqlBien, 'le bien doit être libéré');
    assert.match(sqlEcheances.sql, /statut = 'en_attente' AND date_limite > CURRENT_DATE/);
  });

  test('transfère ce qui reste en caution vers le solde principal du locataire à la résiliation', async () => {
    const appelsQuery = [];
    mock.method(pool, 'query', async (sql, params) => {
      appelsQuery.push({ sql, params });
      if (sql.includes('FROM contrats c JOIN biens')) return { rows: [{ id: 'c1', bien_id: 'bien-1', proprietaire_id: 'prop-1' }] };
      return { rows: [] };
    });
    mock.method(pool, 'connect', async () => ({
      async query(sql, params) {
        appelsQuery.push({ sql, params });
        if (sql.includes('caution_solde') && sql.includes('FROM contrats c')) {
          return { rows: [{ caution_solde: 150000, numero_bien: 'BIEN-1', locataire_user_id: 'loc-user-1', locataire_nom: 'Jean K.' }] };
        }
        return { rows: [] };
      },
      release() {},
    }));
    const req = { params: { id: 'c1' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await resilierContrat(req, res);
    assert.equal(res.statutCode, 200);

    const creditSolde = appelsQuery.find(a => a.sql.includes('UPDATE users SET solde = solde +'));
    assert.deepEqual(creditSolde.params, [150000, 'loc-user-1']);
    const mouvement = appelsQuery.find(a => a.sql.includes('INSERT INTO caution_mouvements'));
    assert.deepEqual(mouvement.params, ['c1', 150000]);
    const majContrat = appelsQuery.find(a => a.sql.includes("statut_caution = 'transferee'"));
    assert.ok(majContrat, 'le statut de caution doit passer à transferee');
  });
});

describe('payerCautionSolde', () => {
  const CONTRAT_ACTIF = {
    id: 'c1', caution: 150000, caution_solde: 0, statut: 'actif', statut_caution: 'en_attente',
    numero_bien: 'BJ-001', proprietaire_id: 'prop-1', locataire_user_id: 'loc-user-1',
  };

  function client() {
    return {
      async query(sql, params) {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('SELECT solde FROM users WHERE id = $1 FOR UPDATE')) return { rows: [{ solde: 200000 }] };
        return { rows: [] };
      },
      release() {},
    };
  }

  test('renvoie 403 si ce n\'est pas le locataire de ce contrat', async () => {
    mock.method(pool, 'query', async () => ({ rows: [CONTRAT_ACTIF] }));
    const req = { params: { id: 'c1' }, user: { id: 'un-autre-locataire', role: 'locataire' } };
    const res = fauxRes();
    await payerCautionSolde(req, res);
    assert.equal(res.statutCode, 403);
  });

  test('renvoie 409 si le contrat n\'est pas encore actif', async () => {
    mock.method(pool, 'query', async () => ({ rows: [{ ...CONTRAT_ACTIF, statut: 'en_attente_signature' }] }));
    const req = { params: { id: 'c1' }, user: { id: 'loc-user-1', role: 'locataire' } };
    const res = fauxRes();
    await payerCautionSolde(req, res);
    assert.equal(res.statutCode, 409);
  });

  test('renvoie 409 si la caution est déjà payée', async () => {
    mock.method(pool, 'query', async () => ({ rows: [{ ...CONTRAT_ACTIF, statut_caution: 'payee', caution_solde: 150000 }] }));
    const req = { params: { id: 'c1' }, user: { id: 'loc-user-1', role: 'locataire' } };
    const res = fauxRes();
    await payerCautionSolde(req, res);
    assert.equal(res.statutCode, 409);
  });

  test('renvoie 400 si le solde est insuffisant', async () => {
    mock.method(pool, 'query', async () => ({ rows: [CONTRAT_ACTIF] }));
    mock.method(pool, 'connect', async () => ({
      async query(sql) {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FOR UPDATE')) return { rows: [{ solde: 1000 }] };
        return { rows: [] };
      },
      release() {},
    }));
    const req = { params: { id: 'c1' }, user: { id: 'loc-user-1', role: 'locataire' } };
    const res = fauxRes();
    await payerCautionSolde(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('paie la caution intégralement depuis le solde et notifie le propriétaire', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM contrats c') && sql.includes('JOIN biens')) return { rows: [CONTRAT_ACTIF] };
      if (sql.includes('SELECT nom, email FROM users WHERE id')) return { rows: [{ nom: 'Prop.', email: 'prop@test.local' }] };
      return { rows: [] };
    });
    const appelsClient = [];
    mock.method(pool, 'connect', async () => {
      const c = client();
      const query = c.query.bind(c);
      c.query = async (sql, params) => { appelsClient.push({ sql, params }); return query(sql, params); };
      return c;
    });
    const req = { params: { id: 'c1' }, user: { id: 'loc-user-1', role: 'locataire' } };
    const res = fauxRes();
    await payerCautionSolde(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(res.corps.montant, 150000);

    const debit = appelsClient.find(a => a.sql.includes('UPDATE users SET solde = solde -'));
    assert.deepEqual(debit.params, [150000, 'loc-user-1']);
    const majCaution = appelsClient.find(a => a.sql.includes("statut_caution = 'payee'"));
    assert.deepEqual(majCaution.params, [150000, 'c1']);
  });
});
