// Tests fonctionnels de src/controllers/bienController.js — CRUD des biens, avec un accent
// particulier sur les vérifications d'autorisation (un propriétaire ne doit jamais pouvoir
// lire/modifier/supprimer le bien d'un autre) et sur les garde-fous métier (un bien occupé ne
// peut pas être modifié/supprimé, un bien avec historique de contrat ne peut pas être supprimé).
// Même technique que test/paiements.test.js : pool.query mocké directement sur l'instance
// partagée (delegationAgent.js et bienController.js importent le même singleton, donc un seul
// mock suffit pour les deux).
const { test, describe, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/database');
const { creerBien, listerBiens, obtenirBien, modifierBien, supprimerBien } = require('../src/controllers/bienController');

function fauxRes() {
  return {
    statutCode: 200,
    corps: null,
    status(code) { this.statutCode = code; return this; },
    json(payload) { this.corps = payload; return this; },
  };
}

describe('creerBien', () => {
  test('renvoie 400 si ville, type_bien ou loyer_mensuel manque', async () => {
    const req = { body: { ville: 'Cotonou' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await creerBien(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 400 si l\'adresse manque pour un bien immobilier (pas un véhicule)', async () => {
    const req = { body: { ville: 'Cotonou', type_bien: 'appartement', loyer_mensuel: 50000 }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await creerBien(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('un véhicule n\'a pas besoin d\'adresse', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('INSERT INTO biens')) return { rows: [{ id: 'b1', numero_bien: 'BJ-001', ville: 'Cotonou', adresse: null, type_bien: 'vehicule' }] };
      return { rows: [] };
    });
    const req = { body: { ville: 'Cotonou', type_bien: 'vehicule', loyer_mensuel: 15000, lieu_depot: 'Gare' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await creerBien(req, res);
    assert.equal(res.statutCode, 201);
  });

  test('un propriétaire crée un bien pour lui-même sans avoir à préciser proprietaire_id', async () => {
    let paramsInsert = null;
    mock.method(pool, 'query', async (sql, params) => {
      if (sql.includes('INSERT INTO biens')) { paramsInsert = params; return { rows: [{ id: 'b1', numero_bien: 'BJ-001', ville: 'Cotonou', adresse: 'Rue 1' }] }; }
      return { rows: [] };
    });
    const req = { body: { ville: 'Cotonou', type_bien: 'appartement', loyer_mensuel: 50000, adresse: 'Rue 1' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await creerBien(req, res);
    assert.equal(res.statutCode, 201);
    assert.equal(paramsInsert[0], 'prop-1'); // proprietaire_id = l'utilisateur connecté
    assert.equal(paramsInsert[10], null); // effectue_par_agent_id = null (pas de délégation)
  });

  test('un agent ne peut pas créer un bien pour un propriétaire non assigné/sans délégation', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes("role LIKE '%proprietaire%'")) return { rows: [] }; // proprietaire_id cible introuvable
      return { rows: [] };
    });
    const req = { body: { ville: 'Cotonou', type_bien: 'appartement', loyer_mensuel: 50000, adresse: 'Rue 1', proprietaire_id: 'prop-inconnu' }, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await creerBien(req, res);
    assert.equal(res.statutCode, 403);
  });

  test('un locataire (rôle non habilité) ne peut pas créer de bien pour un tiers', async () => {
    const req = { body: { ville: 'Cotonou', type_bien: 'appartement', loyer_mensuel: 50000, adresse: 'Rue 1', proprietaire_id: 'prop-1' }, user: { id: 'loc-1', role: 'locataire' } };
    const res = fauxRes();
    await creerBien(req, res);
    assert.equal(res.statutCode, 403);
  });
});

describe('listerBiens', () => {
  test('renvoie 400 pour un admin sans proprietaire_id en query', async () => {
    const req = { query: {}, user: { id: 'admin-1', role: 'admin' } };
    const res = fauxRes();
    await listerBiens(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('un propriétaire ne voit que ses propres biens', async () => {
    let paramsQuery = null;
    mock.method(pool, 'query', async (sql, params) => {
      paramsQuery = params;
      return { rows: [{ id: 'b1' }, { id: 'b2' }] };
    });
    const req = { query: {}, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await listerBiens(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(paramsQuery[0], 'prop-1');
    assert.equal(res.corps.length, 2);
  });
});

describe('obtenirBien', () => {
  test('renvoie 404 si le bien n\'existe pas ou n\'appartient pas au propriétaire', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = { params: { id: 'b1' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await obtenirBien(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('un propriétaire ne peut PAS accéder au bien d\'un autre propriétaire', async () => {
    // La requête filtre par proprietaire_id = req.user.id ; simuler une base réelle qui ne
    // renvoie donc rien pour ce user_id, même si le bien existe pour quelqu'un d'autre.
    let paramsQuery = null;
    mock.method(pool, 'query', async (sql, params) => { paramsQuery = params; return { rows: [] }; });
    const req = { params: { id: 'b-appartient-a-un-autre' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await obtenirBien(req, res);
    assert.equal(res.statutCode, 404);
    assert.deepEqual(paramsQuery, ['b-appartient-a-un-autre', 'prop-1']);
  });

  test('un admin peut accéder à n\'importe quel bien (sans filtre proprietaire_id)', async () => {
    let sqlUtilisee = null;
    mock.method(pool, 'query', async (sql) => { sqlUtilisee = sql; return { rows: [{ id: 'b1', proprietaire_id: 'quelquun-dautre' }] }; });
    const req = { params: { id: 'b1' }, user: { id: 'admin-1', role: 'admin' } };
    const res = fauxRes();
    await obtenirBien(req, res);
    assert.equal(res.statutCode, 200);
    assert.doesNotMatch(sqlUtilisee, /proprietaire_id = \$2/);
  });
});

describe('modifierBien', () => {
  test('renvoie 404 si le bien n\'appartient pas à ce propriétaire', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = { params: { id: 'b1' }, body: { ville: 'Porto-Novo' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await modifierBien(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('renvoie 409 si le bien est occupé', async () => {
    mock.method(pool, 'query', async () => ({ rows: [{ id: 'b1', statut: 'occupe' }] }));
    const req = { params: { id: 'b1' }, body: { ville: 'Porto-Novo' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await modifierBien(req, res);
    assert.equal(res.statutCode, 409);
  });

  test('modifie un bien libre appartenant au propriétaire', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('SELECT id, statut FROM biens')) return { rows: [{ id: 'b1', statut: 'libre' }] };
      if (sql.includes('UPDATE biens SET')) return { rows: [{ id: 'b1', ville: 'Porto-Novo' }] };
      return { rows: [] };
    });
    const req = { params: { id: 'b1' }, body: { ville: 'Porto-Novo' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await modifierBien(req, res);
    assert.equal(res.statutCode, 200);
  });
});

describe('supprimerBien', () => {
  test('renvoie 404 si le bien n\'appartient pas à ce propriétaire', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = { params: { id: 'b1' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await supprimerBien(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('renvoie 409 si le bien est occupé', async () => {
    mock.method(pool, 'query', async () => ({ rows: [{ id: 'b1', statut: 'occupe' }] }));
    const req = { params: { id: 'b1' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await supprimerBien(req, res);
    assert.equal(res.statutCode, 409);
  });

  test('renvoie 409 si un historique de contrat existe, même résilié', async () => {
    let deleteAppele = false;
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('SELECT id, statut FROM biens')) return { rows: [{ id: 'b1', statut: 'libre' }] };
      if (sql.includes('SELECT id FROM contrats WHERE bien_id')) return { rows: [{ id: 'contrat-ancien' }] };
      if (sql.includes('DELETE FROM biens')) { deleteAppele = true; return { rows: [] }; }
      return { rows: [] };
    });
    const req = { params: { id: 'b1' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await supprimerBien(req, res);
    assert.equal(res.statutCode, 409);
    assert.equal(deleteAppele, false);
  });

  test('supprime un bien libre sans aucun historique de contrat', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('SELECT id, statut FROM biens')) return { rows: [{ id: 'b1', statut: 'libre' }] };
      if (sql.includes('SELECT id FROM contrats WHERE bien_id')) return { rows: [] };
      return { rows: [] };
    });
    const req = { params: { id: 'b1' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await supprimerBien(req, res);
    assert.equal(res.statutCode, 200);
  });
});
