// Tests fonctionnels de src/controllers/demandeController.js — le circuit propriétaire → agent
// pour les demandes de modification/résiliation de contrat. Accent sur les effets de bord d'une
// approbation, qui diffèrent selon le type : une résiliation libère le bien et supprime les
// échéances futures (jamais les passées, même impayées) ; une modification ne change le loyer
// QUE sur les échéances 'en_attente' (jamais payées/partielles/impayées/en recouvrement). Même
// technique de mock que test/contrats.test.js ; BREVO_API_KEY effacée (ces flux notifient par
// email à chaque étape).
const { test, describe, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/database');
const { soumettreDemandeContrat, approuverDemande, annulerDemande } = require('../src/controllers/demandeController');

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

const CONTRAT_BASE = { id: 'c1', proprietaire_id: 'prop-1', adresse: 'Rue 1', ville: 'Cotonou', locataire_nom: 'Jean', locataire_email: 'jean@test.local', locataire_telephone: '+229' };

describe('soumettreDemandeContrat', () => {
  test('renvoie 400 si type_demande n\'est ni modification ni resiliation', async () => {
    const req = { params: { id: 'c1' }, body: { type_demande: 'autre_chose' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await soumettreDemandeContrat(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 404 si le contrat n\'appartient pas à ce propriétaire', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM contrats c') && sql.includes('JOIN biens')) return { rows: [{ ...CONTRAT_BASE, proprietaire_id: 'un-autre' }] };
      return { rows: [] };
    });
    const req = { params: { id: 'c1' }, body: { type_demande: 'resiliation' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await soumettreDemandeContrat(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('renvoie 409 si une demande est déjà en attente sur ce contrat', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM contrats c') && sql.includes('JOIN biens')) return { rows: [CONTRAT_BASE] };
      if (sql.includes("demandes_contrat WHERE contrat_id")) return { rows: [{ id: 'demande-existante' }] };
      return { rows: [] };
    });
    const req = { params: { id: 'c1' }, body: { type_demande: 'resiliation' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await soumettreDemandeContrat(req, res);
    assert.equal(res.statutCode, 409);
  });

  test('renvoie 500 si le propriétaire n\'a aucun agent assigné', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM contrats c') && sql.includes('JOIN biens')) return { rows: [CONTRAT_BASE] };
      if (sql.includes("demandes_contrat WHERE contrat_id")) return { rows: [] };
      if (sql.includes('SELECT nom, email, agent_id FROM users')) return { rows: [{ nom: 'Jean Prop', email: 'p@test.local', agent_id: null }] };
      return { rows: [] };
    });
    const req = { params: { id: 'c1' }, body: { type_demande: 'resiliation' }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await soumettreDemandeContrat(req, res);
    assert.equal(res.statutCode, 500);
  });

  test('soumet la demande et notifie l\'agent assigné', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM contrats c') && sql.includes('JOIN biens')) return { rows: [CONTRAT_BASE] };
      if (sql.includes("demandes_contrat WHERE contrat_id")) return { rows: [] };
      if (sql.includes('SELECT nom, email, agent_id FROM users')) return { rows: [{ nom: 'Jean Prop', email: 'p@test.local', agent_id: 'agent-1' }] };
      if (sql.includes('INSERT INTO demandes_contrat')) return { rows: [{ id: 'demande-1' }] };
      if (sql.includes('SELECT id, nom, email FROM users')) return { rows: [{ id: 'agent-1', nom: 'Agent A', email: 'agent@test.local' }] };
      return { rows: [] };
    });
    const req = { params: { id: 'c1' }, body: { type_demande: 'modification', conditions_demandees: { loyer_mensuel: 60000 } }, user: { id: 'prop-1', role: 'proprietaire' } };
    const res = fauxRes();
    await soumettreDemandeContrat(req, res);
    assert.equal(res.statutCode, 201);
  });
});

describe('approuverDemande', () => {
  test('renvoie 409 si la demande a déjà été traitée', async () => {
    mock.method(pool, 'query', async () => ({ rows: [{ id: 'd1', statut: 'approuvee', type_demande: 'resiliation' }] }));
    const req = { params: { id: 'd1' }, body: {}, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await approuverDemande(req, res);
    assert.equal(res.statutCode, 409);
  });

  test('une résiliation approuvée libère le bien et supprime seulement les échéances futures en attente', async () => {
    const appelsQuery = [];
    mock.method(pool, 'query', async (sql, params) => {
      appelsQuery.push({ sql, params });
      if (sql.includes('FROM demandes_contrat d') && sql.includes('JOIN contrats')) {
        return { rows: [{ id: 'd1', statut: 'en_attente', type_demande: 'resiliation', contrat_id: 'c1', bien_id: 'bien-1', adresse: 'Rue 1', ville: 'Cotonou', proprietaire_id: 'prop-1', proprietaire_nom: 'P', proprietaire_email: 'p@test.local', locataire_email: null }] };
      }
      return { rows: [] };
    });
    // approuverDemande (branche résiliation) ouvre désormais une transaction (le transfert de
    // caution modifie un solde) : pool.connect doit aussi être mocké, cf. test/paiements.test.js.
    // caution_solde à 0 fait ressortir transfererCautionFinContrat immédiatement.
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
    const req = { params: { id: 'd1' }, body: {}, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await approuverDemande(req, res);
    assert.equal(res.statutCode, 200);

    assert.ok(appelsQuery.some(a => a.sql.includes("UPDATE contrats SET statut = 'resilie'")));
    assert.ok(appelsQuery.some(a => a.sql.includes("UPDATE biens SET statut = 'libre'")));
    const suppression = appelsQuery.find(a => a.sql.includes('DELETE FROM echeances'));
    assert.match(suppression.sql, /statut = 'en_attente' AND date_limite > CURRENT_DATE/);
  });

  test('une modification de loyer ne s\'applique qu\'aux échéances "en_attente", jamais aux autres statuts', async () => {
    const appelsQuery = [];
    mock.method(pool, 'query', async (sql, params) => {
      appelsQuery.push({ sql, params });
      if (sql.includes('FROM demandes_contrat d') && sql.includes('JOIN contrats')) {
        return {
          rows: [{
            id: 'd1', statut: 'en_attente', type_demande: 'modification', contrat_id: 'c1',
            conditions_demandees: { loyer_mensuel: 65000 },
            adresse: 'Rue 1', ville: 'Cotonou', proprietaire_id: 'prop-1', proprietaire_nom: 'P', proprietaire_email: 'p@test.local', locataire_email: null,
          }],
        };
      }
      return { rows: [] };
    });
    const req = { params: { id: 'd1' }, body: {}, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await approuverDemande(req, res);
    assert.equal(res.statutCode, 200);

    const majEcheances = appelsQuery.find(a => a.sql.includes('UPDATE echeances SET montant_du'));
    assert.match(majEcheances.sql, /statut = 'en_attente'/);
    assert.deepEqual(majEcheances.params, [65000, 'c1']);
    // Ne doit pas non plus toucher au statut des échéances passées/payées/impayées
    assert.ok(!appelsQuery.some(a => a.sql.includes("statut IN ('impayee'")));
  });

  test('une modification sans nouveau loyer ne touche à aucune échéance', async () => {
    const appelsQuery = [];
    mock.method(pool, 'query', async (sql, params) => {
      appelsQuery.push({ sql, params });
      if (sql.includes('FROM demandes_contrat d') && sql.includes('JOIN contrats')) {
        return {
          rows: [{
            id: 'd1', statut: 'en_attente', type_demande: 'modification', contrat_id: 'c1',
            conditions_demandees: {},
            adresse: 'Rue 1', ville: 'Cotonou', proprietaire_id: 'prop-1', proprietaire_nom: 'P', proprietaire_email: 'p@test.local', locataire_email: null,
          }],
        };
      }
      return { rows: [] };
    });
    const req = { params: { id: 'd1' }, body: {}, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await approuverDemande(req, res);
    assert.equal(res.statutCode, 200);
    assert.ok(!appelsQuery.some(a => a.sql.includes('UPDATE echeances SET montant_du')));
  });
});

describe('annulerDemande', () => {
  test('renvoie 404 si la demande n\'existe pas ou est déjà traitée', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = { params: { id: 'd1' }, body: {}, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await annulerDemande(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('un agent ne peut pas annuler la demande d\'un autre agent', async () => {
    // La requête filtre déjà par agent_id = req.user.id côté SQL ; on simule le résultat vide
    // qu'une vraie base renverrait pour un agent différent de celui assigné à la demande.
    let paramsUtilises = null;
    mock.method(pool, 'query', async (sql, params) => { paramsUtilises = params; return { rows: [] }; });
    const req = { params: { id: 'd1' }, body: {}, user: { id: 'agent-2', role: 'agent' } };
    const res = fauxRes();
    await annulerDemande(req, res);
    assert.equal(res.statutCode, 404);
    assert.deepEqual(paramsUtilises, ['d1', 'agent-2']);
  });

  test('annule la demande', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM demandes_contrat d')) {
        return { rows: [{ id: 'd1', type_demande: 'resiliation', adresse: 'Rue 1', ville: 'Cotonou', proprietaire_id: 'prop-1', proprietaire_nom: 'P', proprietaire_email: 'p@test.local' }] };
      }
      return { rows: [] };
    });
    const req = { params: { id: 'd1' }, body: {}, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await annulerDemande(req, res);
    assert.equal(res.statutCode, 200);
  });
});
