// Tests fonctionnels de src/controllers/agentController.js — la vérification d'accès
// (verifierAccesProprietaire) est le verrou central de tout ce fichier : un agent ne peut
// consulter QUE les propriétaires qui lui sont assignés (agent_id = son propre id), jamais un
// autre. Elle n'est pas exportée directement, donc testée ici indirectement via les fonctions
// exportées qui l'appellent en premier (dashboardProprietaireAgent, biensProprietaireAgent,
// bienProprietaireAgent). Même technique de mock que test/biens.test.js.
const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/database');
const {
  dashboardProprietaireAgent, biensProprietaireAgent, bienProprietaireAgent, calculerPerformanceAgent,
} = require('../src/controllers/agentController');

function fauxRes() {
  return {
    statutCode: 200,
    corps: null,
    status(code) { this.statutCode = code; return this; },
    json(payload) { this.corps = payload; return this; },
  };
}

const PROPRIETAIRE_ASSIGNE = { id: 'prop-1', nom: 'Jean', email: 'jean@test.local', telephone: '+229', ville: 'Cotonou', agent_id: 'agent-1', autorise_agent_gestion: true };

describe('dashboardProprietaireAgent (verifierAccesProprietaire)', () => {
  test('renvoie 403 si le propriétaire consulté n\'existe pas', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = { params: { proprietaireId: 'prop-inconnu' }, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await dashboardProprietaireAgent(req, res);
    assert.equal(res.statutCode, 403);
  });

  test('renvoie 403 si le propriétaire n\'est PAS assigné à cet agent', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes("role LIKE '%proprietaire%'")) {
        return { rows: [{ ...PROPRIETAIRE_ASSIGNE, agent_id: 'un-autre-agent' }] };
      }
      return { rows: [] };
    });
    const req = { params: { proprietaireId: 'prop-1' }, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await dashboardProprietaireAgent(req, res);
    assert.equal(res.statutCode, 403);
  });

  test('un agent accède au tableau de bord d\'un propriétaire qui LUI est assigné', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes("role LIKE '%proprietaire%'")) return { rows: [PROPRIETAIRE_ASSIGNE] };
      if (sql.includes('FROM biens WHERE proprietaire_id')) return { rows: [{ total_biens: 3, biens_occupes: 2, biens_libres: 1 }] };
      if (sql.includes('FROM echeances e') && sql.includes('mois_concerne')) {
        return { rows: [{ total_echeances: 10, echeances_payees: 8, echeances_impayees: 2, montant_total_du: 500000, montant_total_collecte: 400000 }] };
      }
      return { rows: [] };
    });
    const req = { params: { proprietaireId: 'prop-1' }, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await dashboardProprietaireAgent(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(res.corps.mois_en_cours.taux_recouvrement, 80);
  });

  test('un admin accède à n\'importe quel propriétaire, même non assigné à lui', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes("role LIKE '%proprietaire%'")) return { rows: [{ ...PROPRIETAIRE_ASSIGNE, agent_id: 'un-autre-agent-quelconque' }] };
      if (sql.includes('FROM biens WHERE proprietaire_id')) return { rows: [{ total_biens: 0, biens_occupes: 0, biens_libres: 0 }] };
      if (sql.includes('FROM echeances e') && sql.includes('mois_concerne')) {
        return { rows: [{ total_echeances: 0, echeances_payees: 0, echeances_impayees: 0, montant_total_du: 0, montant_total_collecte: 0 }] };
      }
      return { rows: [] };
    });
    const req = { params: { proprietaireId: 'prop-1' }, user: { id: 'admin-1', role: 'admin' } };
    const res = fauxRes();
    await dashboardProprietaireAgent(req, res);
    assert.equal(res.statutCode, 200);
  });
});

describe('biensProprietaireAgent', () => {
  test('renvoie 403 pour un propriétaire non assigné', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = { params: { proprietaireId: 'prop-1' }, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await biensProprietaireAgent(req, res);
    assert.equal(res.statutCode, 403);
  });

  test('liste les biens du propriétaire assigné', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes("role LIKE '%proprietaire%'")) return { rows: [PROPRIETAIRE_ASSIGNE] };
      if (sql.includes('FROM biens b')) return { rows: [{ id: 'b1' }, { id: 'b2' }] };
      return { rows: [] };
    });
    const req = { params: { proprietaireId: 'prop-1' }, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await biensProprietaireAgent(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(res.corps.length, 2);
  });
});

describe('bienProprietaireAgent', () => {
  test('renvoie 404 si le bien n\'appartient pas au propriétaire consulté (même si l\'agent y a accès)', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes("role LIKE '%proprietaire%'")) return { rows: [PROPRIETAIRE_ASSIGNE] };
      if (sql.includes('FROM biens WHERE id')) return { rows: [] }; // bien d'un autre propriétaire
      return { rows: [] };
    });
    const req = { params: { proprietaireId: 'prop-1', bienId: 'bien-dun-autre' }, user: { id: 'agent-1', role: 'agent' } };
    const res = fauxRes();
    await bienProprietaireAgent(req, res);
    assert.equal(res.statutCode, 404);
  });
});

describe('calculerPerformanceAgent', () => {
  test('calcule le taux de recouvrement et cumule demandes de modification + demandes marché', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('nb_proprietaires')) return { rows: [{ nb_proprietaires: 5, nb_proprietaires_delegation: 2, nb_biens: 12, nb_contrats_actifs: 9 }] };
      if (sql.includes('echeances_payees') && sql.includes('total_echeances')) return { rows: [{ total_echeances: 20, echeances_payees: 15 }] };
      if (sql.includes('revenus_collectes')) return { rows: [{ revenus_collectes: 750000, commissions_generees: 37500 }] };
      if (sql.includes("statut = 'en_attente'")) return { rows: [{ n: 3 }] };
      if (sql.includes("statut = 'demande_locataire'")) return { rows: [{ n: 2 }] };
      return { rows: [] };
    });
    const resultat = await calculerPerformanceAgent('agent-1');
    assert.equal(resultat.taux_recouvrement, 75);
    assert.equal(resultat.demandes_en_attente, 5);
    assert.equal(resultat.demandes_modification_en_attente, 3);
    assert.equal(resultat.demandes_marche_en_attente, 2);
  });

  test('un agent sans aucune échéance ce mois-ci a un taux de recouvrement à 0 (pas une division par zéro)', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('nb_proprietaires')) return { rows: [{ nb_proprietaires: 0, nb_proprietaires_delegation: 0, nb_biens: 0, nb_contrats_actifs: 0 }] };
      if (sql.includes('echeances_payees') && sql.includes('total_echeances')) return { rows: [{ total_echeances: 0, echeances_payees: 0 }] };
      if (sql.includes('revenus_collectes')) return { rows: [{ revenus_collectes: 0, commissions_generees: 0 }] };
      return { rows: [{ n: 0 }] };
    });
    const resultat = await calculerPerformanceAgent('agent-nouveau');
    assert.equal(resultat.taux_recouvrement, 0);
  });
});
