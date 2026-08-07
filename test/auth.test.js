// Tests fonctionnels de src/controllers/authController.js — inscription, connexion, activation
// de compte, réinitialisation de mot de passe, ajout de rôle. Même technique que
// test/paiements.test.js : pool.query est mocké directement sur l'instance partagée, pas de
// vraie base. bcrypt et jwt ne sont PAS mockés (fonctions pures, rapides, et c'est justement
// leur comportement réel — hash, comparaison, signature — qu'on veut vérifier).
//
// BREVO_API_KEY est explicitement effacée avant les tests de réinitialisation de mot de passe :
// le .env local peut légitimement contenir une vraie clé (pour tester l'envoi d'email en
// conditions réelles ailleurs), et il ne faut surtout pas qu'un `npm test` déclenche un envoi
// réel vers une fausse adresse de test.
const { test, describe, mock, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const pool = require('../src/config/database');
const {
  inscrire, connecter, activerCompte, ajouterRole,
  demanderReinitialisationMotDePasse, reinitialiserMotDePasse,
} = require('../src/controllers/authController');

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
    cookiesDefinis: [],
    cookiesEffaces: [],
    status(code) { this.statutCode = code; return this; },
    json(payload) { this.corps = payload; return this; },
    cookie(nom, valeur, options) { this.cookiesDefinis.push({ nom, valeur, options }); return this; },
    clearCookie(nom, options) { this.cookiesEffaces.push({ nom, options }); return this; },
  };
}

describe('inscrire', () => {
  let appelsQuery;
  beforeEach(() => { appelsQuery = []; });

  test('renvoie 400 si un champ obligatoire manque', async () => {
    const req = { body: { nom: 'Jean', email: 'jean@test.local', mot_de_passe: 'abcdefgh', cgu_acceptees: true } };
    const res = fauxRes();
    await inscrire(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 400 si les CGU ne sont pas acceptées', async () => {
    const req = { body: { nom: 'Jean', email: 'jean@test.local', telephone: '+22900000000', mot_de_passe: 'abcdefgh', cgu_acceptees: false } };
    const res = fauxRes();
    await inscrire(req, res);
    assert.equal(res.statutCode, 400);
    assert.match(res.corps.message, /conditions générales/);
  });

  test('un email avec espaces en trop est nettoyé avant la recherche en base', async () => {
    mock.method(pool, 'query', async (sql, params) => {
      appelsQuery.push({ sql, params });
      if (sql.includes('SELECT id, role FROM users WHERE email')) return { rows: [] };
      if (sql.includes('INSERT INTO users')) return { rows: [{ id: 'u1', nom: 'Jean', email: 'jean@test.local', telephone: '+22900000000', role: 'proprietaire', ville: null, agent_id: null, created_at: '2026-08-07' }] };
      return { rows: [] };
    });
    const req = { body: { nom: 'Jean', email: '  jean@test.local  ', telephone: '+22900000000', mot_de_passe: 'abcdefgh', cgu_acceptees: true } };
    const res = fauxRes();
    await inscrire(req, res);
    assert.equal(appelsQuery[0].params[0], 'jean@test.local');
  });

  test('un rôle invalide/absent retombe sur "proprietaire" par défaut', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('SELECT id, role FROM users WHERE email')) return { rows: [] };
      if (sql.includes("role LIKE '%agent%'")) return { rows: [] };
      if (sql.includes('INSERT INTO users')) return { rows: [{ id: 'u1', nom: 'Jean', email: 'jean@test.local', telephone: '+22900000000', role: 'proprietaire', ville: null, agent_id: null, created_at: '2026-08-07' }] };
      return { rows: [] };
    });
    const req = { body: { nom: 'Jean', email: 'jean@test.local', telephone: '+22900000000', mot_de_passe: 'abcdefgh', role: 'super_admin', cgu_acceptees: true } };
    const res = fauxRes();
    await inscrire(req, res);
    assert.equal(res.corps.utilisateur.role, 'proprietaire');
  });

  test('renvoie 409 si le compte existe déjà avec ce rôle', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('SELECT id, role FROM users WHERE email')) return { rows: [{ id: 'u1', role: 'proprietaire' }] };
      return { rows: [] };
    });
    const req = { body: { nom: 'Jean', email: 'jean@test.local', telephone: '+22900000000', mot_de_passe: 'abcdefgh', role: 'proprietaire', cgu_acceptees: true } };
    const res = fauxRes();
    await inscrire(req, res);
    assert.equal(res.statutCode, 409);
  });

  test('un compte existant sans le rôle demandé se voit ajouter ce rôle (200, cookie, pas de token en corps)', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('SELECT id, role FROM users WHERE email')) return { rows: [{ id: 'u1', role: 'locataire' }] };
      if (sql.includes('UPDATE users SET role')) return { rows: [{ id: 'u1', nom: 'Jean', email: 'jean@test.local', telephone: '+22900000000', role: 'locataire,proprietaire', ville: null }] };
      return { rows: [] };
    });
    const req = { body: { nom: 'Jean', email: 'jean@test.local', telephone: '+22900000000', mot_de_passe: 'abcdefgh', role: 'proprietaire', cgu_acceptees: true } };
    const res = fauxRes();
    await inscrire(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(res.corps.token, undefined);
    assert.equal(res.cookiesDefinis.length, 1);
    assert.equal(res.cookiesDefinis[0].nom, 'renteasy_token');
    assert.equal(res.cookiesDefinis[0].options.httpOnly, true);
  });

  test('création d\'un nouveau compte propriétaire : mot de passe haché, agent assigné, pas de token/hash dans la réponse', async () => {
    mock.method(pool, 'query', async (sql, params) => {
      if (sql.includes('SELECT id, role FROM users WHERE email')) return { rows: [] };
      if (sql.includes("role LIKE '%agent%'")) return { rows: [{ id: 'agent-1' }] };
      if (sql.includes('INSERT INTO users')) {
        assert.notEqual(params[3], 'abcdefgh'); // le mot de passe en clair ne doit jamais partir tel quel
        assert.equal(params[6], 'agent-1'); // agent_id bien transmis à l'INSERT
        return { rows: [{ id: 'u1', nom: 'Jean', email: 'jean@test.local', telephone: '+22900000000', role: 'proprietaire', ville: null, agent_id: 'agent-1', created_at: '2026-08-07' }] };
      }
      return { rows: [] };
    });
    const req = { body: { nom: 'Jean', email: 'jean@test.local', telephone: '+22900000000', mot_de_passe: 'abcdefgh', role: 'proprietaire', cgu_acceptees: true } };
    const res = fauxRes();
    await inscrire(req, res);
    assert.equal(res.statutCode, 201);
    assert.equal(res.corps.token, undefined);
    assert.equal(res.corps.utilisateur.mot_de_passe_hash, undefined);
    assert.equal(res.cookiesDefinis.length, 1);
  });

  test('renvoie 500 si la base échoue', async () => {
    mock.method(pool, 'query', async () => { throw new Error('DB down'); });
    const req = { body: { nom: 'Jean', email: 'jean@test.local', telephone: '+22900000000', mot_de_passe: 'abcdefgh', cgu_acceptees: true } };
    const res = fauxRes();
    await inscrire(req, res);
    assert.equal(res.statutCode, 500);
  });
});

describe('connecter', () => {
  test('renvoie 400 si email ou mot de passe manque', async () => {
    const res = fauxRes();
    await connecter({ body: { email: 'jean@test.local' } }, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 401 si aucun compte actif ne correspond', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const res = fauxRes();
    await connecter({ body: { email: 'jean@test.local', mot_de_passe: 'abcdefgh' } }, res);
    assert.equal(res.statutCode, 401);
  });

  test('renvoie 401 si le compte n\'est pas activé', async () => {
    mock.method(pool, 'query', async () => ({ rows: [{ id: 'u1', compte_active: false, mot_de_passe_hash: 'x' }] }));
    const res = fauxRes();
    await connecter({ body: { email: 'jean@test.local', mot_de_passe: 'abcdefgh' } }, res);
    assert.equal(res.statutCode, 401);
    assert.match(res.corps.message, /pas encore activé/);
  });

  test('renvoie 401 si le mot de passe ne correspond pas', async () => {
    const hash = await bcrypt.hash('bonmotdepasse', 10);
    mock.method(pool, 'query', async () => ({ rows: [{ id: 'u1', compte_active: true, mot_de_passe_hash: hash }] }));
    const res = fauxRes();
    await connecter({ body: { email: 'jean@test.local', mot_de_passe: 'mauvaismotdepasse' } }, res);
    assert.equal(res.statutCode, 401);
  });

  test('connexion réussie : cookie httpOnly posé, pas de token ni de hash dans le corps', async () => {
    const hash = await bcrypt.hash('bonmotdepasse', 10);
    mock.method(pool, 'query', async () => ({
      rows: [{ id: 'u1', nom: 'Jean', email: 'jean@test.local', role: 'proprietaire', compte_active: true, mot_de_passe_hash: hash }],
    }));
    const res = fauxRes();
    await connecter({ body: { email: '  jean@test.local  ', mot_de_passe: 'bonmotdepasse' } }, res);
    assert.equal(res.statutCode, 200);
    assert.equal(res.corps.token, undefined);
    assert.equal(res.corps.utilisateur.mot_de_passe_hash, undefined);
    assert.equal(res.cookiesDefinis.length, 1);
    assert.equal(res.cookiesDefinis[0].options.httpOnly, true);
  });
});

describe('activerCompte', () => {
  test('renvoie 400 si token ou mot de passe manque', async () => {
    const res = fauxRes();
    await activerCompte({ body: { token: 'abc' } }, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 404 si le token est invalide ou le compte déjà actif', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const res = fauxRes();
    await activerCompte({ body: { token: 'abc', mot_de_passe: 'abcdefgh', cgu_acceptees: true } }, res);
    assert.equal(res.statutCode, 404);
  });

  test('renvoie 410 si le lien d\'activation est expiré', async () => {
    mock.method(pool, 'query', async () => ({
      rows: [{ token_expiration: new Date(Date.now() - 1000).toISOString() }],
    }));
    const res = fauxRes();
    await activerCompte({ body: { token: 'abc', mot_de_passe: 'abcdefgh', cgu_acceptees: true } }, res);
    assert.equal(res.statutCode, 410);
  });

  test('active le compte, pose le cookie, aucun token dans le corps', async () => {
    let appelUpdate = null;
    mock.method(pool, 'query', async (sql, params) => {
      if (sql.includes('SELECT * FROM users WHERE token_activation')) {
        return { rows: [{ token_expiration: null }] };
      }
      if (sql.includes('UPDATE users SET mot_de_passe_hash')) {
        appelUpdate = params;
        return { rows: [{ id: 'u1', nom: 'Marie', email: 'marie@test.local', telephone: '+22900000001', role: 'locataire' }] };
      }
      return { rows: [] };
    });
    const res = fauxRes();
    await activerCompte({ body: { token: 'abc', mot_de_passe: 'abcdefgh', cgu_acceptees: true } }, res);
    assert.equal(res.statutCode, 200);
    assert.equal(res.corps.token, undefined);
    assert.equal(res.cookiesDefinis.length, 1);
    assert.notEqual(appelUpdate[0], 'abcdefgh'); // le hash envoyé à l'UPDATE, pas le mot de passe en clair
  });
});

describe('demanderReinitialisationMotDePasse', () => {
  test('renvoie 400 si l\'email manque', async () => {
    const res = fauxRes();
    await demanderReinitialisationMotDePasse({ body: {} }, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie le même message générique, que le compte existe ou non (anti-énumération)', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const resInconnu = fauxRes();
    await demanderReinitialisationMotDePasse({ body: { email: 'inconnu@test.local' } }, resInconnu);

    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('SELECT id, nom, email, compte_active')) {
        return { rows: [{ id: 'u1', nom: 'Jean', email: 'jean@test.local', compte_active: true }] };
      }
      return { rows: [] };
    });
    const resConnu = fauxRes();
    await demanderReinitialisationMotDePasse({ body: { email: 'jean@test.local' } }, resConnu);

    assert.deepEqual(resInconnu.corps, resConnu.corps);
    assert.equal(resInconnu.statutCode, resConnu.statutCode);
  });

  test('un compte inactif ne déclenche pas de mise à jour du token de réinitialisation', async () => {
    let updateAppele = false;
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('SELECT id, nom, email, compte_active')) {
        return { rows: [{ id: 'u1', nom: 'Jean', email: 'jean@test.local', compte_active: false }] };
      }
      if (sql.includes('UPDATE users SET token_reinitialisation')) updateAppele = true;
      return { rows: [] };
    });
    const res = fauxRes();
    await demanderReinitialisationMotDePasse({ body: { email: 'jean@test.local' } }, res);
    assert.equal(updateAppele, false);
  });
});

describe('reinitialiserMotDePasse', () => {
  test('renvoie 400 si un champ manque', async () => {
    const res = fauxRes();
    await reinitialiserMotDePasse({ body: { token: 'abc' } }, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 400 si le nouveau mot de passe fait moins de 8 caractères', async () => {
    const res = fauxRes();
    await reinitialiserMotDePasse({ body: { token: 'abc', nouveau_mot_de_passe: 'court' } }, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 404 si le token est invalide', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const res = fauxRes();
    await reinitialiserMotDePasse({ body: { token: 'abc', nouveau_mot_de_passe: 'abcdefgh' } }, res);
    assert.equal(res.statutCode, 404);
  });

  test('renvoie 410 si le token a expiré', async () => {
    mock.method(pool, 'query', async () => ({
      rows: [{ id: 'u1', token_reinitialisation_expiration: new Date(Date.now() - 1000).toISOString() }],
    }));
    const res = fauxRes();
    await reinitialiserMotDePasse({ body: { token: 'abc', nouveau_mot_de_passe: 'abcdefgh' } }, res);
    assert.equal(res.statutCode, 410);
  });

  test('réinitialise le mot de passe avec un hash, jamais le mot de passe en clair', async () => {
    let paramsUpdate = null;
    mock.method(pool, 'query', async (sql, params) => {
      if (sql.includes('SELECT id, token_reinitialisation_expiration')) {
        return { rows: [{ id: 'u1', token_reinitialisation_expiration: new Date(Date.now() + 60_000).toISOString() }] };
      }
      if (sql.includes('UPDATE users SET mot_de_passe_hash')) {
        paramsUpdate = params;
        return { rows: [] };
      }
      return { rows: [] };
    });
    const res = fauxRes();
    await reinitialiserMotDePasse({ body: { token: 'abc', nouveau_mot_de_passe: 'nouveaumdp' } }, res);
    assert.equal(res.statutCode, 200);
    assert.notEqual(paramsUpdate[0], 'nouveaumdp');
  });
});

describe('ajouterRole', () => {
  test('renvoie 400 si le rôle demandé n\'est pas autorisé', async () => {
    const res = fauxRes();
    await ajouterRole({ body: { role: 'super_admin' }, user: { id: 'u1' } }, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 404 si l\'utilisateur n\'existe plus', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const res = fauxRes();
    await ajouterRole({ body: { role: 'proprietaire' }, user: { id: 'u1' } }, res);
    assert.equal(res.statutCode, 404);
  });

  test('renvoie 409 si l\'utilisateur a déjà ce rôle', async () => {
    mock.method(pool, 'query', async () => ({ rows: [{ id: 'u1', role: 'proprietaire,locataire' }] }));
    const res = fauxRes();
    await ajouterRole({ body: { role: 'proprietaire' }, user: { id: 'u1' } }, res);
    assert.equal(res.statutCode, 409);
  });

  test('ajoute le rôle, assigne un agent disponible, pose le cookie', async () => {
    let paramsUpdate = null;
    mock.method(pool, 'query', async (sql, params) => {
      if (sql.includes('SELECT id, role FROM users WHERE id')) return { rows: [{ id: 'u1', role: 'locataire' }] };
      if (sql.includes("role LIKE '%agent%'")) return { rows: [{ id: 'agent-1' }] };
      if (sql.includes('UPDATE users SET role = $1, agent_id')) { paramsUpdate = params; return { rows: [] }; }
      if (sql.includes('SELECT id, nom, email, telephone, role, ville FROM users WHERE id')) {
        return { rows: [{ id: 'u1', nom: 'Jean', email: 'jean@test.local', telephone: '+22900000000', role: 'locataire,proprietaire', ville: null }] };
      }
      return { rows: [] };
    });
    const res = fauxRes();
    await ajouterRole({ body: { role: 'proprietaire' }, user: { id: 'u1' } }, res);
    assert.equal(res.statutCode, 200);
    assert.equal(paramsUpdate[1], 'agent-1');
    assert.equal(res.cookiesDefinis.length, 1);
  });
});
