// Tests fonctionnels de src/utils/erreurs.js. Même technique que test/rappelsEcheances.test.js :
// pool.query est mocké directement sur l'instance partagée (mock.method), pas de vraie base.
//
// Le point le plus important à couvrir ici n'est pas "l'erreur est enregistrée" (trivial) mais
// l'anti-spam : une même erreur ne doit JAMAIS redéclencher une alerte email avant 30 minutes,
// sous peine d'inonder le super admin de centaines d'emails pendant une vraie panne.
const { test, describe, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/database');
const { enregistrerErreur } = require('../src/utils/erreurs');

describe('enregistrerErreur', () => {
  let appelsQuery;

  beforeEach(() => {
    appelsQuery = [];
    mock.method(pool, 'query', async (sql, params = []) => {
      appelsQuery.push({ sql, params });

      if (sql.includes('INSERT INTO erreurs_serveur')) {
        return { rows: [] };
      }
      if (sql.includes("FROM users WHERE role LIKE '%super_admin%'")) {
        return { rows: [{ id: 'super-admin-1', nom: 'Admin Test', email: 'admin@example.com' }] };
      }
      // Tout le reste (notifications in-app, paramètres SMS...) : réponse vide neutre.
      return { rows: [] };
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  function compterAlertes() {
    return appelsQuery.filter(a => a.sql.includes("FROM users WHERE role LIKE '%super_admin%'")).length;
  }
  function compterInserts() {
    return appelsQuery.filter(a => a.sql.includes('INSERT INTO erreurs_serveur')).length;
  }

  test('enregistre l\'erreur en base avec message, stack et contexte de requête', async () => {
    const erreur = new Error('Test erreur unique 1');
    const req = { method: 'POST', originalUrl: '/api/paiements', user: { id: 'user-1' } };

    await enregistrerErreur({ erreur, req, statutHttp: 500 });

    const insert = appelsQuery.find(a => a.sql.includes('INSERT INTO erreurs_serveur'));
    assert.ok(insert, 'un INSERT doit avoir eu lieu');
    assert.equal(insert.params[0], 'Test erreur unique 1');
    assert.ok(insert.params[1].includes('Test erreur unique 1')); // stack contient le message
    assert.equal(insert.params[2], 'POST');
    assert.equal(insert.params[3], 'POST /api/paiements');
    assert.equal(insert.params[4], 500);
    assert.equal(insert.params[5], 'user-1');
  });

  test('fonctionne sans req ni statutHttp (cas d\'une exception hors requête HTTP, ex: un cron)', async () => {
    await assert.doesNotReject(() => enregistrerErreur({ erreur: new Error('Erreur unique 2 (cron)') }));
    const insert = appelsQuery.find(a => a.sql.includes('INSERT INTO erreurs_serveur'));
    assert.equal(insert.params[2], null); // pas de méthode HTTP
    assert.equal(insert.params[3], null); // pas de route
  });

  test('accepte une valeur qui n\'est pas une vraie Error (ex: rejet avec une string)', async () => {
    await assert.doesNotReject(() => enregistrerErreur({ erreur: 'juste une string, erreur unique 3' }));
    const insert = appelsQuery.find(a => a.sql.includes('INSERT INTO erreurs_serveur'));
    assert.equal(insert.params[0], 'juste une string, erreur unique 3');
  });

  test('la première occurrence d\'une erreur déclenche une alerte au super admin', async () => {
    await enregistrerErreur({ erreur: new Error('Erreur unique 4'), req: { method: 'GET', originalUrl: '/api/route-4' } });
    assert.equal(compterAlertes(), 1);
  });

  // Le test le plus important de ce fichier.
  test('la même erreur répétée immédiatement ne redéclenche PAS d\'alerte (anti-spam)', async () => {
    const req = { method: 'GET', originalUrl: '/api/route-5' };
    await enregistrerErreur({ erreur: new Error('Erreur unique 5'), req });
    await enregistrerErreur({ erreur: new Error('Erreur unique 5'), req });
    await enregistrerErreur({ erreur: new Error('Erreur unique 5'), req });

    assert.equal(compterAlertes(), 1, 'une seule alerte malgré 3 occurrences de la même erreur');
    assert.equal(compterInserts(), 3, 'chaque occurrence reste bien enregistrée en base, même sans alerte');
  });

  test('une erreur différente (route différente) déclenche bien sa propre alerte', async () => {
    await enregistrerErreur({ erreur: new Error('Erreur unique 6a'), req: { method: 'GET', originalUrl: '/api/route-6a' } });
    await enregistrerErreur({ erreur: new Error('Erreur unique 6b'), req: { method: 'GET', originalUrl: '/api/route-6b' } });

    assert.equal(compterAlertes(), 2);
  });

  test('un échec d\'écriture en base ne fait pas planter enregistrerErreur (résilience)', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('INSERT INTO erreurs_serveur')) {
        throw new Error('Base de données injoignable (simulation)');
      }
      return { rows: [] };
    });

    await assert.doesNotReject(() => enregistrerErreur({ erreur: new Error('Erreur unique 7') }));
  });
});
