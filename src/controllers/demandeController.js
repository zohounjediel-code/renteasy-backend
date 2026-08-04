const pool = require('../config/database');
const { notifier, echapperHtml } = require('../utils/notifications');
const { genererDatesEcheances, ajouterPeriode } = require('../utils/echeances');

const UNITES_INTERVAL = { jours: 'days', semaines: 'weeks', mois: 'months', annees: 'years' };

// Propriétaire soumet une demande de modification ou résiliation
async function soumettreDemandeContrat(req, res) {
  const { id: contrat_id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const { type_demande, conditions_demandees, note_proprietaire } = req.body;

  if (!type_demande || !['modification', 'resiliation'].includes(type_demande)) {
    return res.status(400).json({ message: 'type_demande doit être "modification" ou "resiliation"' });
  }

  try {
    // Vérifier que le contrat appartient bien au propriétaire (un admin peut agir pour
    // n'importe quel propriétaire, en consultation — cf. resoudreProprietaireConsulte ailleurs)
    const contrat = await pool.query(
      `SELECT c.*, b.adresse, b.ville, b.proprietaire_id, l.nom AS locataire_nom,
              l.email AS locataire_email, l.telephone AS locataire_telephone
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE c.id = $1`,
      [contrat_id]
    );

    if (contrat.rows.length === 0 || (!estAdmin && contrat.rows[0].proprietaire_id !== req.user.id)) {
      return res.status(404).json({ message: 'Contrat non trouvé' });
    }

    const c = contrat.rows[0];
    // Toujours le vrai propriétaire du contrat, pas req.user.id (qui serait celui de l'admin,
    // pas un vrai propriétaire, si c'est un admin qui agit ici en consultation).
    const proprietaire_id = c.proprietaire_id;

    // Vérifier qu'il n'y a pas déjà une demande en attente sur ce contrat
    const demandeExistante = await pool.query(
      "SELECT id FROM demandes_contrat WHERE contrat_id = $1 AND statut = 'en_attente'",
      [contrat_id]
    );

    if (demandeExistante.rows.length > 0) {
      return res.status(409).json({ message: 'Une demande est déjà en attente sur ce contrat' });
    }

    // Récupérer l'agent assigné au propriétaire
    const proprietaire = await pool.query(
      'SELECT nom, email, agent_id FROM users WHERE id = $1',
      [proprietaire_id]
    );

    const agent_id = proprietaire.rows[0].agent_id;

    if (!agent_id) {
      return res.status(500).json({ message: 'Aucun agent assigné à ce compte propriétaire' });
    }

    // Créer la demande
    const demande = await pool.query(
      `INSERT INTO demandes_contrat (contrat_id, proprietaire_id, agent_id, type_demande, conditions_demandees, note_proprietaire)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [contrat_id, proprietaire_id, agent_id, type_demande, JSON.stringify(conditions_demandees || {}), note_proprietaire || null]
    );

    // Récupérer infos agent
    const agent = await pool.query('SELECT id, nom, email FROM users WHERE id = $1', [agent_id]);
    const agentData = agent.rows[0];

    const typeLabel = type_demande === 'modification' ? 'modification de contrat' : 'résiliation de contrat';
    const bienLabel = echapperHtml(`${c.adresse || ''} ${c.ville}`.trim());

    // Notifier l'agent
    await notifier({
      user_id: agentData.id,
      email: agentData.email,
      nom: agentData.nom,
      titre: `Nouvelle demande de ${typeLabel}`,
      message: `Le propriétaire ${proprietaire.rows[0].nom} a soumis une demande de ${typeLabel} pour le bien ${bienLabel}.`,
      type: 'demande',
      lien: `/agent/demandes/${demande.rows[0].id}`,
      sujet_email: `[RentEasy] Demande de ${typeLabel} — ${bienLabel}`,
      contenu_email: `
        <h2>Nouvelle demande de ${typeLabel}</h2>
        <p>Bonjour ${echapperHtml(agentData.nom)},</p>
        <p>Le propriétaire <strong>${echapperHtml(proprietaire.rows[0].nom)}</strong> a soumis une demande de ${typeLabel} pour le bien :</p>
        <p><strong>${bienLabel}</strong> · Locataire : ${echapperHtml(c.locataire_nom)}</p>
        ${note_proprietaire ? `<p>Note : ${echapperHtml(note_proprietaire)}</p>` : ''}
        <p>Connectez-vous à RentEasy Bénin pour traiter cette demande.</p>
      `,
    });

    // Notifier le locataire
    if (c.locataire_email) {
      await notifier({
        user_id: null,
        email: c.locataire_email,
        nom: c.locataire_nom,
        titre: `Information concernant votre contrat`,
        message: `Une demande de ${typeLabel} a été soumise concernant votre logement.`,
        type: 'demande',
        sujet_email: `[RentEasy] Information concernant votre contrat`,
        contenu_email: `
          <h2>Information concernant votre contrat</h2>
          <p>Bonjour ${echapperHtml(c.locataire_nom)},</p>
          <p>Votre propriétaire a soumis une demande de <strong>${typeLabel}</strong> concernant votre logement au <strong>${bienLabel}</strong>.</p>
          <p>Un agent RentEasy prendra contact avec vous prochainement pour faire le point.</p>
        `,
      });
    }

    return res.status(201).json({
      message: 'Demande soumise avec succès. L\'agent et le locataire ont été notifiés.',
      demande: demande.rows[0],
    });
  } catch (err) {
    console.error('Erreur soumission demande :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Agent : lister ses demandes en attente
async function listerDemandes(req, res) {
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const agent_id = req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT d.*,
              c.loyer_mensuel, c.date_debut, c.jour_echeance,
              b.numero_bien, b.adresse, b.ville, b.type_bien,
              l.nom AS locataire_nom, l.telephone AS locataire_telephone,
              p.nom AS proprietaire_nom, p.email AS proprietaire_email, p.telephone AS proprietaire_telephone,
              ag.nom AS agent_nom
       FROM demandes_contrat d
       JOIN contrats c ON c.id = d.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       JOIN users p ON p.id = d.proprietaire_id
       LEFT JOIN users ag ON ag.id = d.agent_id
       ${estAdmin ? '' : 'WHERE d.agent_id = $1'}
       ORDER BY d.created_at DESC`,
      estAdmin ? [] : [agent_id]
    );

    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste demandes :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Agent (ou admin) : approuver une demande
async function approuverDemande(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const agent_id = req.user.id;
  const { note_agent } = req.body;

  try {
    const demande = await pool.query(
      `SELECT d.*, c.bien_id, c.locataire_id,
              b.adresse, b.ville,
              p.nom AS proprietaire_nom, p.email AS proprietaire_email, p.id AS proprietaire_id,
              l.nom AS locataire_nom, l.email AS locataire_email
       FROM demandes_contrat d
       JOIN contrats c ON c.id = d.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       JOIN users p ON p.id = d.proprietaire_id
       WHERE d.id = $1 ${estAdmin ? '' : 'AND d.agent_id = $2'}`,
      estAdmin ? [id] : [id, agent_id]
    );

    if (demande.rows.length === 0) {
      return res.status(404).json({ message: 'Demande non trouvée' });
    }

    const d = demande.rows[0];

    if (d.statut !== 'en_attente') {
      return res.status(409).json({ message: 'Cette demande a déjà été traitée' });
    }

    // Mettre à jour le statut de la demande
    await pool.query(
      "UPDATE demandes_contrat SET statut = 'approuvee', note_agent = $1, updated_at = NOW() WHERE id = $2",
      [note_agent || null, id]
    );

    const bienLabel = echapperHtml(`${d.adresse || ''} ${d.ville}`.trim());

    if (d.type_demande === 'resiliation') {
      // Résilier le contrat
      await pool.query("UPDATE contrats SET statut = 'resilie' WHERE id = $1", [d.contrat_id]);
      await pool.query("UPDATE biens SET statut = 'libre', updated_at = NOW() WHERE id = $1", [d.bien_id]);
      // Supprime les échéances futures pas encore dues ; garde les passées (impayées/partielles) pour recouvrement
      await pool.query(
        "DELETE FROM echeances WHERE contrat_id = $1 AND statut = 'en_attente' AND date_limite > CURRENT_DATE",
        [d.contrat_id]
      );
    } else if (d.type_demande === 'modification') {
      // Appliquer les modifications demandées
      const conditions = d.conditions_demandees || {};
      if (conditions.loyer_mensuel) {
        await pool.query(
          'UPDATE contrats SET loyer_mensuel = $1 WHERE id = $2',
          [conditions.loyer_mensuel, d.contrat_id]
        );
        // Répercute le nouveau loyer sur les échéances déjà générées mais pas encore dues
        // (statut 'en_attente' = future, aucun paiement encore effectué dessus). Sans ça, le
        // nouveau montant ne s'appliquait qu'aux échéances générées APRÈS ce changement —
        // jusqu'à 12 mois (voire 60 lors d'un renouvellement) d'échéances déjà en base
        // gardaient l'ancien loyer jusqu'à épuisement. On ne touche jamais aux échéances
        // payées, partielles, impayées (déjà en retard) ou en recouvrement : seules celles
        // qui n'ont encore fait l'objet d'aucun paiement et ne sont pas encore dues changent.
        await pool.query(
          "UPDATE echeances SET montant_du = $1 WHERE contrat_id = $2 AND statut = 'en_attente'",
          [conditions.loyer_mensuel, d.contrat_id]
        );
      }
    }

    // Notifier le propriétaire
    await notifier({
      user_id: d.proprietaire_id,
      email: d.proprietaire_email,
      nom: d.proprietaire_nom,
      titre: `Demande approuvée`,
      message: `Votre demande de ${d.type_demande} pour le bien ${bienLabel} a été approuvée par votre agent.`,
      type: 'approbation',
      sujet_email: `[RentEasy] Votre demande a été approuvée`,
      contenu_email: `
        <h2>Demande approuvée</h2>
        <p>Bonjour ${echapperHtml(d.proprietaire_nom)},</p>
        <p>Votre demande de <strong>${d.type_demande}</strong> pour le bien <strong>${bienLabel}</strong> a été approuvée.</p>
        ${note_agent ? `<p>Note de l'agent : ${echapperHtml(note_agent)}</p>` : ''}
      `,
    });

    // Notifier le locataire si email disponible
    if (d.locataire_email) {
      await notifier({
        user_id: null,
        email: d.locataire_email,
        nom: d.locataire_nom,
        titre: `Mise à jour de votre contrat`,
        message: `La demande de ${d.type_demande} concernant votre logement a été approuvée.`,
        type: 'approbation',
        sujet_email: `[RentEasy] Mise à jour de votre contrat`,
        contenu_email: `
          <h2>Mise à jour de votre contrat</h2>
          <p>Bonjour ${echapperHtml(d.locataire_nom)},</p>
          <p>La demande de <strong>${d.type_demande}</strong> concernant votre logement au <strong>${bienLabel}</strong> a été approuvée.</p>
          ${note_agent ? `<p>Note : ${echapperHtml(note_agent)}</p>` : ''}
        `,
      });
    }

    return res.json({ message: 'Demande approuvée avec succès' });
  } catch (err) {
    console.error('Erreur approbation demande :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Agent (ou admin) : annuler une demande
async function annulerDemande(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const agent_id = req.user.id;
  const { note_agent } = req.body;

  try {
    const demande = await pool.query(
      `SELECT d.*, b.adresse, b.ville,
              p.nom AS proprietaire_nom, p.email AS proprietaire_email, p.id AS proprietaire_id
       FROM demandes_contrat d
       JOIN contrats c ON c.id = d.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN users p ON p.id = d.proprietaire_id
       WHERE d.id = $1 ${estAdmin ? '' : 'AND d.agent_id = $2'} AND d.statut = 'en_attente'`,
      estAdmin ? [id] : [id, agent_id]
    );

    if (demande.rows.length === 0) {
      return res.status(404).json({ message: 'Demande non trouvée ou déjà traitée' });
    }

    const d = demande.rows[0];

    await pool.query(
      "UPDATE demandes_contrat SET statut = 'annulee', note_agent = $1, updated_at = NOW() WHERE id = $2",
      [note_agent || null, id]
    );

    const bienLabel = echapperHtml(`${d.adresse || ''} ${d.ville}`.trim());

    // Notifier le propriétaire
    await notifier({
      user_id: d.proprietaire_id,
      email: d.proprietaire_email,
      nom: d.proprietaire_nom,
      titre: `Demande annulée`,
      message: `Votre demande de ${d.type_demande} pour le bien ${bienLabel} a été annulée par votre agent.`,
      type: 'annulation',
      sujet_email: `[RentEasy] Votre demande a été annulée`,
      contenu_email: `
        <h2>Demande annulée</h2>
        <p>Bonjour ${echapperHtml(d.proprietaire_nom)},</p>
        <p>Votre demande de <strong>${d.type_demande}</strong> pour le bien <strong>${bienLabel}</strong> a été annulée.</p>
        ${note_agent ? `<p>Motif : ${echapperHtml(note_agent)}</p>` : ''}
        <p>Contactez votre agent pour plus d'informations.</p>
      `,
    });

    return res.json({ message: 'Demande annulée' });
  } catch (err) {
    console.error('Erreur annulation demande :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Locataire soumet une demande de résiliation de son contrat auprès de l'agent du propriétaire
async function soumettreDemandeResiliationLocataire(req, res) {
  const { id: contrat_id } = req.params;
  const user_id = req.user.id;
  const { note_locataire } = req.body;

  try {
    const contrat = await pool.query(
      `SELECT c.*, b.adresse, b.ville, b.numero_bien, b.proprietaire_id,
              p.nom AS proprietaire_nom, p.email AS proprietaire_email, p.agent_id,
              l.nom AS locataire_nom, l.email AS locataire_email, l.telephone AS locataire_telephone
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       JOIN users p ON p.id = b.proprietaire_id
       WHERE c.id = $1 AND l.user_id = $2`,
      [contrat_id, user_id]
    );

    if (contrat.rows.length === 0) {
      return res.status(404).json({ message: 'Contrat non trouvé' });
    }

    const c = contrat.rows[0];

    if (c.statut !== 'actif') {
      return res.status(409).json({ message: 'Seul un contrat actif peut faire l\'objet d\'une demande de résiliation' });
    }

    const demandeExistante = await pool.query(
      "SELECT id FROM demandes_contrat WHERE contrat_id = $1 AND statut = 'en_attente'",
      [contrat_id]
    );
    if (demandeExistante.rows.length > 0) {
      return res.status(409).json({ message: 'Une demande est déjà en attente sur ce contrat' });
    }

    if (!c.agent_id) {
      return res.status(500).json({ message: 'Aucun agent assigné à ce propriétaire' });
    }

    const demande = await pool.query(
      `INSERT INTO demandes_contrat (contrat_id, proprietaire_id, agent_id, type_demande, note_proprietaire, initiee_par)
       VALUES ($1, $2, $3, 'resiliation', $4, 'locataire')
       RETURNING *`,
      [contrat_id, c.proprietaire_id, c.agent_id, note_locataire || null]
    );

    const agent = await pool.query('SELECT id, nom, email FROM users WHERE id = $1', [c.agent_id]);
    const agentData = agent.rows[0];
    const bienLabel = echapperHtml(`${c.adresse || ''} ${c.ville}`.trim());

    await notifier({
      user_id: agentData.id,
      email: agentData.email,
      nom: agentData.nom,
      titre: 'Demande de résiliation (locataire)',
      message: `${c.locataire_nom} a demandé la résiliation de son contrat pour le bien ${c.numero_bien}.`,
      type: 'demande',
      lien: `/agent/demandes`,
      sujet_email: `[RentEasy] Demande de résiliation — ${bienLabel}`,
      contenu_email: `
        <h2>Demande de résiliation (initiée par le locataire)</h2>
        <p>Bonjour ${echapperHtml(agentData.nom)},</p>
        <p>Le locataire <strong>${echapperHtml(c.locataire_nom)}</strong> souhaite résilier son contrat pour le bien :</p>
        <p><strong>${bienLabel}</strong> · Propriétaire : ${echapperHtml(c.proprietaire_nom)}</p>
        ${note_locataire ? `<p>Motif : ${echapperHtml(note_locataire)}</p>` : ''}
        <p>Connectez-vous à RentEasy Bénin pour traiter cette demande.</p>
      `,
    });

    await notifier({
      user_id: c.proprietaire_id,
      email: c.proprietaire_email,
      nom: c.proprietaire_nom,
      titre: 'Demande de résiliation par votre locataire',
      message: `${c.locataire_nom} a demandé la résiliation du contrat pour le bien ${c.numero_bien}. Votre agent va traiter la demande.`,
      type: 'demande',
      sujet_email: `[RentEasy] Demande de résiliation — ${bienLabel}`,
      contenu_email: `
        <h2>Demande de résiliation</h2>
        <p>Bonjour ${echapperHtml(c.proprietaire_nom)},</p>
        <p>Votre locataire <strong>${echapperHtml(c.locataire_nom)}</strong> a demandé la résiliation du contrat pour le bien <strong>${bienLabel}</strong>.</p>
        ${note_locataire ? `<p>Motif : ${echapperHtml(note_locataire)}</p>` : ''}
        <p>Votre agent va examiner cette demande.</p>
      `,
    });

    return res.status(201).json({
      message: 'Demande de résiliation envoyée à votre agent',
      demande: demande.rows[0],
    });
  } catch (err) {
    console.error('Erreur demande résiliation locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Détecte les contrats à durée déterminée dont la période est terminée et crée
// automatiquement une demande "fin_contrat" pour l'agent (appelée par le cron quotidien)
async function detecterFinsDeContrat(pool) {
  const contrats = await pool.query(`
    SELECT c.*, b.numero_bien, b.adresse, b.ville, b.proprietaire_id,
           p.nom AS proprietaire_nom, p.email AS proprietaire_email, p.agent_id,
           l.nom AS locataire_nom, l.email AS locataire_email, l.user_id AS locataire_user_id
    FROM contrats c
    JOIN biens b ON b.id = c.bien_id
    JOIN users p ON p.id = b.proprietaire_id
    JOIN locataires l ON l.id = c.locataire_id
    WHERE c.statut = 'actif' AND c.date_fin IS NOT NULL AND c.date_fin < CURRENT_DATE
      AND NOT EXISTS (
        SELECT 1 FROM demandes_contrat d
        WHERE d.contrat_id = c.id AND d.type_demande = 'fin_contrat' AND d.statut = 'en_attente'
      )
  `);

  for (const c of contrats.rows) {
    // Avant : "if (!c.agent_id) continue" sautait silencieusement TOUT le traitement dès
    // qu'un propriétaire n'avait aucun agent assigné — ni demande créée (donc redétecté à
    // chaque passage du cron, indéfiniment), ni même le propriétaire prévenu que son contrat
    // était arrivé à son terme. La demande est maintenant toujours créée (agent_id peut être
    // NULL, colonne nullable) ; sans agent, ce sont les admin/super_admin qui sont notifiés à
    // sa place, pour qu'ils traitent la fin de contrat eux-mêmes ou assignent un agent en
    // urgence — listerDemandes utilise déjà un LEFT JOIN sur l'agent, donc ces demandes
    // restent bien visibles pour eux une fois créées.
    await pool.query(
      `INSERT INTO demandes_contrat (contrat_id, proprietaire_id, agent_id, type_demande, initiee_par)
       VALUES ($1, $2, $3, 'fin_contrat', 'systeme')`,
      [c.id, c.proprietaire_id, c.agent_id || null]
    );

    const bienLabel = echapperHtml(`${c.adresse || ''} ${c.ville}`.trim());

    if (c.agent_id) {
      const agent = await pool.query('SELECT nom, email FROM users WHERE id = $1', [c.agent_id]);
      const agentData = agent.rows[0];

      if (agentData) {
        await notifier({
          user_id: c.agent_id,
          email: agentData.email,
          nom: agentData.nom,
          titre: 'Fin de contrat à traiter',
          message: `Le contrat pour le bien ${c.numero_bien} arrive à son terme. Validez la résiliation ou renouvelez-le après accord des deux parties.`,
          type: 'demande',
          lien: '/agent/demandes',
          sujet_email: `[RentEasy] Fin de contrat — ${c.numero_bien}`,
          contenu_email: `
            <h2>Fin de contrat à traiter</h2>
            <p>Bonjour ${echapperHtml(agentData.nom)},</p>
            <p>Le contrat de <strong>${echapperHtml(c.proprietaire_nom)}</strong> avec <strong>${echapperHtml(c.locataire_nom)}</strong> pour le bien <strong>${bienLabel}</strong> est arrivé à son terme.</p>
            <p>Contactez les deux parties : validez la résiliation, ou renouvelez le contrat s'ils sont d'accord.</p>
          `,
        });
      }
    } else {
      const admins = await pool.query(`SELECT id, nom, email FROM users WHERE role LIKE '%admin%'`);
      for (const admin of admins.rows) {
        await notifier({
          user_id: admin.id,
          email: admin.email,
          nom: admin.nom,
          titre: 'Fin de contrat — aucun agent assigné',
          message: `Le contrat pour le bien ${bienLabel} (${c.proprietaire_nom}) est arrivé à son terme, mais ce propriétaire n'a aucun agent assigné. Traitez la demande vous-même ou assignez-lui un agent en urgence.`,
          type: 'demande',
          lien: '/agent/demandes',
          sujet_email: '[RentEasy] Fin de contrat — aucun agent assigné',
          contenu_email: `
            <h2>Fin de contrat — aucun agent assigné</h2>
            <p>Bonjour ${echapperHtml(admin.nom)},</p>
            <p>Le contrat de <strong>${echapperHtml(c.proprietaire_nom)}</strong> pour le bien <strong>${bienLabel}</strong> est arrivé à son terme, mais ce propriétaire n'a aucun agent assigné pour traiter la résiliation ou le renouvellement.</p>
            <p>Traitez cette demande directement depuis "Demandes", ou assignez un agent à ce propriétaire en urgence.</p>
          `,
        });
      }
    }

    await notifier({
      user_id: c.proprietaire_id,
      email: c.proprietaire_email,
      nom: c.proprietaire_nom,
      titre: 'Contrat arrivé à son terme',
      message: c.agent_id
        ? `Le contrat pour le bien ${c.numero_bien} est arrivé à son terme. Votre agent va vous contacter pour la résiliation ou le renouvellement.`
        : `Le contrat pour le bien ${c.numero_bien} est arrivé à son terme. RentEasy va vous contacter pour la résiliation ou le renouvellement.`,
      type: 'info',
    });

    if (c.locataire_user_id) {
      await notifier({
        user_id: c.locataire_user_id,
        email: c.locataire_email,
        nom: c.locataire_nom,
        titre: 'Contrat arrivé à son terme',
        message: `Votre contrat pour le bien ${c.numero_bien} est arrivé à son terme. Votre agent va vous contacter pour la résiliation ou le renouvellement.`,
        type: 'info',
      });
    }
  }
}

const SEUIL_ESCALADE_JOURS = 3;

// Escalade des demandes bloquées : une demande encore 'en_attente' depuis plus de
// SEUIL_ESCALADE_JOURS jours sans avoir été traitée par l'agent assigné est marquée
// "escaladee" et tous les admin/super_admin sont notifiés. listerDemandes ne filtre déjà
// pas par agent_id pour un admin (il voit tout), donc l'escalade sert surtout à le prévenir
// activement plutôt qu'à l'obliger à surveiller une liste qui grossit en continu.
async function escaladerDemandesBloquees(pool) {
  const bloquees = await pool.query(`
    SELECT d.*, b.numero_bien, b.adresse, b.ville, p.nom AS proprietaire_nom
    FROM demandes_contrat d
    JOIN contrats c ON c.id = d.contrat_id
    JOIN biens b ON b.id = c.bien_id
    JOIN users p ON p.id = d.proprietaire_id
    WHERE d.statut = 'en_attente' AND d.escaladee = false
      AND d.created_at < NOW() - INTERVAL '${SEUIL_ESCALADE_JOURS} days'
  `);

  if (bloquees.rows.length === 0) return;

  const admins = await pool.query(`SELECT id, nom, email FROM users WHERE role LIKE '%admin%'`);

  for (const d of bloquees.rows) {
    await pool.query(
      "UPDATE demandes_contrat SET escaladee = true, updated_at = NOW() WHERE id = $1",
      [d.id]
    );

    const bienLabel = echapperHtml(`${d.adresse || ''} ${d.ville}`.trim());
    const typeLabel = d.type_demande === 'modification' ? 'modification de contrat'
      : d.type_demande === 'resiliation' ? 'résiliation de contrat' : 'fin de contrat';

    for (const admin of admins.rows) {
      await notifier({
        user_id: admin.id,
        email: admin.email,
        nom: admin.nom,
        titre: 'Demande bloquée — action requise',
        message: `Une demande de ${typeLabel} pour ${bienLabel} (${d.proprietaire_nom}) est en attente depuis plus de ${SEUIL_ESCALADE_JOURS} jours sans avoir été traitée par l'agent.`,
        type: 'escalade',
        lien: '/agent/demandes',
        sujet_email: '[RentEasy] Demande bloquée — action requise',
        contenu_email: `
          <h2>Demande bloquée</h2>
          <p>Bonjour ${echapperHtml(admin.nom)},</p>
          <p>Une demande de <strong>${typeLabel}</strong> pour le bien <strong>${bienLabel}</strong> (propriétaire : ${echapperHtml(d.proprietaire_nom)}) est en attente depuis plus de ${SEUIL_ESCALADE_JOURS} jours sans avoir été traitée par l'agent assigné.</p>
          <p>Connectez-vous à RentEasy Bénin pour la prendre en charge.</p>
        `,
      });
    }
  }
}

// L'agent (ou l'admin) valide la fin du contrat (résiliation définitive)
async function finaliserResiliationContrat(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const agent_id = req.user.id;

  try {
    const demande = await pool.query(
      `SELECT d.*, c.bien_id, b.numero_bien, b.proprietaire_id,
              p.nom AS proprietaire_nom, p.email AS proprietaire_email,
              l.nom AS locataire_nom, l.email AS locataire_email, l.user_id AS locataire_user_id
       FROM demandes_contrat d
       JOIN contrats c ON c.id = d.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN users p ON p.id = b.proprietaire_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE d.id = $1 ${estAdmin ? '' : 'AND d.agent_id = $2'} AND d.type_demande = 'fin_contrat' AND d.statut = 'en_attente'`,
      estAdmin ? [id] : [id, agent_id]
    );
    if (demande.rows.length === 0) {
      return res.status(404).json({ message: 'Demande non trouvée ou déjà traitée' });
    }
    const d = demande.rows[0];

    await pool.query("UPDATE contrats SET statut = 'resilie' WHERE id = $1", [d.contrat_id]);
    await pool.query("UPDATE biens SET statut = 'libre', updated_at = NOW() WHERE id = $1", [d.bien_id]);
    await pool.query("UPDATE demandes_contrat SET statut = 'approuvee' WHERE id = $1", [id]);

    const bienLabel = d.numero_bien;
    for (const dest of [
      { user_id: d.proprietaire_id, email: d.proprietaire_email, nom: d.proprietaire_nom },
      d.locataire_user_id ? { user_id: d.locataire_user_id, email: d.locataire_email, nom: d.locataire_nom } : null,
    ].filter(Boolean)) {
      await notifier({
        ...dest,
        titre: 'Fin de contrat validée',
        message: `Votre agent a validé la fin du contrat pour le bien ${bienLabel}.`,
        type: 'approbation',
      });
    }

    return res.json({ message: 'Fin de contrat validée avec succès' });
  } catch (err) {
    console.error('Erreur finalisation résiliation :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// L'agent renouvelle le contrat après accord entre le propriétaire et le locataire
async function renouvelerContrat(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const agent_id = req.user.id;
  const { duree_valeur, duree_unite } = req.body;

  if (!duree_valeur || !UNITES_INTERVAL[duree_unite]) {
    return res.status(400).json({ message: 'Précisez une durée de renouvellement valide (jours, semaines, mois ou annees)' });
  }

  try {
    const demande = await pool.query(
      `SELECT d.*, c.date_fin AS ancienne_date_fin, c.type_loyer, c.jour_echeance,
              c.jour_semaine_echeance, c.jour_echeance_annuel, c.mois_echeance_annuel, c.loyer_mensuel,
              b.numero_bien, b.proprietaire_id, p.nom AS proprietaire_nom, p.email AS proprietaire_email,
              l.nom AS locataire_nom, l.email AS locataire_email, l.user_id AS locataire_user_id
       FROM demandes_contrat d
       JOIN contrats c ON c.id = d.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN users p ON p.id = b.proprietaire_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE d.id = $1 ${estAdmin ? '' : 'AND d.agent_id = $2'} AND d.type_demande = 'fin_contrat' AND d.statut = 'en_attente'`,
      estAdmin ? [id] : [id, agent_id]
    );
    if (demande.rows.length === 0) {
      return res.status(404).json({ message: 'Demande non trouvée ou déjà traitée' });
    }
    const d = demande.rows[0];
    const dureeInt = parseInt(duree_valeur);

    const nouvelleFin = await pool.query(
      `SELECT ($1::date + ($2 || ' ' || $3)::interval)::date AS nouvelle_date_fin`,
      [d.ancienne_date_fin, dureeInt, UNITES_INTERVAL[duree_unite]]
    );
    const nouvelleDateFin = nouvelleFin.rows[0].nouvelle_date_fin;

    await pool.query(
      `UPDATE contrats SET date_fin = $1, duree_valeur = $2, duree_unite = $3, statut = 'actif' WHERE id = $4`,
      [nouvelleDateFin, dureeInt, duree_unite, d.contrat_id]
    );
    await pool.query("UPDATE demandes_contrat SET statut = 'approuvee' WHERE id = $1", [id]);

    // Génère les échéances de la nouvelle période, à la suite des échéances déjà existantes
    const contratMaj = await pool.query('SELECT * FROM contrats WHERE id = $1', [d.contrat_id]);
    const contrat = contratMaj.rows[0];
    const prochaine = ajouterPeriode(d.ancienne_date_fin, contrat.type_loyer || 'mensuel', 1);
    // Nombre de périodes standard du type de loyer (pas d'argument = repli interne sur
    // PERIODES_PAR_DEFAUT, le même que celui utilisé à la création du contrat et par le cron
    // de rattrapage) — générer 60 d'un coup ici sortait du lot sans raison, et amplifiait
    // l'impact du bug #9 (une modification de loyer approuvée ne touchant que les échéances
    // encore 'en_attente' aurait mis bien plus longtemps à s'appliquer partout).
    const nouvellesDates = genererDatesEcheances(contrat, prochaine);
    await Promise.all(
      nouvellesDates.map((de) =>
        pool.query(
          `INSERT INTO echeances (contrat_id, mois_concerne, montant_du, date_limite)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [contrat.id, de.mois_concerne, contrat.loyer_mensuel, de.date_limite]
        )
      )
    );

    const bienLabel = d.numero_bien;
    for (const dest of [
      { user_id: d.proprietaire_id, email: d.proprietaire_email, nom: d.proprietaire_nom },
      d.locataire_user_id ? { user_id: d.locataire_user_id, email: d.locataire_email, nom: d.locataire_nom } : null,
    ].filter(Boolean)) {
      await notifier({
        ...dest,
        titre: 'Contrat renouvelé',
        message: `Votre agent a renouvelé le contrat pour le bien ${bienLabel} jusqu'au ${nouvelleDateFin}.`,
        type: 'approbation',
      });
    }

    return res.json({ message: 'Contrat renouvelé avec succès', nouvelle_date_fin: nouvelleDateFin });
  } catch (err) {
    console.error('Erreur renouvellement contrat :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = {
  soumettreDemandeContrat, listerDemandes, approuverDemande, annulerDemande, soumettreDemandeResiliationLocataire,
  detecterFinsDeContrat, finaliserResiliationContrat, renouvelerContrat, escaladerDemandesBloquees,
};
