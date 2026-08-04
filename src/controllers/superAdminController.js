const pool = require('../config/database');
const { calculerPerformanceAgent } = require('./agentController');
const { notifier, echapperHtml } = require('../utils/notifications');
const { enregistrerActionAgent, listerJournalGlobal } = require('../utils/journalAgent');
const { listerParametresPlateforme, definirParametrePlateforme, listerOperateurs, definirOperateur } = require('../utils/parametres');
const { genererRapportCSV, genererRapportPDF } = require('../utils/rapportFinancier');
// Clés API considérées sensibles : masquées dans la réponse GET (ex : "••••••1234"), jamais
// renvoyées en clair une fois enregistrées. Les autres champs (base_url, api_user, target_env)
// sont des identifiants de configuration, pas des secrets, donc affichés tels quels.
const CLES_SECRETES = ['subscription_key', 'api_key', 'disbursement_subscription_key', 'disbursement_api_key'];

function masquerValeur(valeur) {
  if (!valeur) return '';
  const visible = valeur.length > 4 ? valeur.slice(-4) : valeur;
  return '•'.repeat(Math.max(valeur.length - visible.length, 4)) + (valeur.length > 4 ? visible : '');
}

// Stats globales de la plateforme
async function obtenirStats(req, res) {
  try {
    const [users, biens, contrats, paiements, demandes] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE role LIKE '%proprietaire%') AS total_proprietaires,
          COUNT(*) FILTER (WHERE role LIKE '%locataire%') AS total_locataires,
          COUNT(*) FILTER (WHERE role LIKE '%agent%') AS total_agents,
          COUNT(*) FILTER (WHERE role LIKE '%admin%' AND role NOT LIKE '%super%') AS total_admins,
          COUNT(*) FILTER (WHERE actif = false) AS comptes_inactifs
        FROM users
      `),
      pool.query(`
        SELECT
          COUNT(*) AS total_biens,
          COUNT(*) FILTER (WHERE statut = 'occupe') AS biens_occupes,
          COUNT(*) FILTER (WHERE statut = 'libre') AS biens_libres
        FROM biens
      `),
      pool.query(`
        SELECT
          COUNT(*) AS total_contrats,
          COUNT(*) FILTER (WHERE statut = 'actif') AS contrats_actifs,
          COUNT(*) FILTER (WHERE statut = 'resilie') AS contrats_resilies
        FROM contrats
      `),
      pool.query(`
        SELECT
          COUNT(*) AS total_paiements,
          COALESCE(SUM(montant), 0) AS volume_total,
          COALESCE(SUM(commission_renteasy), 0) AS commissions_totales
        FROM paiements WHERE statut = 'reussi'
      `),
      pool.query(`
        SELECT
          COUNT(*) AS total_demandes,
          COUNT(*) FILTER (WHERE statut = 'en_attente') AS demandes_en_attente
        FROM demandes_contrat
      `),
    ]);

    return res.json({
      users: users.rows[0],
      biens: biens.rows[0],
      contrats: contrats.rows[0],
      paiements: paiements.rows[0],
      demandes: demandes.rows[0],
    });
  } catch (err) {
    console.error('Erreur stats super admin :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Lister tous les utilisateurs
async function listerUtilisateurs(req, res) {
  const { role, actif } = req.query;

  try {
    let query = `
      SELECT u.id, u.nom, u.email, u.telephone, u.role, u.ville,
             u.actif, u.compte_active, u.created_at,
             a.nom AS agent_nom
      FROM users u
      LEFT JOIN users a ON a.id = u.agent_id
      WHERE 1=1
    `;
    const params = [];

    if (role) {
      params.push(`%${role}%`);
      query += ` AND u.role LIKE $${params.length}`;
    }
    if (actif !== undefined) {
      params.push(actif === 'true');
      query += ` AND u.actif = $${params.length}`;
    }

    query += ' ORDER BY u.created_at DESC';

    const resultat = await pool.query(query, params);
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste utilisateurs :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Réassigne en bloc tous les agents gérés par un admin vers un autre admin — utilisé à la fois
// par la désactivation d'un admin (toggleActiverCompte) et sa rétrogradation (retrograderAdmin).
// Ne fait rien (renvoie 0) si l'admin ne gérait aucun agent.
async function reassignerAgentsDAdmin(ancienAdminId, nouvelAdminId, userId) {
  const agentsAReassigner = await pool.query('SELECT id, nom FROM users WHERE gere_par_admin_id = $1', [ancienAdminId]);
  if (agentsAReassigner.rows.length === 0) return 0;

  await pool.query('UPDATE users SET gere_par_admin_id = $1 WHERE gere_par_admin_id = $2', [nouvelAdminId, ancienAdminId]);

  const nouvelAdmin = await pool.query('SELECT nom FROM users WHERE id = $1', [nouvelAdminId]);

  await enregistrerActionAgent({
    agent_id: userId,
    proprietaire_id: nouvelAdminId,
    type_action: 'reassignation_agents_admin',
    description: `A réassigné ${agentsAReassigner.rows.length} agent(s) (${agentsAReassigner.rows.map(a => a.nom).join(', ')}) à ${nouvelAdmin.rows[0]?.nom || nouvelAdminId}.`,
  });

  return agentsAReassigner.rows.length;
}

// Désactiver / réactiver un compte
async function toggleActiverCompte(req, res) {
  const { id } = req.params;
  const { nouvel_admin_id } = req.body;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estSuperAdmin = roles.includes('super_admin');

  try {
    const user = await pool.query('SELECT id, actif, role FROM users WHERE id = $1', [id]);
    if (user.rows.length === 0) return res.status(404).json({ message: 'Utilisateur non trouvé' });

    // Empêcher de désactiver un super_admin
    if (user.rows[0].role.includes('super_admin')) {
      return res.status(403).json({ message: 'Impossible de désactiver un super admin' });
    }
    // Un admin (non super_admin) ne peut pas désactiver un autre compte admin
    if (!estSuperAdmin && user.rows[0].role.includes('admin')) {
      return res.status(403).json({ message: 'Seul un super admin peut désactiver un compte admin' });
    }

    const nouvelEtat = !user.rows[0].actif;

    // On désactive un admin qui gère encore des agents : il faut d'abord dire à qui ces agents
    // reviennent, sinon ils se retrouvent orphelins (plus aucun admin ne les supervise).
    let nbAgentsReassignes = 0;
    if (!nouvelEtat && user.rows[0].role.includes('admin')) {
      const agentsGeres = await pool.query('SELECT COUNT(*) AS total FROM users WHERE gere_par_admin_id = $1', [id]);
      if (parseInt(agentsGeres.rows[0].total) > 0) {
        if (!nouvel_admin_id) {
          return res.status(400).json({
            message: `Cet admin gère encore ${agentsGeres.rows[0].total} agent(s). Précisez à quel admin les réassigner avant de désactiver ce compte.`,
            agents_geres: parseInt(agentsGeres.rows[0].total),
          });
        }
        nbAgentsReassignes = await reassignerAgentsDAdmin(id, nouvel_admin_id, req.user.id);
      }
    }

    await pool.query('UPDATE users SET actif = $1 WHERE id = $2', [nouvelEtat, id]);

    await enregistrerActionAgent({
      agent_id: req.user.id,
      proprietaire_id: id,
      type_action: nouvelEtat ? 'compte_active' : 'compte_desactive',
      description: `${nouvelEtat ? 'A activé' : 'A désactivé'} le compte ${user.rows[0].role}.`,
      reference_type: 'user',
      reference_id: id,
    });

    return res.json({
      message: `Compte ${nouvelEtat ? 'activé' : 'désactivé'} avec succès${nbAgentsReassignes > 0 ? ` (${nbAgentsReassignes} agent(s) réassigné(s))` : ''}`,
      actif: nouvelEtat,
    });
  } catch (err) {
    console.error('Erreur toggle compte :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Réassigner un propriétaire à un autre agent
async function reassignerAgent(req, res) {
  const { id } = req.params;
  const { agent_id } = req.body;

  if (!agent_id) return res.status(400).json({ message: 'agent_id requis' });

  try {
    const agent = await pool.query("SELECT id FROM users WHERE id = $1 AND role LIKE '%agent%'", [agent_id]);
    if (agent.rows.length === 0) return res.status(404).json({ message: 'Agent non trouvé' });

    const proprietaire = await pool.query('SELECT nom, email, agent_id FROM users WHERE id = $1', [id]);
    if (proprietaire.rows.length === 0) return res.status(404).json({ message: 'Propriétaire non trouvé' });

    const ancienAgentId = proprietaire.rows[0].agent_id;
    const changeReel = ancienAgentId !== agent_id;

    if (changeReel) {
      // L'autorisation de délégation avait été accordée à L'ANCIEN agent précisément, pas à
      // "l'agent assigné" en général — sans ce reset, le nouvel agent hériterait
      // silencieusement des pleins pouvoirs de gestion sur les biens/contrats/locataires que
      // le propriétaire n'a jamais accordés à cette personne.
      await pool.query(
        'UPDATE users SET agent_id = $1, autorise_agent_gestion = false WHERE id = $2',
        [agent_id, id]
      );

      await notifier({
        user_id: id,
        email: proprietaire.rows[0].email,
        nom: proprietaire.rows[0].nom,
        titre: 'Agent réassigné',
        message: "Votre agent référent a changé. Par sécurité, l'autorisation de gestion déléguée a été réinitialisée — vous devrez la réactiver si vous souhaitez que votre nouvel agent gère vos biens à votre place.",
        type: 'reassignation_agent',
        lien: '/profil',
        sujet_email: '[RentEasy] Votre agent référent a changé',
        contenu_email: `
          <h2>Agent réassigné</h2>
          <p>Bonjour ${echapperHtml(proprietaire.rows[0].nom)},</p>
          <p>Votre agent référent sur RentEasy a changé. Par sécurité, l'autorisation de gestion déléguée a été réinitialisée : votre nouvel agent ne peut pas encore gérer vos biens à votre place.</p>
          <p>Si vous le souhaitez, vous pouvez réactiver cette autorisation depuis votre profil.</p>
        `,
      });

      await enregistrerActionAgent({
        agent_id: req.user.id,
        proprietaire_id: id,
        type_action: 'reassignation_agent',
        description: `A réassigné le propriétaire ${proprietaire.rows[0].nom} à un nouvel agent.`,
        reference_type: 'user',
        reference_id: agent_id,
      });
    }

    return res.json({ message: 'Propriétaire réassigné avec succès' });
  } catch (err) {
    console.error('Erreur réassignation :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Lister tous les agents avec leurs stats
async function listerAgents(req, res) {
  try {
    const resultat = await pool.query(`
      SELECT u.id, u.nom, u.email, u.telephone, u.actif, u.created_at
      FROM users u
      WHERE u.role LIKE '%agent%'
      ORDER BY u.created_at DESC
    `);

    // Réutilise exactement le même calcul que le tableau de bord de l'agent lui-même,
    // pour que le super admin voie les mêmes chiffres que ceux affichés à l'agent.
    const agentsAvecPerformance = await Promise.all(
      resultat.rows.map(async agent => ({
        ...agent,
        ...(await calculerPerformanceAgent(agent.id)),
      }))
    );

    return res.json(agentsAvecPerformance);
  } catch (err) {
    console.error('Erreur liste agents :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Rapport financier régional — lecture seule, groupé par ville (région) des agents.
// Volontairement construit sur calculerPerformanceAgent (même fonction que listerAgents et
// le tableau de bord de l'agent lui-même) plutôt que sur des requêtes réécrites à part, pour
// que les chiffres restent cohérents partout dans l'app. Ne touche jamais au solde ni aux
// retraits (ça reste exclusivement super_admin, cf. routes/superAdmin.js et routes/solde.js) —
// uniquement des métriques de loyers/commissions/recouvrement, en lecture seule.
async function rapportFinancierRegional(req, res) {
  try {
    const agents = await pool.query(`
      SELECT u.id, u.nom, u.ville, u.actif
      FROM users u
      WHERE u.role LIKE '%agent%'
      ORDER BY u.ville ASC NULLS LAST, u.nom ASC
    `);

    const agentsAvecPerformance = await Promise.all(
      agents.rows.map(async (agent) => ({
        ...agent,
        ...(await calculerPerformanceAgent(agent.id)),
      }))
    );

    // Regroupe par région (ville de l'agent) ; "Région non renseignée" pour un agent sans ville
    const regions = {};
    for (const agent of agentsAvecPerformance) {
      const region = agent.ville || 'Région non renseignée';
      if (!regions[region]) {
        regions[region] = {
          region,
          agents: [],
          totaux: {
            nb_agents: 0,
            nb_proprietaires: 0,
            nb_biens: 0,
            nb_contrats_actifs: 0,
            revenus_collectes: 0,
            commissions_generees: 0,
            total_echeances: 0,
            echeances_payees: 0,
          },
        };
      }
      const r = regions[region];
      r.agents.push(agent);
      r.totaux.nb_agents += 1;
      r.totaux.nb_proprietaires += agent.nb_proprietaires;
      r.totaux.nb_biens += agent.nb_biens;
      r.totaux.nb_contrats_actifs += agent.nb_contrats_actifs;
      r.totaux.revenus_collectes += agent.revenus_collectes;
      r.totaux.commissions_generees += agent.commissions_generees;
      r.totaux.total_echeances += agent.total_echeances;
      r.totaux.echeances_payees += agent.echeances_payees;
    }

    const rapport = Object.values(regions).map((r) => ({
      ...r,
      totaux: {
        ...r.totaux,
        taux_recouvrement: r.totaux.total_echeances > 0
          ? Math.round((r.totaux.echeances_payees / r.totaux.total_echeances) * 100)
          : 0,
      },
    }));

    return res.json(rapport);
  } catch (err) {
    console.error('Erreur rapport financier régional :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Tous les contrats de la plateforme
async function tousLesContrats(req, res) {
  try {
    const resultat = await pool.query(`
      SELECT c.*, b.adresse, b.ville, b.type_bien,
             l.nom AS locataire_nom, l.telephone AS locataire_telephone,
             p.nom AS proprietaire_nom, p.email AS proprietaire_email
      FROM contrats c
      JOIN biens b ON b.id = c.bien_id
      JOIN locataires l ON l.id = c.locataire_id
      JOIN users p ON p.id = b.proprietaire_id
      ORDER BY c.created_at DESC
      LIMIT 100
    `);
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur contrats :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Tous les paiements de la plateforme
// Requête commune à tousLesPaiements (aperçu à l'écran) et exporterRapportFinancier (export
// CSV/PDF), pour que les deux ne divergent jamais sur les colonnes ou le filtre de période.
function construireRequetePaiements({ debut, fin, statut }) {
  const params = [];
  let query = `
    SELECT p.*, e.mois_concerne, b.numero_bien, b.adresse, b.ville,
           l.nom AS locataire_nom, pr.nom AS proprietaire_nom
    FROM paiements p
    JOIN echeances e ON e.id = p.echeance_id
    JOIN contrats c ON c.id = e.contrat_id
    JOIN biens b ON b.id = c.bien_id
    JOIN locataires l ON l.id = c.locataire_id
    JOIN users pr ON pr.id = b.proprietaire_id
    WHERE 1=1
  `;
  if (statut) {
    params.push(statut);
    query += ` AND p.statut = $${params.length}`;
  }
  if (debut) {
    params.push(debut);
    query += ` AND p.date_paiement::date >= $${params.length}`;
  }
  if (fin) {
    params.push(fin);
    query += ` AND p.date_paiement::date <= $${params.length}`;
  }
  query += ' ORDER BY p.date_paiement DESC';
  return { query, params };
}

async function tousLesPaiements(req, res) {
  const { debut, fin } = req.query;
  try {
    let { query, params } = construireRequetePaiements({ debut, fin });
    // Pas de LIMIT quand une période est précisée (rapport financier = liste complète attendue) ;
    // repli sur les 100 derniers sinon, pour ne pas changer le comportement par défaut existant.
    if (!debut && !fin) query += ' LIMIT 100';

    const resultat = await pool.query(query, params);
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur paiements :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Tous les biens de la plateforme — symétrique à tousLesContrats/tousLesPaiements,
// indépendamment de qui les gère (avec ou sans agent délégué)
async function tousLesBiens(req, res) {
  try {
    const resultat = await pool.query(`
      SELECT b.*, p.nom AS proprietaire_nom, p.email AS proprietaire_email, p.telephone AS proprietaire_telephone,
             a.nom AS agent_nom
      FROM biens b
      JOIN users p ON p.id = b.proprietaire_id
      LEFT JOIN users a ON a.id = p.agent_id
      ORDER BY b.created_at DESC
      LIMIT 100
    `);
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur biens :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Tous les locataires de la plateforme — même logique, indépendamment du propriétaire
async function tousLesLocataires(req, res) {
  try {
    const resultat = await pool.query(`
      SELECT l.*, p.nom AS proprietaire_nom, p.email AS proprietaire_email
      FROM locataires l
      LEFT JOIN users p ON p.id = l.proprietaire_id
      ORDER BY l.created_at DESC
      LIMIT 100
    `);
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur locataires :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Propriétaires assignés à un agent (l'agent consulte les siens ; un admin doit préciser
// ?agent_id=... puisqu'il n'est l'agent assigné de personne lui-même)
async function proprietairesDeAgent(req, res) {
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const agentIdCible = req.query.agent_id;

  if (estAdmin && !agentIdCible) {
    return res.status(400).json({ message: 'agent_id requis pour une consultation admin' });
  }
  const agent_id = estAdmin ? agentIdCible : req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT u.id, u.nom, u.email, u.telephone, u.ville, u.created_at, u.autorise_agent_gestion,
              COUNT(DISTINCT b.id) AS nb_biens,
              COUNT(DISTINCT c.id) FILTER (WHERE c.statut = 'actif') AS nb_contrats,
              COUNT(DISTINCT e.id) FILTER (WHERE e.statut IN ('en_attente', 'impayee', 'partielle', 'en_recouvrement')) AS nb_impayes,
              COUNT(DISTINCT m.id) FILTER (WHERE m.lu = false) AS nb_messages_non_lus
       FROM users u
       LEFT JOIN biens b ON b.proprietaire_id = u.id
       LEFT JOIN contrats c ON c.bien_id = b.id
       LEFT JOIN echeances e ON e.contrat_id = c.id
       LEFT JOIN messages m ON m.expediteur_id = u.id AND m.destinataire_id = $1 AND m.contexte = 'proprietaire'
       WHERE u.agent_id = $1 AND u.role LIKE '%proprietaire%'
       GROUP BY u.id
       ORDER BY u.created_at DESC`,
      [agent_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur propriétaires agent :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Infos de l'agent assigné (pour le propriétaire)
async function monAgent(req, res) {
  const user_id = req.user.id;
  try {
    const resultat = await pool.query(
      `SELECT a.id, a.nom, a.email, a.telephone, a.ville
       FROM users u
       JOIN users a ON a.id = u.agent_id
       WHERE u.id = $1`,
      [user_id]
    );
    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Aucun agent assigné' });
    }
    return res.json(resultat.rows[0]);
  } catch (err) {
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Journal d'activité global — toutes actions d'agents (délégation) ET d'admins/super_admin
// confondues, pour la vue d'audit du super admin (confiance / détection d'abus).
async function journalGlobal(req, res) {
  const { acteur_id, type_action } = req.query;
  try {
    const journal = await listerJournalGlobal({ acteur_id, type_action });
    return res.json(journal);
  } catch (err) {
    console.error('Erreur journal global :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Lecture des paramètres de plateforme + config des opérateurs Mobile Money (clés sensibles
// masquées : on ne renvoie jamais un secret en clair une fois qu'il a été enregistré).
async function obtenirParametres(req, res) {
  try {
    const [plateforme, operateurs] = await Promise.all([listerParametresPlateforme(), listerOperateurs()]);
    const operateursMasques = operateurs.map((o) => ({
      ...o,
      cles: Object.fromEntries(
        Object.entries(o.cles || {}).map(([cle, valeur]) => [cle, CLES_SECRETES.includes(cle) ? masquerValeur(valeur) : valeur])
      ),
    }));
    return res.json({ plateforme, operateurs: operateursMasques });
  } catch (err) {
    console.error('Erreur lecture paramètres :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Modifie le taux de commission RentEasy (ex : 0.05 pour 5%)
async function modifierCommission(req, res) {
  const { taux } = req.body;
  const valeur = parseFloat(taux);
  if (isNaN(valeur) || valeur < 0 || valeur > 1) {
    return res.status(400).json({ message: 'Le taux doit être un nombre entre 0 et 1 (ex : 0.05 pour 5%)' });
  }
  try {
    await definirParametrePlateforme('taux_commission', valeur, req.user.id);

    await enregistrerActionAgent({
      agent_id: req.user.id,
      proprietaire_id: null,
      type_action: 'modification_commission',
      description: `A changé le taux de commission à ${(valeur * 100).toFixed(2)}%.`,
    });

    return res.json({ message: 'Taux de commission mis à jour', taux: valeur });
  } catch (err) {
    console.error('Erreur modification commission :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Modifie la config d'un opérateur Mobile Money (actif/inactif + clés). Une valeur masquée
// (commençant par •, donc jamais modifiée par l'admin) est ignorée pour ne pas écraser la vraie
// clé enregistrée par la valeur masquée elle-même.
async function modifierOperateurPaiement(req, res) {
  const { operateur } = req.params;
  const { actif, cles } = req.body;
  if (!['mtn', 'moov', 'celtiis'].includes(operateur)) {
    return res.status(400).json({ message: 'Opérateur inconnu' });
  }
  try {
    let clesAEnregistrer;
    if (cles) {
      const operateurs = await listerOperateurs();
      const clesActuelles = operateurs.find((o) => o.operateur === operateur)?.cles || {};
      clesAEnregistrer = { ...clesActuelles };
      for (const [cle, valeur] of Object.entries(cles)) {
        if (typeof valeur === 'string' && valeur.startsWith('•')) continue;
        clesAEnregistrer[cle] = valeur;
      }
    }

    await definirOperateur(operateur, { actif, cles: clesAEnregistrer }, req.user.id);

    await enregistrerActionAgent({
      agent_id: req.user.id,
      proprietaire_id: null,
      type_action: 'modification_operateur_paiement',
      description: `A modifié la configuration de l'opérateur ${operateur}${actif !== undefined ? ` (${actif ? 'activé' : 'désactivé'})` : ''}.`,
    });

    return res.json({ message: 'Configuration mise à jour' });
  } catch (err) {
    console.error('Erreur modification opérateur :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// File de modération du marché : toutes les annonces actuellement publiées par un propriétaire
// (sur_le_marche = true), masquées ou non, pour que le super admin puisse retirer une annonce
// inappropriée ou revenir sur un retrait précédent. Les annonces masquées remontent en premier.
async function fileModerationMarche(req, res) {
  try {
    const resultat = await pool.query(`
      SELECT b.id, b.numero_bien, b.adresse, b.ville, b.quartier, b.type_bien, b.loyer_mensuel,
             b.type_loyer, b.description_marche, b.photos, b.created_at,
             b.moderation_masque, b.moderation_raison, b.moderation_le,
             p.nom AS proprietaire_nom, p.telephone AS proprietaire_telephone, p.email AS proprietaire_email,
             m.nom AS moderation_par_nom
      FROM biens b
      JOIN users p ON p.id = b.proprietaire_id
      LEFT JOIN users m ON m.id = b.moderation_par
      WHERE b.sur_le_marche = true
      ORDER BY b.moderation_masque DESC, b.created_at DESC
    `);
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur file de modération :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Masque (avec motif obligatoire) ou remet en ligne une annonce du marché. Le propriétaire est
// notifié dans les deux cas, et l'action est journalisée dans l'audit global.
async function modererAnnonce(req, res) {
  const { id } = req.params;
  const { masquer, raison } = req.body;

  if (masquer && !raison?.trim()) {
    return res.status(400).json({ message: 'Un motif est requis pour retirer une annonce.' });
  }

  try {
    const bien = await pool.query(
      `SELECT b.adresse, b.ville, b.proprietaire_id, p.nom, p.email
       FROM biens b JOIN users p ON p.id = b.proprietaire_id WHERE b.id = $1`,
      [id]
    );
    if (bien.rows.length === 0) {
      return res.status(404).json({ message: 'Bien non trouvé' });
    }
    const b = bien.rows[0];
    const raisonNettoyee = masquer ? raison.trim() : null;

    await pool.query(
      `UPDATE biens SET moderation_masque = $1, moderation_raison = $2, moderation_par = $3, moderation_le = NOW()
       WHERE id = $4`,
      [!!masquer, raisonNettoyee, req.user.id, id]
    );

    // Masquer l'annonce clôt de fait tout signalement encore en attente à son sujet — qu'il y en
    // ait eu un ou plusieurs — pour ne pas laisser une file de modération encombrée de
    // signalements déjà résolus par cette action.
    if (masquer) {
      await pool.query(
        `UPDATE signalements_annonces SET statut = 'traite', traite_par = $1, traite_le = NOW()
         WHERE bien_id = $2 AND statut = 'en_attente'`,
        [req.user.id, id]
      );
    }

    await enregistrerActionAgent({
      agent_id: req.user.id,
      proprietaire_id: b.proprietaire_id,
      type_action: masquer ? 'moderation_annonce_masquee' : 'moderation_annonce_republiee',
      description: masquer
        ? `A retiré l'annonce du bien ${b.adresse} du marché. Motif : ${raisonNettoyee}`
        : `A remis en ligne l'annonce du bien ${b.adresse}.`,
      reference_type: 'bien',
      reference_id: id,
    });

    await notifier({
      user_id: b.proprietaire_id,
      email: b.email,
      nom: b.nom,
      titre: masquer ? 'Annonce retirée du marché' : 'Annonce remise en ligne',
      message: masquer
        ? `Votre annonce pour le bien ${b.adresse}, ${b.ville} a été retirée du marché par la modération. Motif : ${raisonNettoyee}`
        : `Votre annonce pour le bien ${b.adresse}, ${b.ville} a été remise en ligne sur le marché.`,
      type: 'moderation',
      lien: '/biens',
      sujet_email: masquer ? '[RentEasy] Votre annonce a été retirée' : '[RentEasy] Votre annonce est de nouveau en ligne',
      contenu_email: masquer
        ? `<h2>Annonce retirée</h2><p>Bonjour ${echapperHtml(b.nom)},</p><p>Votre annonce pour le bien <strong>${echapperHtml(b.adresse)}, ${echapperHtml(b.ville)}</strong> a été retirée du marché par notre équipe.</p><p><strong>Motif :</strong> ${echapperHtml(raisonNettoyee)}</p><p>Vous pouvez la modifier depuis votre espace RentEasy, ou contacter le support pour plus d'informations.</p>`
        : `<h2>Annonce remise en ligne</h2><p>Bonjour ${echapperHtml(b.nom)},</p><p>Votre annonce pour le bien <strong>${echapperHtml(b.adresse)}, ${echapperHtml(b.ville)}</strong> est de nouveau visible sur le marché.</p>`,
    });

    return res.json({ message: masquer ? 'Annonce retirée du marché.' : 'Annonce remise en ligne.' });
  } catch (err) {
    console.error('Erreur modération annonce :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Export CSV/PDF des paiements réussis sur une période donnée, pour la compta ou pour rendre
// des comptes en dehors de la plateforme. Par défaut (aucune date fournie), le mois en cours.
async function exporterRapportFinancier(req, res) {
  const formatSortie = (req.query.format || 'csv').toLowerCase();
  const maintenant = new Date();
  const debut = req.query.debut || new Date(maintenant.getFullYear(), maintenant.getMonth(), 1).toISOString().slice(0, 10);
  const fin = req.query.fin || new Date(maintenant.getFullYear(), maintenant.getMonth() + 1, 0).toISOString().slice(0, 10);

  if (!['csv', 'pdf'].includes(formatSortie)) {
    return res.status(400).json({ message: 'Format invalide : csv ou pdf attendu.' });
  }

  try {
    const { query, params } = construireRequetePaiements({ debut, fin, statut: 'reussi' });
    // Un rapport financier ne porte que sur les paiements réellement encaissés — un paiement
    // en_cours (Mobile Money non confirmé) ou échoué n'a pas sa place dans un état des comptes.
    const resultat = await pool.query(query, params);

    await enregistrerActionAgent({
      agent_id: req.user.id,
      proprietaire_id: null,
      type_action: 'export_rapport_financier',
      description: `A exporté le rapport financier du ${debut} au ${fin} (${formatSortie.toUpperCase()}, ${resultat.rows.length} paiement(s)).`,
    });

    if (formatSortie === 'pdf') {
      return genererRapportPDF(res, { paiements: resultat.rows, dateDebut: debut, dateFin: fin });
    }
    return genererRapportCSV(res, { paiements: resultat.rows, dateDebut: debut, dateFin: fin });
  } catch (err) {
    console.error('Erreur export rapport financier :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Liste des comptes admin/super_admin avec le nombre d'agents qu'ils gèrent — utilisé pour le
// sélecteur "réassigner à" lors d'une désactivation ou rétrogradation.
async function listerAdmins(req, res) {
  try {
    const resultat = await pool.query(`
      SELECT u.id, u.nom, u.email, u.actif, u.role,
             COUNT(a.id)::int AS nb_agents_geres
      FROM users u
      LEFT JOIN users a ON a.gere_par_admin_id = u.id
      WHERE u.role LIKE '%admin%'
      GROUP BY u.id
      ORDER BY (u.role LIKE '%super_admin%') DESC, u.nom ASC
    `);
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste admins :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Rétrograde un admin (retour au rôle propriétaire) — réservé aux comptes admin, jamais
// super_admin. Exige un admin cible si des agents sont encore sous sa responsabilité.
async function retrograderAdmin(req, res) {
  const { id } = req.params;
  const { nouvel_admin_id } = req.body;

  try {
    const admin = await pool.query('SELECT id, nom, email, role FROM users WHERE id = $1', [id]);
    if (admin.rows.length === 0) return res.status(404).json({ message: 'Utilisateur non trouvé' });
    const a = admin.rows[0];

    if (a.role.includes('super_admin')) {
      return res.status(403).json({ message: 'Impossible de rétrograder un super admin' });
    }
    if (!a.role.includes('admin')) {
      return res.status(400).json({ message: 'Ce compte n\'est pas un admin.' });
    }

    const agentsGeres = await pool.query('SELECT COUNT(*) AS total FROM users WHERE gere_par_admin_id = $1', [id]);
    let nbAgentsReassignes = 0;
    if (parseInt(agentsGeres.rows[0].total) > 0) {
      if (!nouvel_admin_id) {
        return res.status(400).json({
          message: `Cet admin gère encore ${agentsGeres.rows[0].total} agent(s). Précisez à quel admin les réassigner avant de rétrograder ce compte.`,
          agents_geres: parseInt(agentsGeres.rows[0].total),
        });
      }
      if (nouvel_admin_id === id) {
        return res.status(400).json({ message: 'Impossible de réassigner les agents à l\'admin qu\'on rétrograde.' });
      }
      nbAgentsReassignes = await reassignerAgentsDAdmin(id, nouvel_admin_id, req.user.id);
    }

    await pool.query("UPDATE users SET role = 'proprietaire' WHERE id = $1", [id]);

    await enregistrerActionAgent({
      agent_id: req.user.id,
      proprietaire_id: id,
      type_action: 'retrogradation_admin',
      description: `A rétrogradé ${a.nom} du rôle admin à propriétaire.`,
      reference_type: 'user',
      reference_id: id,
    });

    await notifier({
      user_id: id,
      email: a.email,
      nom: a.nom,
      titre: 'Changement de rôle sur RentEasy',
      message: 'Votre compte n\'a plus les droits administrateur sur RentEasy.',
      type: 'compte',
      lien: '/dashboard',
      sujet_email: '[RentEasy] Changement de rôle',
      contenu_email: `<h2>Changement de rôle</h2><p>Bonjour ${echapperHtml(a.nom)},</p><p>Votre compte RentEasy n'a désormais plus les droits administrateur. Vous conservez l'accès à votre espace propriétaire.</p>`,
    });

    return res.json({
      message: `Compte rétrogradé avec succès${nbAgentsReassignes > 0 ? ` (${nbAgentsReassignes} agent(s) réassigné(s))` : ''}`,
    });
  } catch (err) {
    console.error('Erreur rétrogradation admin :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Signalements d'annonces en attente, avec l'annonce et l'auteur du signalement — alimente la
// file de modération aux côtés de fileModerationMarche.
async function listerSignalements(req, res) {
  try {
    const resultat = await pool.query(`
      SELECT s.id, s.motif, s.description, s.statut, s.created_at,
             b.id AS bien_id, b.numero_bien, b.adresse, b.ville, b.moderation_masque,
             pr.nom AS proprietaire_nom,
             u.nom AS signale_par_nom, u.role AS signale_par_role
      FROM signalements_annonces s
      JOIN biens b ON b.id = s.bien_id
      JOIN users pr ON pr.id = b.proprietaire_id
      JOIN users u ON u.id = s.signale_par
      WHERE s.statut = 'en_attente'
      ORDER BY s.created_at ASC
    `);
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste signalements :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Marque un signalement comme traité (l'annonce a été masquée via modererAnnonce, en amont côté
// frontend) ou rejeté (signalement jugé non fondé, l'annonce reste en ligne).
async function traiterSignalement(req, res) {
  const { id } = req.params;
  const { action } = req.body; // 'traite' | 'rejete'

  if (!['traite', 'rejete'].includes(action)) {
    return res.status(400).json({ message: 'Action invalide.' });
  }

  try {
    const resultat = await pool.query(
      `UPDATE signalements_annonces SET statut = $1, traite_par = $2, traite_le = NOW()
       WHERE id = $3 AND statut = 'en_attente' RETURNING id`,
      [action, req.user.id, id]
    );
    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Signalement non trouvé ou déjà traité.' });
    }
    return res.json({ message: action === 'traite' ? 'Signalement marqué comme traité.' : 'Signalement rejeté.' });
  } catch (err) {
    console.error('Erreur traitement signalement :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Historique des rappels d'échéances envoyés (avant paiement, jour J, retards) — visibilité sur
// le mécanisme automatique introduit dans rappelsEcheances.js, pour vérifier qu'il tourne bien
// et voir qui a été relancé. Filtrable par type de rappel et par période d'envoi.
async function listerRappelsEnvoyes(req, res) {
  const { type_rappel, debut, fin } = req.query;
  try {
    const params = [];
    let query = `
      SELECT r.id, r.type_rappel, r.envoye_le,
             e.mois_concerne, e.montant_du, e.date_limite, e.statut AS statut_echeance,
             b.numero_bien, b.adresse, b.ville,
             l.nom AS locataire_nom,
             p.nom AS proprietaire_nom
      FROM rappels_echeances_envoyes r
      JOIN echeances e ON e.id = r.echeance_id
      JOIN contrats c ON c.id = e.contrat_id
      JOIN biens b ON b.id = c.bien_id
      JOIN locataires l ON l.id = c.locataire_id
      JOIN users p ON p.id = b.proprietaire_id
      WHERE 1=1
    `;
    if (type_rappel) {
      params.push(type_rappel);
      query += ` AND r.type_rappel = $${params.length}`;
    }
    if (debut) {
      params.push(debut);
      query += ` AND r.envoye_le::date >= $${params.length}`;
    }
    if (fin) {
      params.push(fin);
      query += ` AND r.envoye_le::date <= $${params.length}`;
    }
    query += ' ORDER BY r.envoye_le DESC LIMIT 500';

    const resultat = await pool.query(query, params);
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste rappels échéances :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Historique des erreurs serveur capturées (500, exceptions non attrapées, rejets de promesse
// non gérés) — cf. utils/erreurs.js. Filtrable par période.
async function listerErreurs(req, res) {
  const { debut, fin } = req.query;
  try {
    const params = [];
    let query = 'SELECT * FROM erreurs_serveur WHERE 1=1';
    if (debut) {
      params.push(debut);
      query += ` AND created_at::date >= $${params.length}`;
    }
    if (fin) {
      params.push(fin);
      query += ` AND created_at::date <= $${params.length}`;
    }
    query += ' ORDER BY created_at DESC LIMIT 300';

    const resultat = await pool.query(query, params);
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste erreurs serveur :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = { obtenirStats, listerUtilisateurs, toggleActiverCompte, reassignerAgent, listerAgents, tousLesContrats, tousLesPaiements, tousLesBiens, tousLesLocataires, proprietairesDeAgent, monAgent, rapportFinancierRegional, journalGlobal, obtenirParametres, modifierCommission, modifierOperateurPaiement, fileModerationMarche, modererAnnonce, exporterRapportFinancier, listerAdmins, retrograderAdmin, listerSignalements, traiterSignalement, listerRappelsEnvoyes, listerErreurs };
