// Tests fonctionnels de src/controllers/locataireEspaceController.js — l'espace self-service du
// locataire (accepter/refuser une liaison propriétaire, signer/refuser un contrat). Le point le
// plus sensible : signerContrat, qui active le contrat ET génère les échéances via
// creerEcheancesPourContrat (utils/echeances.js, réelle, pas mockée — seul pool.query l'est,
// donc son comportement de calcul de dates est vérifié pour de vrai). BREVO_API_KEY est effacée
// (cf. test/auth.test.js) car ces flux notifient tous le propriétaire par email.
const { test, describe, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/database');
const {
  accepterLiaison, refuserLiaison, signerContrat, refuserContrat, obtenirContratLocataire,
} = require('../src/controllers/locataireEspaceController');

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

describe('accepterLiaison / refuserLiaison', () => {
  test('accepterLiaison renvoie 404 si la demande n\'appartient pas à ce locataire ou est déjà traitée', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = { params: { id: 'liaison-1' }, user: { id: 'user-loc-1', nom: 'Jean' } };
    const res = fauxRes();
    await accepterLiaison(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('accepterLiaison confirme la liaison et ne touche à rien d\'autre', async () => {
    let updateAppele = null;
    mock.method(pool, 'query', async (sql, params) => {
      if (sql.includes("FROM locataires l") && sql.includes("l.statut = 'en_attente'")) {
        return { rows: [{ id: 'liaison-1', proprietaire_id: 'prop-1', proprietaire_nom: 'Marie', proprietaire_email: 'marie@test.local' }] };
      }
      if (sql.includes("UPDATE locataires SET statut = 'confirme'")) { updateAppele = params; return { rows: [] }; }
      return { rows: [] };
    });
    const req = { params: { id: 'liaison-1' }, user: { id: 'user-loc-1', nom: 'Jean' } };
    const res = fauxRes();
    await accepterLiaison(req, res);
    assert.equal(res.statutCode, 200);
    assert.deepEqual(updateAppele, ['liaison-1']);
  });

  test('refuserLiaison renvoie 404 si la demande n\'existe pas pour ce locataire', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = { params: { id: 'liaison-1' }, user: { id: 'user-loc-1', nom: 'Jean' } };
    const res = fauxRes();
    await refuserLiaison(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('refuserLiaison marque la liaison "refuse"', async () => {
    let statutEnvoye = null;
    mock.method(pool, 'query', async (sql, params) => {
      if (sql.includes("FROM locataires l") && sql.includes("l.statut = 'en_attente'")) {
        return { rows: [{ id: 'liaison-1', proprietaire_id: 'prop-1', proprietaire_nom: 'Marie', proprietaire_email: 'marie@test.local' }] };
      }
      if (sql.includes('UPDATE locataires SET statut')) { statutEnvoye = params; return { rows: [] }; }
      return { rows: [] };
    });
    const req = { params: { id: 'liaison-1' }, user: { id: 'user-loc-1', nom: 'Jean' } };
    const res = fauxRes();
    await refuserLiaison(req, res);
    assert.equal(res.statutCode, 200);
    assert.deepEqual(statutEnvoye, ['liaison-1']);
  });
});

describe('signerContrat', () => {
  test('renvoie 400 si la signature électronique est vide', async () => {
    const req = { params: { id: 'c1' }, body: { signature_locataire: '   ' }, user: { id: 'user-loc-1', nom: 'Jean' } };
    const res = fauxRes();
    await signerContrat(req, res);
    assert.equal(res.statutCode, 400);
  });

  test('renvoie 404 si le contrat n\'est pas en attente de signature pour ce locataire', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = { params: { id: 'c1' }, body: { signature_locataire: 'Jean K.' }, user: { id: 'user-loc-1', nom: 'Jean' } };
    const res = fauxRes();
    await signerContrat(req, res);
    assert.equal(res.statutCode, 404);
  });

  // signerContrat ouvre désormais une transaction (la signature vaut finalisation : paiement de
  // la caution dans le même geste), donc pool.connect doit aussi être mocké — cf.
  // test/paiements.test.js pour le modèle. Toutes les écritures passent par client.query.

  test('active le contrat, génère les échéances, et occupe le bien si la période a déjà commencé', async () => {
    const hier = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let bienOccupe = false;
    let echeancesInserees = 0;
    let soldeDebite = null;
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes("c.statut = 'en_attente_signature'")) {
        return { rows: [{ id: 'c1', bien_id: 'bien-1', numero_bien: 'BJ-001', proprietaire_id: 'prop-1', proprietaire_nom: 'Marie', proprietaire_email: 'marie@test.local', date_debut: hier, type_loyer: 'mensuel', loyer_mensuel: 50000, caution: 150000, jour_echeance: 5, duree_valeur: null, duree_unite: null, date_fin: null }] };
      }
      return { rows: [] };
    });
    mock.method(pool, 'connect', async () => ({
      async query(sql, params) {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FOR UPDATE')) return { rows: [{ solde: 500000 }] };
        if (sql.includes('UPDATE users SET solde = solde -')) { soldeDebite = params; return { rows: [] }; }
        if (sql.includes("SET statut = 'actif'")) {
          return { rows: [{ id: 'c1', bien_id: 'bien-1', date_debut: hier, type_loyer: 'mensuel', loyer_mensuel: 50000, caution: 150000, caution_solde: 150000, statut_caution: 'payee', jour_echeance: 5, duree_valeur: null, duree_unite: null, date_fin: null }] };
        }
        if (sql.includes('INSERT INTO echeances')) { echeancesInserees += 1; return { rows: [] }; }
        if (sql.includes("UPDATE biens SET statut = 'occupe'")) { bienOccupe = true; return { rows: [] }; }
        return { rows: [] };
      },
      release() {},
    }));
    const req = { params: { id: 'c1' }, body: { signature_locataire: 'Jean K.' }, user: { id: 'user-loc-1', nom: 'Jean' } };
    const res = fauxRes();
    await signerContrat(req, res);
    assert.equal(res.statutCode, 200);
    assert.ok(echeancesInserees > 0, 'au moins une échéance doit être générée');
    assert.equal(bienOccupe, true);
    assert.deepEqual(soldeDebite, [150000, 'user-loc-1']);
  });

  test('une réservation future (date de début pas encore arrivée) ne rend pas le bien occupé tout de suite', async () => {
    const demain = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let bienOccupe = false;
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes("c.statut = 'en_attente_signature'")) {
        return { rows: [{ id: 'c1', bien_id: 'bien-1', numero_bien: 'BJ-001', proprietaire_id: 'prop-1', proprietaire_nom: 'Marie', proprietaire_email: 'marie@test.local', date_debut: demain, type_loyer: 'mensuel', loyer_mensuel: 50000, caution: 0, jour_echeance: 5, duree_valeur: null, duree_unite: null, date_fin: null }] };
      }
      return { rows: [] };
    });
    mock.method(pool, 'connect', async () => ({
      async query(sql) {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes("SET statut = 'actif'")) {
          return { rows: [{ id: 'c1', bien_id: 'bien-1', date_debut: demain, type_loyer: 'mensuel', loyer_mensuel: 50000, caution: 0, jour_echeance: 5, duree_valeur: null, duree_unite: null, date_fin: null }] };
        }
        if (sql.includes("UPDATE biens SET statut = 'occupe'")) { bienOccupe = true; return { rows: [] }; }
        return { rows: [] };
      },
      release() {},
    }));
    const req = { params: { id: 'c1' }, body: { signature_locataire: 'Jean K.' }, user: { id: 'user-loc-1', nom: 'Jean' } };
    const res = fauxRes();
    await signerContrat(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(bienOccupe, false);
  });

  test('renvoie 400 et n\'active pas le contrat si le solde ne couvre pas la caution', async () => {
    const hier = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let contratActive = false;
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes("c.statut = 'en_attente_signature'")) {
        return { rows: [{ id: 'c1', bien_id: 'bien-1', numero_bien: 'BJ-001', proprietaire_id: 'prop-1', proprietaire_nom: 'Marie', proprietaire_email: 'marie@test.local', date_debut: hier, type_loyer: 'mensuel', loyer_mensuel: 50000, caution: 150000, jour_echeance: 5, duree_valeur: null, duree_unite: null, date_fin: null }] };
      }
      return { rows: [] };
    });
    mock.method(pool, 'connect', async () => ({
      async query(sql) {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FOR UPDATE')) return { rows: [{ solde: 1000 }] }; // très insuffisant pour 150000
        if (sql.includes("SET statut = 'actif'")) { contratActive = true; return { rows: [] }; }
        return { rows: [] };
      },
      release() {},
    }));
    const req = { params: { id: 'c1' }, body: { signature_locataire: 'Jean K.' }, user: { id: 'user-loc-1', nom: 'Jean' } };
    const res = fauxRes();
    await signerContrat(req, res);
    assert.equal(res.statutCode, 400);
    assert.match(res.corps.message, /Solde insuffisant/);
    assert.equal(contratActive, false, 'le contrat ne doit pas être activé si la caution ne peut pas être payée');
  });
});

describe('refuserContrat', () => {
  test('renvoie 404 si le contrat n\'est pas en attente de signature pour ce locataire', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = { params: { id: 'c1' }, user: { id: 'user-loc-1', nom: 'Jean' } };
    const res = fauxRes();
    await refuserContrat(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('marque le contrat "refuse"', async () => {
    let paramsUpdate = null;
    mock.method(pool, 'query', async (sql, params) => {
      if (sql.includes("c.statut = 'en_attente_signature'")) {
        return { rows: [{ id: 'c1', numero_bien: 'BJ-001', proprietaire_id: 'prop-1', proprietaire_nom: 'Marie', proprietaire_email: 'marie@test.local' }] };
      }
      if (sql.includes("UPDATE contrats SET statut = 'refuse'")) { paramsUpdate = params; return { rows: [] }; }
      return { rows: [] };
    });
    const req = { params: { id: 'c1' }, user: { id: 'user-loc-1', nom: 'Jean' } };
    const res = fauxRes();
    await refuserContrat(req, res);
    assert.equal(res.statutCode, 200);
    assert.deepEqual(paramsUpdate, ['c1']);
  });
});

describe('obtenirContratLocataire', () => {
  test('renvoie 404 si le contrat n\'appartient pas à ce locataire', async () => {
    mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = { params: { id: 'c1' }, user: { id: 'user-loc-1' } };
    const res = fauxRes();
    await obtenirContratLocataire(req, res);
    assert.equal(res.statutCode, 404);
  });

  test('renvoie le contrat avec ses échéances (montant_restant calculé) pour son propriétaire légitime', async () => {
    mock.method(pool, 'query', async (sql) => {
      if (sql.includes('FROM contrats c') && sql.includes('JOIN locataires l')) {
        return { rows: [{ id: 'c1', numero_bien: 'BJ-001' }] };
      }
      if (sql.includes('FROM echeances e WHERE e.contrat_id')) {
        return { rows: [{ id: 'e1', montant_du: 50000, montant_paye: 20000, montant_restant: 30000 }] };
      }
      return { rows: [] };
    });
    const req = { params: { id: 'c1' }, user: { id: 'user-loc-1' } };
    const res = fauxRes();
    await obtenirContratLocataire(req, res);
    assert.equal(res.statutCode, 200);
    assert.equal(res.corps.echeances[0].montant_restant, 30000);
  });
});
