const pool = require('../config/database');

// Enregistrer une intervention de recouvrement
async function creerRecouvrement(req, res) {
  const agent_id = req.user.id;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const { echeance_id, type_action, resultat, notes } = req.body;

  if (!echeance_id || !type_action || !resultat) {
    return res.status(400).json({ message: 'echeance_id, type_action et resultat sont obligatoires' });
  }

  try {
    // Un agent ne doit avoir accès qu'aux échéances des propriétaires qui lui sont assignés
    // (même logique que payerEcheanceSolde) — un admin a un accès de supervision inconditionnel.
    if (!estAdmin) {
      const verif = await pool.query(
        `SELECT pr.agent_id
         FROM echeances e
         JOIN contrats c ON c.id = e.contrat_id
         JOIN biens b ON b.id = c.bien_id
         JOIN users pr ON pr.id = b.proprietaire_id
         WHERE e.id = $1`,
        [echeance_id]
      );
      if (verif.rows.length === 0) {
        return res.status(404).json({ message: 'Échéance non trouvée' });
      }
      if (verif.rows[0].agent_id !== agent_id) {
        return res.status(403).json({ message: "Cette échéance n'appartient pas à un propriétaire qui vous est assigné" });
      }
    }

    const resultatDB = await pool.query(
      `INSERT INTO recouvrements (echeance_id, agent_id, type_action, resultat, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [echeance_id, agent_id, type_action, resultat, notes || null]
    );

    // "en_recouvrement" est un statut de PRISE EN CHARGE (l'agent a constaté un paiement complet
    // ou partiel sur le terrain), pas un statut de paiement confirmé — aucun argent ne bouge ici,
    // contrairement à payerEcheanceSolde/creerPaiement/mobile money. Il reste donc traité comme
    // "impayé/à surveiller" dans tous les tableaux de bord (cf. les filtres à travers le code),
    // jusqu'à ce qu'un vrai paiement soit enregistré via l'un de ces canaux, qui recalculera et
    // écrasera ce statut à partir des paiements réels (voir paiementController).
    if (resultat === 'paiement_complet' || resultat === 'paiement_partiel') {
      await pool.query(
        "UPDATE echeances SET statut = 'en_recouvrement' WHERE id = $1",
        [echeance_id]
      );
    }

    return res.status(201).json(resultatDB.rows[0]);
  } catch (err) {
    console.error('Erreur création recouvrement :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Lister les interventions de l'agent connecté (ou, pour un admin, toutes les interventions
// tous agents confondus — un admin n'est l'auteur d'aucune intervention lui-même)
async function listerRecouvrements(req, res) {
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const agent_id = req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT r.*, e.mois_concerne, e.montant_du,
              b.adresse, b.ville,
              l.nom AS locataire_nom, l.telephone AS locataire_telephone,
              ag.nom AS agent_nom
       FROM recouvrements r
       JOIN echeances e ON e.id = r.echeance_id
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       JOIN users ag ON ag.id = r.agent_id
       ${estAdmin ? '' : 'WHERE r.agent_id = $1'}
       ORDER BY r.created_at DESC
       LIMIT 50`,
      estAdmin ? [] : [agent_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste recouvrements :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = { creerRecouvrement, listerRecouvrements };
