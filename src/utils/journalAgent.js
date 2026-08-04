const pool = require('../config/database');

// Enregistre une action effectuée par un agent au nom d'un propriétaire (délégation), pour
// que le propriétaire puisse consulter un historique complet et horodaté de ce que son agent
// a fait sur son compte. N'échoue jamais bruyamment : un problème de journalisation ne doit
// jamais empêcher l'action métier elle-même de réussir.
async function enregistrerActionAgent({ agent_id, proprietaire_id, type_action, description, reference_type, reference_id }) {
  if (!agent_id) return; // Pas une action de délégation, rien à journaliser
  try {
    await pool.query(
      `INSERT INTO journal_activite_agent (agent_id, proprietaire_id, type_action, description, reference_type, reference_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [agent_id, proprietaire_id, type_action, description, reference_type || null, reference_id || null]
    );
  } catch (err) {
    console.error('Erreur journalisation action agent :', err);
  }
}

// Historique des actions de l'agent pour UN propriétaire donné (vue du propriétaire, ou de
// l'agent filtrée sur ce propriétaire précis)
async function listerJournalProprietaire(proprietaireId) {
  const resultat = await pool.query(
    `SELECT j.*, u.nom AS agent_nom
     FROM journal_activite_agent j
     JOIN users u ON u.id = j.agent_id
     WHERE j.proprietaire_id = $1
     ORDER BY j.created_at DESC
     LIMIT 200`,
    [proprietaireId]
  );
  return resultat.rows;
}

// Historique complet des actions d'UN agent, tous propriétaires confondus (vue de l'agent
// sur sa propre activité)
async function listerJournalAgent(agentId) {
  const resultat = await pool.query(
    `SELECT j.*, u.nom AS proprietaire_nom
     FROM journal_activite_agent j
     JOIN users u ON u.id = j.proprietaire_id
     WHERE j.agent_id = $1
     ORDER BY j.created_at DESC
     LIMIT 200`,
    [agentId]
  );
  return resultat.rows;
}

// Historique global, tous acteurs confondus (agents en délégation ET actions admin/super_admin),
// pour la vue d'audit du super admin — utile pour la confiance et la détection d'abus.
// Filtrable par acteur (agent_id) et/ou type d'action.
async function listerJournalGlobal({ acteur_id, type_action, limite = 300 } = {}) {
  let query = `
    SELECT j.*, u.nom AS acteur_nom, u.role AS acteur_role,
           c.nom AS cible_nom, c.role AS cible_role
    FROM journal_activite_agent j
    JOIN users u ON u.id = j.agent_id
    LEFT JOIN users c ON c.id = j.proprietaire_id
    WHERE 1=1
  `;
  const params = [];

  if (acteur_id) {
    params.push(acteur_id);
    query += ` AND j.agent_id = $${params.length}`;
  }
  if (type_action) {
    params.push(type_action);
    query += ` AND j.type_action = $${params.length}`;
  }

  params.push(limite);
  query += ` ORDER BY j.created_at DESC LIMIT $${params.length}`;

  const resultat = await pool.query(query, params);
  return resultat.rows;
}

module.exports = { enregistrerActionAgent, listerJournalProprietaire, listerJournalAgent, listerJournalGlobal };
