// Tests fonctionnels de src/utils/rappelsEcheances.js — contrairement aux autres fichiers de
// test (fonctions pures), ce module ne fait quasiment que des appels pool.query. On mocke donc
// pool.query directement sur l'instance partagée (mock.method, stable depuis Node 18 — pas
// besoin du --experimental-test-module-mocks nécessaire pour mock.module) plutôt que de laisser
// ce module sans aucune couverture.
//
// Ce qui est vérifié ici est la partie qui a le plus de chances de casser silencieusement :
// le bon type de rappel se déclenche pour le bon décalage de jours, et surtout — le plus
// important — qu'un rappel déjà envoyé n'est JAMAIS renvoyé une deuxième fois.
const { test, describe, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/database');
const { envoyerRappelsEcheances } = require('../src/utils/rappelsEcheances');

const ECHEANCE_EXEMPLE = {
  id: 'echeance-test-1',
  mois_concerne: '2026-07-01',
  montant_du: 50000,
  date_limite: '2026-07-10',
  statut: 'en_attente',
  numero_bien: 'BJ-001',
  adresse: 'Rue 12',
  ville: 'Cotonou',
  proprietaire_id: 'proprio-1',
  locataire_user_id: null, // locataire sans compte activé — cas le plus fragile pour notifier()
  locataire_nom: 'Jean K.',
  locataire_email: 'jean@example.com',
  locataire_telephone: '+22997000000',
  proprietaire_nom: 'Marie D.',
  proprietaire_email: 'marie@example.com',
  proprietaire_telephone: '+22997000001',
};

describe('envoyerRappelsEcheances', () => {
  let appelsQuery;
  let echeancesParDecalage; // { [decalageJours]: [lignes] }
  let echeancesDejaEnvoyees; // Set de "echeanceId:typeRappel"

  beforeEach(() => {
    appelsQuery = [];
    echeancesParDecalage = {};
    echeancesDejaEnvoyees = new Set();

    mock.method(pool, 'query', async (sql, params = []) => {
      appelsQuery.push({ sql, params });

      // trouverEcheances : SELECT ... WHERE e.date_limite = (CURRENT_DATE + $1::int) ...
      if (sql.includes('FROM echeances e') && sql.includes('date_limite = (CURRENT_DATE')) {
        const decalage = params[0];
        return { rows: echeancesParDecalage[decalage] || [] };
      }

      // dejaEnvoye : SELECT 1 FROM rappels_echeances_envoyes WHERE echeance_id = $1 AND type_rappel = $2
      if (sql.includes('FROM rappels_echeances_envoyes') && sql.trim().startsWith('SELECT')) {
        const [echeanceId, typeRappel] = params;
        if (!echeanceId) throw new Error('id invalide (simulation d\'une erreur DB réelle)');
        const deja = echeancesDejaEnvoyees.has(`${echeanceId}:${typeRappel}`);
        return { rows: deja ? [{ x: 1 }] : [] };
      }

      // marquerEnvoye : INSERT INTO rappels_echeances_envoyes ...
      if (sql.includes('INSERT INTO rappels_echeances_envoyes')) {
        const [echeanceId, typeRappel] = params;
        echeancesDejaEnvoyees.add(`${echeanceId}:${typeRappel}`);
        return { rows: [] };
      }

      // Tout le reste (notifications in-app, paramètres SMS/opérateurs...) : réponse vide neutre,
      // notifier()/envoyerSMS() sont déjà conçus pour ne pas planter sur une base vide.
      return { rows: [] };
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  test('une échéance à J-3 déclenche le rappel "avant_3j" et le marque comme envoyé', async () => {
    echeancesParDecalage[3] = [ECHEANCE_EXEMPLE];

    await envoyerRappelsEcheances();

    const inserts = appelsQuery.filter(a => a.sql.includes('INSERT INTO rappels_echeances_envoyes'));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0].params, [ECHEANCE_EXEMPLE.id, 'avant_3j']);
  });

  test('une échéance au jour J déclenche le rappel "jour_j"', async () => {
    echeancesParDecalage[0] = [ECHEANCE_EXEMPLE];

    await envoyerRappelsEcheances();

    const inserts = appelsQuery.filter(a => a.sql.includes('INSERT INTO rappels_echeances_envoyes'));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0].params, [ECHEANCE_EXEMPLE.id, 'jour_j']);
  });

  test('une échéance en retard de 3 jours déclenche "retard_3j"', async () => {
    echeancesParDecalage[-3] = [{ ...ECHEANCE_EXEMPLE, statut: 'impayee' }];

    await envoyerRappelsEcheances();

    const inserts = appelsQuery.filter(a => a.sql.includes('INSERT INTO rappels_echeances_envoyes'));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0].params, [ECHEANCE_EXEMPLE.id, 'retard_3j']);
  });

  test('une échéance en retard de 7 jours déclenche "retard_7j"', async () => {
    echeancesParDecalage[-7] = [{ ...ECHEANCE_EXEMPLE, statut: 'impayee' }];

    await envoyerRappelsEcheances();

    const inserts = appelsQuery.filter(a => a.sql.includes('INSERT INTO rappels_echeances_envoyes'));
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0].params, [ECHEANCE_EXEMPLE.id, 'retard_7j']);
  });

  // Le test le plus important de ce fichier : un rappel déjà envoyé ne doit JAMAIS repartir,
  // même si l'échéance correspond toujours au bon décalage de jours (ce qui sera le cas tant
  // qu'elle reste "en_attente" le jour suivant si le cron tourne plus d'une fois).
  test('un rappel déjà envoyé n\'est jamais renvoyé', async () => {
    echeancesParDecalage[3] = [ECHEANCE_EXEMPLE];
    echeancesDejaEnvoyees.add(`${ECHEANCE_EXEMPLE.id}:avant_3j`);

    await envoyerRappelsEcheances();

    const inserts = appelsQuery.filter(a => a.sql.includes('INSERT INTO rappels_echeances_envoyes'));
    assert.equal(inserts.length, 0);
  });

  test('plusieurs échéances au même décalage sont toutes traitées', async () => {
    echeancesParDecalage[3] = [
      { ...ECHEANCE_EXEMPLE, id: 'echeance-a' },
      { ...ECHEANCE_EXEMPLE, id: 'echeance-b' },
    ];

    await envoyerRappelsEcheances();

    const inserts = appelsQuery.filter(a => a.sql.includes('INSERT INTO rappels_echeances_envoyes'));
    assert.equal(inserts.length, 2);
  });

  test('une erreur sur une échéance n\'empêche pas de traiter les autres', async () => {
    echeancesParDecalage[3] = [
      { ...ECHEANCE_EXEMPLE, id: 'echeance-ok-1' },
      { ...ECHEANCE_EXEMPLE, id: null }, // id manquant : provoquera une erreur dans dejaEnvoye()
      { ...ECHEANCE_EXEMPLE, id: 'echeance-ok-2' },
    ];

    // Ne doit pas lever — les erreurs par échéance sont capturées individuellement (traiterRappel)
    await assert.doesNotReject(() => envoyerRappelsEcheances());

    const inserts = appelsQuery.filter(a => a.sql.includes('INSERT INTO rappels_echeances_envoyes'));
    const idsTraites = inserts.map(i => i.params[0]);
    assert.ok(idsTraites.includes('echeance-ok-1'));
    assert.ok(idsTraites.includes('echeance-ok-2'));
  });

  test('aucune échéance à relancer : le job ne plante pas et ne fait aucun envoi', async () => {
    await assert.doesNotReject(() => envoyerRappelsEcheances());
    const inserts = appelsQuery.filter(a => a.sql.includes('INSERT INTO rappels_echeances_envoyes'));
    assert.equal(inserts.length, 0);
  });
});
