const pool = require('../config/database');
const { listerJournalAgent, listerJournalProprietaire } = require('../utils/journalAgent');

// Vérifie que le propriétaire consulté est bien assigné à l'agent connecté (ou que l'utilisateur
// est admin/super_admin, qui peut tout consulter). Retourne le propriétaire si l'accès est autorisé,
// ou null sinon. Centralise ce contrôle pour toutes les routes de lecture seule ci-dessous.
async function verifierAccesProprietaire(req) {
  const { proprietaireId } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');

  const resultat = await pool.query(
    `SELECT id, nom, email, telephone, ville, agent_id, autorise_agent_gestion FROM users WHERE id = $1 AND role LIKE '%proprietaire%'`,
    [proprietaireId]
  );
  if (resultat.rows.length === 0) return null;
  const proprietaire = resultat.rows[0];

  if (!estAdmin && proprietaire.agent_id !== req.user.id) return null;

  return proprietaire;
}

// Tableau de bord en lecture seule du propriétaire consulté (mêmes chiffres que sur son propre compte)
async function dashboardProprietaireAgent(req, res) {
  try {
    const proprietaire = await verifierAccesProprietaire(req);
    if (!proprietaire) return res.status(403).json({ message: "Ce propriétaire ne vous est pas assigné" });

    const proprietaire_id = proprietaire.id;

    const biens = await pool.query(
      `SELECT
        COUNT(*) AS total_biens,
        COUNT(*) FILTER (WHERE statut = 'occupe') AS biens_occupes,
        COUNT(*) FILTER (WHERE statut = 'libre') AS biens_libres
       FROM biens WHERE proprietaire_id = $1`,
      [proprietaire_id]
    );

    const maintenant = new Date();
    const debutMois = new Date(maintenant.getFullYear(), maintenant.getMonth(), 1);
    const finMois = new Date(maintenant.getFullYear(), maintenant.getMonth() + 1, 0);

    const echeancesMois = await pool.query(
      `SELECT
        COUNT(*) AS total_echeances,
        COUNT(*) FILTER (WHERE e.statut = 'payee') AS echeances_payees,
        COUNT(*) FILTER (WHERE e.statut IN ('en_attente', 'impayee', 'partielle', 'en_recouvrement')) AS echeances_impayees,
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

    const impayes = await pool.query(
      `SELECT e.id, e.mois_concerne, e.montant_du, e.date_limite, e.statut,
              b.adresse, b.ville, l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM echeances e
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE b.proprietaire_id = $1
         AND e.statut IN ('en_attente', 'impayee', 'partielle', 'en_recouvrement')
         AND e.date_limite < CURRENT_DATE
       ORDER BY e.date_limite ASC
       LIMIT 5`,
      [proprietaire_id]
    );

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

    const stats = echeancesMois.rows[0];
    const tauxRecouvrement = stats.total_echeances > 0
      ? Math.round((stats.echeances_payees / stats.total_echeances) * 100)
      : 0;

    return res.json({
      proprietaire,
      biens: biens.rows[0],
      mois_en_cours: {
        ...stats,
        taux_recouvrement: tauxRecouvrement,
        mois: maintenant.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
      },
      impayes: impayes.rows,
      derniers_paiements: derniersPaiements.rows,
    });
  } catch (err) {
    console.error('Erreur dashboard propriétaire (agent) :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Liste des biens du propriétaire consulté
async function biensProprietaireAgent(req, res) {
  try {
    const proprietaire = await verifierAccesProprietaire(req);
    if (!proprietaire) return res.status(403).json({ message: "Ce propriétaire ne vous est pas assigné" });

    const resultat = await pool.query(
      `SELECT b.*,
        (SELECT COUNT(*) FROM contrats c WHERE c.bien_id = b.id AND c.statut = 'actif') AS contrat_actif
       FROM biens b
       WHERE b.proprietaire_id = $1
       ORDER BY b.created_at DESC`,
      [proprietaire.id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste biens (agent) :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Détail d'un bien précis du propriétaire consulté
async function bienProprietaireAgent(req, res) {
  try {
    const proprietaire = await verifierAccesProprietaire(req);
    if (!proprietaire) return res.status(403).json({ message: "Ce propriétaire ne vous est pas assigné" });

    const { bienId } = req.params;
    const resultat = await pool.query(
      'SELECT * FROM biens WHERE id = $1 AND proprietaire_id = $2',
      [bienId, proprietaire.id]
    );
    if (resultat.rows.length === 0) return res.status(404).json({ message: 'Bien non trouvé' });

    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur détail bien (agent) :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Liste des locataires du propriétaire consulté
async function locatairesProprietaireAgent(req, res) {
  try {
    const proprietaire = await verifierAccesProprietaire(req);
    if (!proprietaire) return res.status(403).json({ message: "Ce propriétaire ne vous est pas assigné" });

    const resultat = await pool.query(
      `SELECT * FROM locataires WHERE proprietaire_id = $1 AND statut = 'confirme' ORDER BY created_at DESC`,
      [proprietaire.id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste locataires (agent) :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Liste des contrats du propriétaire consulté (tous statuts, comme sur son propre compte)
async function contratsProprietaireAgent(req, res) {
  try {
    const proprietaire = await verifierAccesProprietaire(req);
    if (!proprietaire) return res.status(403).json({ message: "Ce propriétaire ne vous est pas assigné" });

    const resultat = await pool.query(
      `SELECT c.*, b.numero_bien, b.adresse, b.ville, l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE b.proprietaire_id = $1
       ORDER BY c.created_at DESC`,
      [proprietaire.id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste contrats (agent) :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Détail d'un contrat précis (avec ses échéances) du propriétaire consulté
async function contratProprietaireAgent(req, res) {
  try {
    const proprietaire = await verifierAccesProprietaire(req);
    if (!proprietaire) return res.status(403).json({ message: "Ce propriétaire ne vous est pas assigné" });

    const { contratId } = req.params;
    const contrat = await pool.query(
      `SELECT c.*, b.numero_bien, b.adresse, b.ville, b.photos, b.proprietaire_id, l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE c.id = $1`,
      [contratId]
    );

    if (contrat.rows.length === 0 || contrat.rows[0].proprietaire_id !== proprietaire.id) {
      return res.status(404).json({ message: 'Contrat non trouvé' });
    }

    const echeances = await pool.query(
      'SELECT * FROM echeances WHERE contrat_id = $1 ORDER BY mois_concerne ASC',
      [contratId]
    );

    return res.json({ ...contrat.rows[0], echeances: echeances.rows });
  } catch (err) {
    console.error('Erreur détail contrat (agent) :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Échéances en retard du propriétaire consulté
async function impayesProprietaireAgent(req, res) {
  try {
    const proprietaire = await verifierAccesProprietaire(req);
    if (!proprietaire) return res.status(403).json({ message: "Ce propriétaire ne vous est pas assigné" });

    const resultat = await pool.query(
      `SELECT e.*, b.adresse, b.ville, l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM echeances e
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE b.proprietaire_id = $1
         AND e.statut IN ('impayee', 'en_attente', 'partielle', 'en_recouvrement')
         AND e.date_limite < CURRENT_DATE
       ORDER BY e.date_limite ASC`,
      [proprietaire.id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste impayés (agent) :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Historique complet des paiements du propriétaire consulté
async function paiementsProprietaireAgent(req, res) {
  try {
    const proprietaire = await verifierAccesProprietaire(req);
    if (!proprietaire) return res.status(403).json({ message: "Ce propriétaire ne vous est pas assigné" });

    const resultat = await pool.query(
      `SELECT p.*, e.mois_concerne, b.adresse, l.nom AS locataire_nom
       FROM paiements p
       JOIN echeances e ON e.id = p.echeance_id
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE b.proprietaire_id = $1
       ORDER BY p.date_paiement DESC`,
      [proprietaire.id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste paiements (agent) :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Tableau de bord de performance de l'agent connecté : portefeuille, recouvrement, demandes
// en attente, revenus collectés ce mois. Utilisé aussi bien par l'agent lui-même que par le
// super admin pour évaluer un agent en particulier.
async function calculerPerformanceAgent(agentId) {
  const maintenant = new Date();
  const debutMois = new Date(maintenant.getFullYear(), maintenant.getMonth(), 1);
  const finMois = new Date(maintenant.getFullYear(), maintenant.getMonth() + 1, 0);

  const portefeuille = await pool.query(
    `SELECT
       COUNT(DISTINCT u.id) AS nb_proprietaires,
       COUNT(DISTINCT u.id) FILTER (WHERE u.autorise_agent_gestion) AS nb_proprietaires_delegation,
       COUNT(DISTINCT b.id) AS nb_biens,
       COUNT(DISTINCT c.id) FILTER (WHERE c.statut = 'actif') AS nb_contrats_actifs
     FROM users u
     LEFT JOIN biens b ON b.proprietaire_id = u.id
     LEFT JOIN contrats c ON c.bien_id = b.id
     WHERE u.agent_id = $1 AND u.role LIKE '%proprietaire%'`,
    [agentId]
  );

  const recouvrement = await pool.query(
    `SELECT
       COUNT(*) AS total_echeances,
       COUNT(*) FILTER (WHERE e.statut = 'payee') AS echeances_payees
     FROM echeances e
     JOIN contrats c ON c.id = e.contrat_id
     JOIN biens b ON b.id = c.bien_id
     JOIN users pr ON pr.id = b.proprietaire_id
     WHERE pr.agent_id = $1 AND e.mois_concerne >= $2 AND e.mois_concerne <= $3`,
    [agentId, debutMois, finMois]
  );

  const revenus = await pool.query(
    `SELECT COALESCE(SUM(p.montant), 0) AS revenus_collectes,
            COALESCE(SUM(p.commission_renteasy), 0) AS commissions_generees
     FROM paiements p
     JOIN echeances e ON e.id = p.echeance_id
     JOIN contrats c ON c.id = e.contrat_id
     JOIN biens b ON b.id = c.bien_id
     JOIN users pr ON pr.id = b.proprietaire_id
     WHERE pr.agent_id = $1 AND p.statut = 'reussi' AND p.date_paiement >= $2 AND p.date_paiement <= $3`,
    [agentId, debutMois, finMois]
  );

  const demandesModification = await pool.query(
    `SELECT COUNT(*) AS n FROM demandes_contrat WHERE agent_id = $1 AND statut = 'en_attente'`,
    [agentId]
  );

  const demandesMarche = await pool.query(
    `SELECT COUNT(*) AS n
     FROM contrats c
     JOIN biens b ON b.id = c.bien_id
     JOIN users pr ON pr.id = b.proprietaire_id
     WHERE pr.agent_id = $1 AND c.statut = 'demande_locataire'`,
    [agentId]
  );

  const p = portefeuille.rows[0];
  const rec = recouvrement.rows[0];
  const tauxRecouvrement = rec.total_echeances > 0 ? Math.round((rec.echeances_payees / rec.total_echeances) * 100) : 0;

  return {
    nb_proprietaires: parseInt(p.nb_proprietaires),
    nb_proprietaires_delegation: parseInt(p.nb_proprietaires_delegation),
    nb_biens: parseInt(p.nb_biens),
    nb_contrats_actifs: parseInt(p.nb_contrats_actifs),
    taux_recouvrement: tauxRecouvrement,
    echeances_payees: parseInt(rec.echeances_payees),
    total_echeances: parseInt(rec.total_echeances),
    revenus_collectes: parseInt(revenus.rows[0].revenus_collectes),
    commissions_generees: parseInt(revenus.rows[0].commissions_generees),
    demandes_en_attente: parseInt(demandesModification.rows[0].n) + parseInt(demandesMarche.rows[0].n),
    demandes_modification_en_attente: parseInt(demandesModification.rows[0].n),
    demandes_marche_en_attente: parseInt(demandesMarche.rows[0].n),
    mois: maintenant.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
  };
}

async function performanceAgent(req, res) {
  try {
    const performance = await calculerPerformanceAgent(req.user.id);
    return res.json(performance);
  } catch (err) {
    console.error('Erreur performance agent :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Journal complet de l'agent connecté (toutes ses actions, tous propriétaires confondus)
async function monJournalAgent(req, res) {
  try {
    const journal = await listerJournalAgent(req.user.id);
    return res.json(journal);
  } catch (err) {
    console.error('Erreur journal agent :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Demandes de location/réservation via le marché (statut 'demande_locataire'), tous
// propriétaires assignés confondus — c'est ce chiffre qui alimente demandes_marche_en_attente
// sur le tableau de bord (calculerPerformanceAgent), donc la page Demandes doit lister les mêmes
// éléments pour que le compteur et la page restent cohérents. Lecture seule : approuver/refuser
// passe par les routes existantes /contrats/:id/approuver et /refuser-demande (déjà ouvertes à
// 'agent' mais soumises à la délégation du propriétaire concerné via estAutoriseSurProprietaire).
async function demandesMarcheAgent(req, res) {
  try {
    const resultat = await pool.query(
      `SELECT c.*, b.numero_bien, b.adresse, b.ville, b.type_bien,
              l.nom AS locataire_nom, l.telephone AS locataire_telephone,
              pr.id AS proprietaire_id, pr.nom AS proprietaire_nom, pr.autorise_agent_gestion
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       JOIN users pr ON pr.id = b.proprietaire_id
       WHERE pr.agent_id = $1 AND c.statut = 'demande_locataire'
       ORDER BY c.created_at DESC`,
      [req.user.id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur demandes marché agent :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Journal des actions de l'agent pour UN propriétaire précis (vue depuis sa fiche)
async function journalProprietaireAgent(req, res) {
  try {
    const proprietaire = await verifierAccesProprietaire(req);
    if (!proprietaire) return res.status(403).json({ message: "Ce propriétaire ne vous est pas assigné" });

    const journal = await listerJournalProprietaire(proprietaire.id);
    return res.json(journal);
  } catch (err) {
    console.error('Erreur journal propriétaire (agent) :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = {
  dashboardProprietaireAgent,
  biensProprietaireAgent,
  bienProprietaireAgent,
  locatairesProprietaireAgent,
  contratsProprietaireAgent,
  contratProprietaireAgent,
  impayesProprietaireAgent,
  paiementsProprietaireAgent,
  performanceAgent,
  calculerPerformanceAgent,
  monJournalAgent,
  journalProprietaireAgent,
  demandesMarcheAgent,
};
