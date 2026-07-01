const pool = require('../config/database');

async function obtenirDashboard(req, res) {
  const proprietaire_id = req.user.id;

  try {
    // 1. Statistiques des biens
    const biens = await pool.query(
      `SELECT
        COUNT(*) AS total_biens,
        COUNT(*) FILTER (WHERE statut = 'occupe') AS biens_occupes,
        COUNT(*) FILTER (WHERE statut = 'libre') AS biens_libres
       FROM biens WHERE proprietaire_id = $1`,
      [proprietaire_id]
    );

    // 2. Statistiques du mois en cours
    const maintenant = new Date();
    const debutMois = new Date(maintenant.getFullYear(), maintenant.getMonth(), 1);
    const finMois = new Date(maintenant.getFullYear(), maintenant.getMonth() + 1, 0);

    const echeancesMois = await pool.query(
      `SELECT
        COUNT(*) AS total_echeances,
        COUNT(*) FILTER (WHERE e.statut = 'payee') AS echeances_payees,
        COUNT(*) FILTER (WHERE e.statut IN ('en_attente', 'impayee', 'partielle')) AS echeances_impayees,
        COALESCE(SUM(e.montant_du), 0) AS montant_total_du,
        COALESCE(SUM(CASE WHEN e.statut = 'payee' THEN e.montant_du ELSE 0 END), 0) AS montant_total_collecte
       FROM echeances e
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       WHERE b.proprietaire_id = $1
         AND e.mois_concerne >= $2
         AND e.mois_concerne <= $3`,
      [proprietaire_id, debutMois, finMois]
    );

    // 3. Commission RentEasy du mois
    const commissions = await pool.query(
      `SELECT COALESCE(SUM(p.commission_renteasy), 0) AS total_commissions
       FROM paiements p
       JOIN echeances e ON e.id = p.echeance_id
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       WHERE b.proprietaire_id = $1
         AND p.statut = 'reussi'
         AND p.date_paiement >= $2`,
      [proprietaire_id, debutMois]
    );

    // 4. Échéances en retard (date dépassée, non payées)
    const impayes = await pool.query(
      `SELECT e.id, e.mois_concerne, e.montant_du, e.date_limite, e.statut,
              b.adresse, b.ville, l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM echeances e
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE b.proprietaire_id = $1
         AND e.statut IN ('en_attente', 'impayee', 'partielle')
         AND e.date_limite < NOW()
       ORDER BY e.date_limite ASC
       LIMIT 5`,
      [proprietaire_id]
    );

    // 5. Derniers paiements reçus
    const derniersPaiements = await pool.query(
      `SELECT p.id, p.montant, p.methode, p.date_paiement, p.commission_renteasy,
              e.mois_concerne, b.adresse, l.nom AS locataire_nom
       FROM paiements p
       JOIN echeances e ON e.id = p.echeance_id
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE b.proprietaire_id = $1 AND p.statut = 'reussi'
       ORDER BY p.date_paiement DESC
       LIMIT 5`,
      [proprietaire_id]
    );

    // 6. Taux de recouvrement
    const stats = echeancesMois.rows[0];
    const tauxRecouvrement = stats.total_echeances > 0
      ? Math.round((stats.echeances_payees / stats.total_echeances) * 100)
      : 0;

    return res.json({
      biens: biens.rows[0],
      mois_en_cours: {
        ...stats,
        taux_recouvrement: tauxRecouvrement,
        mois: maintenant.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
      },
      commissions: commissions.rows[0],
      impayes: impayes.rows,
      derniers_paiements: derniersPaiements.rows,
    });
  } catch (err) {
    console.error('Erreur dashboard :', err);
    return res.status(500).json({ message: 'Erreur serveur lors du chargement du tableau de bord' });
  }
}

module.exports = { obtenirDashboard };
