// Tests fonctionnels de src/controllers/superAdminController.js — accent sur les garde-fous les
// plus sensibles : impossible de désactiver un super_admin, un admin ne peut pas désactiver un
// autre admin, un admin désactivé qui gère encore des agents doit d'abord les réassigner (sinon
// ils deviennent orphelins), et le reset de sécurité de autorise_agent_gestion quand un
// propriétaire change d'agent. Vérifie aussi que les clés API masquées (••••1234) affichées à
// l'écran ne sont jamais accidentellement réenregistrées comme la vraie valeur. Même technique
// de mock que test/biens.test.js ; BREVO_API_KEY effacée (reassignerAgent notifie par email).
const { test, describe, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/database');
const {
  obtenirParametres, modifierCommission, modifierOperateurPaiement, toggleActiverCompte, reassignerAgent,
} = require('../src/controllers/superAdminController');

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

describe('obtenirParametres (masquage des clés API)', () => {
  test('masque les clés sensibles mais laisse les champs non-sensibles en clair', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM parametres_plateforme')) return { rows: [{ cle: 'taux_commission', valeur: '0.05' }] };
      if (sql.includes('FROM parametres_operateurs')) {
        return { rows: [{ operateur: 'mtn', actif: true, cles: { base_url: 'https://sandbox.momodeveloper.mtn.com', subscription_key: 'abcd1234567890' } }] };
      }
      return { rows: [] };
    });
    const req = {};
    const res = fauxRes();
    await obtenirParametres(req, res);
    assert.equal(res.statutCode, 200);
    const mtn = res.corps.operateurs[0];
    assert.equal(mtn.cles.base_url, 'https://sandbox.momodeveloper.mtn.com'); // non sensible : inchangé
    assert.equal(mtn.cles.subscription_key.endsWith('7890'), true); // 4 derniers caractères visibles
    assert.doesNotMatch(mtn.cles.subscription_key, /abcd1234/); // le reste doit être masqué
  });
});

describe('modifierCommission', () => {
  test('renvoie 400 pour un taux hors de [0, 1]', async () => {
    const req = { body: { taux: 1.5 }, user: { id: 'super-1' } };
    const res = fauxRes();
    await modifierCommission(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 400 pour un taux non numérique', async () => {
    const req = { body: { taux: 'beaucoup' }, user: { id: 'super-1' } };
    const res = fauxRes();
    await modifierCommission(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('accepte un taux valide (ex : 0.05 = 5%)', async () => {
    let paramsInsert = null;
    mock.method(pool, 'query', async (sql, params) => {
      if (sql.includes('INSERT INTO parametres_plateforme')) paramsInsert = params;
      return { rows: [] };
    });
    const req = { body: { taux: 0.05 }, user: { id: 'super-1' } };
    const res = fauxRes();
    await modifierCommission(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(paramsInsert[0], 'taux_commission');
    assert.equal(paramsInsert[1], '0.05');
  });
});

describe('modifierOperateurPaiement', () => {
  test('renvoie 400 pour un opérateur inconnu', async () => {
    const req = { params: { operateur: 'orange_money' }, body: { actif: true }, user: { id: 'super-1' } };
    const res = fauxRes();
    await modifierOperateurPaiement(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('une valeur masquée (commence par •) n\'écrase pas la vraie clé enregistrée', async () => {
    let clesEnregistrees = null;
    mock.method(pool, 'query', async (sql, params) => {
      if (sql.includes('FROM parametres_operateurs')) {
        return { rows: [{ operateur: 'mtn', cles: { subscription_key: 'la-vraie-cle-secrete', api_user: 'user-existant' } }] };
      }
      if (sql.includes('UPDATE parametres_operateurs')) { clesEnregistrees = JSON.parse(params[2]); return { rows: [] }; }
      return { rows: [] };
    });
    const req = {
      params: { operateur: 'mtn' },
      body: { cles: { subscription_key: '••••••••1234', api_user: 'nouvel-utilisateur' } }, // seul api_user est une vraie saisie
      user: { id: 'super-1' },
    };
    const res = fauxRes();
    await modifierOperateurPaiement(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(clesEnregistrees.subscription_key, 'la-vraie-cle-secrete'); // pas écrasée par le masque
    assert.equal(clesEnregistrees.api_user, 'nouvel-utilisateur'); // la vraie saisie, elle, est prise en compte
  });
});

describe('toggleActiverCompte', () => {
  test('renvoie 403 : impossible de désactiver un super_admin', async () => {
    mock.method(pool, 'query', async () => ({ rows: [{ id: 'u1', actif: true, role: 'super_admin' }] }));
    const req = { params: { id: 'u1' }, body: {}, user: { id: 'admin-1', role: 'super_admin' } };
    const res = fauxRes();
    await toggleActiverCompte(req, res);
    assert.equal(res.statutCode, 403);
  });

  test('renvoie 403 : un admin (non super) ne peut pas désactiver un autre admin', async () => {
    mock.method(pool, 'query', async () => ({ rows: [{ id: 'u1', actif: true, role: 'admin' }] }));
    const req = { params: { id: 'u1' }, body: {}, user: { id: 'admin-2', role: 'admin' } };
    const res = fauxRes();
    await toggleActiverCompte(req, res);
    assert.equal(res.statutCode, 403);
  });

  test('renvoie 400 si on désactive un admin qui gère encore des agents, sans préciser à qui les réassigner', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('SELECT id, actif, role FROM users WHERE id')) return { rows: [{ id: 'u1', actif: true, role: 'admin' }] };
      if (sql.includes('gere_par_admin_id = $1')) return { rows: [{ total: '3' }] };
      return { rows: [] };
    });
    const req = { params: { id: 'u1' }, body: {}, user: { id: 'super-1', role: 'super_admin' } };
    const res = fauxRes();
    await toggleActiverCompte(req, res);
    assert.equal(res.statutCode, 400);
    assert.equal(res.corps.agents_geres, 3);
  });

  test('un super admin peut désactiver un admin sans agents gérés', async () => {
    let nouvelEtat = null;
    mock.method(pool, 'query', async (sql, params) => {
      if (sql.includes('SELECT id, actif, role FROM users WHERE id')) return { rows: [{ id: 'u1', actif: true, role: 'admin' }] };
      if (sql.includes('gere_par_admin_id = $1')) return { rows: [{ total: '0' }] };
      if (sql.includes('UPDATE users SET actif')) { nouvelEtat = params[0]; return { rows: [] }; }
      return { rows: [] };
    });
    const req = { params: { id: 'u1' }, body: {}, user: { id: 'super-1', role: 'super_admin' } };
    const res = fauxRes();
    await toggleActiverCompte(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(nouvelEtat, false);
  });

  test('réactive un compte propriétaire (pas admin, pas de logique de réassignation)', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('SELECT id, actif, role FROM users WHERE id')) return { rows: [{ id: 'u1', actif: false, role: 'proprietaire' }] };
      return { rows: [] };
    });
    const req = { params: { id: 'u1' }, body: {}, user: { id: 'super-1', role: 'super_admin' } };
    const res = fauxRes();
    await toggleActiverCompte(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(res.corps.actif, true);
  });
});

describe('reassignerAgent', () => {
  test('renvoie 400 si agent_id manque', async () => {
    const req = { params: { id: 'prop-1' }, body: {}, user: { id: 'super-1' } };
    const res = fauxRes();
    await reassignerAgent(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 404 si l\'agent cible n\'existe pas', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes("role LIKE '%agent%'")) return { rows: [] };
      return { rows: [] };
    });
    const req = { params: { id: 'prop-1' }, body: { agent_id: 'agent-inconnu' }, user: { id: 'super-1' } };
    const res = fauxRes();
    await reassignerAgent(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('réassigner à un NOUVEL agent réinitialise autorise_agent_gestion par sécurité', async () => {
    let paramsUpdate = null;
    mock.method(pool, 'query', async (sql, params) => {
      if (sql.includes("role LIKE '%agent%'")) return { rows: [{ id: 'agent-2' }] };
      if (sql.includes('SELECT nom, email, agent_id FROM users')) return { rows: [{ nom: 'Jean', email: 'jean@test.local', agent_id: 'agent-1' }] };
      if (sql.includes('UPDATE users SET agent_id')) { paramsUpdate = params; return { rows: [] }; }
      return { rows: [] };
    });
    const req = { params: { id: 'prop-1' }, body: { agent_id: 'agent-2' }, user: { id: 'super-1' } };
    const res = fauxRes();
    await reassignerAgent(req, res);
    assert.equal(res.statutCode, 200);
    assert.deepEqual(paramsUpdate, ['agent-2', 'prop-1']);
  });

  test('réassigner au MÊME agent ne fait rien (pas de reset, pas de notification)', async () => {
    let updateAppele = false;
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes("role LIKE '%agent%'")) return { rows: [{ id: 'agent-1' }] };
      if (sql.includes('SELECT nom, email, agent_id FROM users')) return { rows: [{ nom: 'Jean', email: 'jean@test.local', agent_id: 'agent-1' }] };
      if (sql.includes('UPDATE users SET agent_id')) { updateAppele = true; return { rows: [] }; }
      return { rows: [] };
    });
    const req = { params: { id: 'prop-1' }, body: { agent_id: 'agent-1' }, user: { id: 'super-1' } };
    const res = fauxRes();
    await reassignerAgent(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(updateAppele, false);
  });
});
