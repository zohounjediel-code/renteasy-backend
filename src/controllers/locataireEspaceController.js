const pool = require('../config/database');
const { notifier, echapperHtml } = require('../utils/notifications');
const { creerEcheancesPourContrat } = require('../utils/echeances');

// Dashboard locataire - ses échéances et infos contrat
async function dashboardLocataire(req, res) {
  const user_id = req.user.id;

  try {
    // Trouver le(s) locataire(s) liés à ce compte
    const locataires = await pool.query(
      'SELECT * FROM locataires WHERE user_id = $1',
      [user_id]
    );

    if (locataires.rows.length === 0) {
      return res.json({ contrats: [], echeances: [], message: 'Aucun contrat trouvé' });
    }

    const locataireIds = locataires.rows.map(l => l.id);

    // Récupérer les contrats actifs
    const contrats = await pool.query(
      `SELECT c.*, b.adresse, b.ville, b.quartier, b.type_bien,
              p.nom AS proprietaire_nom, p.telephone AS proprietaire_telephone
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN users p ON p.id = b.proprietaire_id
       WHERE c.locataire_id = ANY($1) AND c.statut = 'actif'`,
      [locataireIds]
    );

    // Les échéances restent visibles même après résiliation/expiration du contrat (le
    // filtre sur les contrats affichés en cartes, juste au-dessus, reste volontairement
    // limité à 'actif' — un contrat résilié n'a plus sa place parmi les baux en cours).
    // Sans ce paramètre plus large ici, un locataire dont le bail se termine perdait toute
    // visibilité sur ce qu'il devait encore payer, alors même que le recouvrement continue
    // de son côté.
    const echeances = await pool.query(
      `SELECT e.*, b.adresse,
              COALESCE((SELECT SUM(p.montant) FROM paiements p WHERE p.echeance_id = e.id AND p.statut = 'reussi'), 0) AS montant_paye,
              e.montant_du - COALESCE((SELECT SUM(p.montant) FROM paiements p WHERE p.echeance_id = e.id AND p.statut = 'reussi'), 0) AS montant_restant
       FROM echeances e
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       WHERE c.locataire_id = ANY($1) AND c.statut IN ('actif', 'resilie', 'expire')
       ORDER BY e.mois_concerne ASC`,
      [locataireIds]
    );

    // Stats rapides globales (toutes échéances confondues, pour un éventuel résumé général)
    // "en_recouvrement" (agent en cours de démarche terrain) est traité comme impayée ici :
    // aucun argent n'a réellement été reçu tant que ce n'est pas passé par un vrai paiement.
    const total = echeances.rows.length;
    const payees = echeances.rows.filter(e => e.statut === 'payee').length;
    const enAttente = echeances.rows.filter(e => e.statut === 'en_attente').length;
    const impayees = echeances.rows.filter(e => e.statut === 'impayee' || e.statut === 'en_recouvrement').length;

    // Stats par contrat : chaque contrat doit afficher SES propres chiffres, pas la somme de tous les contrats
    const statsParContrat = {};
    for (const e of echeances.rows) {
      if (!statsParContrat[e.contrat_id]) {
        statsParContrat[e.contrat_id] = { total: 0, payees: 0, enAttente: 0, impayees: 0 };
      }
      const s = statsParContrat[e.contrat_id];
      s.total += 1;
      if (e.statut === 'payee') s.payees += 1;
      else if (e.statut === 'en_attente') s.enAttente += 1;
      else if (e.statut === 'impayee' || e.statut === 'en_recouvrement') s.impayees += 1;
    }
    const contratsAvecStats = contrats.rows.map(c => ({
      ...c,
      stats: statsParContrat[c.id] || { total: 0, payees: 0, enAttente: 0, impayees: 0 },
    }));

    return res.json({
      locataires: locataires.rows,
      contrats: contratsAvecStats,
      echeances: echeances.rows,
      stats: { total, payees, enAttente, impayees },
    });
  } catch (err) {
    console.error('Erreur dashboard locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Historique des paiements du locataire
async function paiementsLocataire(req, res) {
  const user_id = req.user.id;

  try {
    const locataires = await pool.query('SELECT id FROM locataires WHERE user_id = $1', [user_id]);
    if (locataires.rows.length === 0) return res.json([]);

    const locataireIds = locataires.rows.map(l => l.id);

    const paiements = await pool.query(
      `SELECT p.*, e.mois_concerne, b.adresse
       FROM paiements p
       JOIN echeances e ON e.id = p.echeance_id
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       WHERE c.locataire_id = ANY($1) AND p.statut = 'reussi'
       ORDER BY p.date_paiement DESC`,
      [locataireIds]
    );

    return res.json(paiements.rows);
  } catch (err) {
    console.error('Erreur paiements locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Télécharger une quittance (locataire)
async function quittanceLocataire(req, res) {
  const { id } = req.params;
  const user_id = req.user.id;
  const path = require('path');
  const fs = require('fs');

  try {
    // Vérifier que ce paiement appartient bien au locataire
    const locataires = await pool.query('SELECT id FROM locataires WHERE user_id = $1', [user_id]);
    const locataireIds = locataires.rows.map(l => l.id);

    const paiement = await pool.query(
      `SELECT p.quittance_url FROM paiements p
       JOIN echeances e ON e.id = p.echeance_id
       JOIN contrats c ON c.id = e.contrat_id
       WHERE p.id = $1 AND c.locataire_id = ANY($2)`,
      [id, locataireIds]
    );

    if (paiement.rows.length === 0 || !paiement.rows[0].quittance_url) {
      return res.status(404).json({ message: 'Quittance non trouvée' });
    }

    const cheminComplet = path.join(__dirname, '..', '..', paiement.rows[0].quittance_url);
    if (!fs.existsSync(cheminComplet)) {
      return res.status(404).json({ message: 'Fichier introuvable' });
    }

    return res.download(cheminComplet);
  } catch (err) {
    console.error('Erreur quittance locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Lister les demandes de liaison en attente reçues par le locataire connecté
async function listerLiaisonsEnAttenteLocataire(req, res) {
  const user_id = req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT l.id, l.created_at, p.id AS proprietaire_id, p.nom AS proprietaire_nom,
              p.telephone AS proprietaire_telephone, p.ville AS proprietaire_ville
       FROM locataires l
       JOIN users p ON p.id = l.proprietaire_id
       WHERE l.user_id = $1 AND l.statut = 'en_attente'
       ORDER BY l.created_at DESC`,
      [user_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste liaisons en attente locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Le locataire accepte la demande d'ajout d'un propriétaire
async function accepterLiaison(req, res) {
  const { id } = req.params;
  const user_id = req.user.id;

  try {
    const liaison = await pool.query(
      `SELECT l.*, p.nom AS proprietaire_nom, p.email AS proprietaire_email
       FROM locataires l
       JOIN users p ON p.id = l.proprietaire_id
       WHERE l.id = $1 AND l.user_id = $2 AND l.statut = 'en_attente'`,
      [id, user_id]
    );

    if (liaison.rows.length === 0) {
      return res.status(404).json({ message: 'Demande non trouvée ou déjà traitée' });
    }

    const l = liaison.rows[0];

    await pool.query("UPDATE locataires SET statut = 'confirme' WHERE id = $1", [id]);

    await notifier({
      user_id: l.proprietaire_id,
      email: l.proprietaire_email,
      nom: l.proprietaire_nom,
      titre: 'Demande acceptée',
      message: `${req.user.nom} a accepté votre demande d'ajout. Vous pouvez maintenant créer un contrat.`,
      type: 'approbation',
      sujet_email: '[RentEasy] Votre demande a été acceptée',
      contenu_email: `
        <h2>Demande acceptée</h2>
        <p>Bonjour ${echapperHtml(l.proprietaire_nom)},</p>
        <p><strong>${echapperHtml(req.user.nom)}</strong> a accepté votre demande d'ajout comme locataire.</p>
        <p>Vous pouvez maintenant lui associer un contrat de location.</p>
      `,
    });

    return res.json({ message: 'Demande acceptée avec succès' });
  } catch (err) {
    console.error('Erreur acceptation liaison :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Le locataire refuse la demande d'ajout d'un propriétaire
async function refuserLiaison(req, res) {
  const { id } = req.params;
  const user_id = req.user.id;

  try {
    const liaison = await pool.query(
      `SELECT l.*, p.nom AS proprietaire_nom, p.email AS proprietaire_email
       FROM locataires l
       JOIN users p ON p.id = l.proprietaire_id
       WHERE l.id = $1 AND l.user_id = $2 AND l.statut = 'en_attente'`,
      [id, user_id]
    );

    if (liaison.rows.length === 0) {
      return res.status(404).json({ message: 'Demande non trouvée ou déjà traitée' });
    }

    const l = liaison.rows[0];

    await pool.query("UPDATE locataires SET statut = 'refuse' WHERE id = $1", [id]);

    await notifier({
      user_id: l.proprietaire_id,
      email: l.proprietaire_email,
      nom: l.proprietaire_nom,
      titre: 'Demande refusée',
      message: `${req.user.nom} a refusé votre demande d'ajout.`,
      type: 'annulation',
      sujet_email: '[RentEasy] Votre demande a été refusée',
      contenu_email: `
        <h2>Demande refusée</h2>
        <p>Bonjour ${echapperHtml(l.proprietaire_nom)},</p>
        <p><strong>${echapperHtml(req.user.nom)}</strong> a refusé votre demande d'ajout comme locataire.</p>
      `,
    });

    return res.json({ message: 'Demande refusée' });
  } catch (err) {
    console.error('Erreur refus liaison :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Lister les contrats en attente de signature du locataire connecté
async function listerContratsEnAttenteSignature(req, res) {
  const user_id = req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT c.*, b.numero_bien, b.adresse, b.ville, b.quartier, b.type_bien,
              p.nom AS proprietaire_nom, p.telephone AS proprietaire_telephone
       FROM contrats c
       JOIN locataires l ON l.id = c.locataire_id
       JOIN biens b ON b.id = c.bien_id
       JOIN users p ON p.id = b.proprietaire_id
       WHERE l.user_id = $1 AND c.statut = 'en_attente_signature'
       ORDER BY c.created_at DESC`,
      [user_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste contrats en attente :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Le locataire signe le contrat à son tour : le contrat devient officiellement actif
async function signerContrat(req, res) {
  const { id } = req.params;
  const user_id = req.user.id;
  const { signature_locataire } = req.body;

  if (!signature_locataire || !signature_locataire.trim()) {
    return res.status(400).json({ message: 'Vous devez signer électroniquement le contrat (saisissez votre nom complet)' });
  }

  try {
    const contrat = await pool.query(
      `SELECT c.*, b.numero_bien, b.proprietaire_id, p.nom AS proprietaire_nom, p.email AS proprietaire_email
       FROM contrats c
       JOIN locataires l ON l.id = c.locataire_id
       JOIN biens b ON b.id = c.bien_id
       JOIN users p ON p.id = b.proprietaire_id
       WHERE c.id = $1 AND l.user_id = $2 AND c.statut = 'en_attente_signature'`,
      [id, user_id]
    );

    if (contrat.rows.length === 0) {
      return res.status(404).json({ message: 'Contrat non trouvé ou déjà traité' });
    }

    const c = contrat.rows[0];

    // La signature vaut finalisation : si une caution est due, elle doit être réglée dans le
    // même geste (débitée du solde du locataire) — sinon le contrat n'est pas activé du tout.
    // Tout se fait dans une seule transaction : activation du contrat, paiement de la caution,
    // génération des échéances, occupation du bien — tout réussit ensemble ou rien ne change.
    const client = await pool.connect();
    let contratMisAJour;
    try {
      await client.query('BEGIN');

      if (c.caution > 0) {
        const userRes = await client.query('SELECT solde FROM users WHERE id = $1 FOR UPDATE', [user_id]);
        const solde = userRes.rows[0].solde;

        if (solde < c.caution) {
          await client.query('ROLLBACK');
          client.release();
          return res.status(400).json({
            message: `Solde insuffisant pour la caution de ce contrat (${c.caution.toLocaleString('fr-FR')} FCFA requis, solde disponible : ${solde.toLocaleString('fr-FR')} FCFA). Rechargez votre solde puis signez à nouveau.`,
          });
        }

        await client.query('UPDATE users SET solde = solde - $1 WHERE id = $2', [c.caution, user_id]);
        await client.query(
          `INSERT INTO caution_mouvements (contrat_id, type, montant) VALUES ($1, 'paiement', $2)`,
          [id, c.caution]
        );
      }

      const contratRes = await client.query(
        `UPDATE contrats
         SET statut = 'actif', signature_locataire = $1, date_signature_locataire = NOW(),
             caution_solde = $3, statut_caution = CASE WHEN $3 > 0 THEN 'payee' ELSE statut_caution END
         WHERE id = $2 RETURNING *`,
        [signature_locataire.trim(), id, c.caution]
      );
      contratMisAJour = contratRes.rows[0];

      // Le contrat est officiellement validé : génère les échéances
      await creerEcheancesPourContrat(client, contratMisAJour);

      // N'occupe le bien immédiatement que si la période a déjà commencé.
      // Sinon (réservation future), le bien reste libre jusqu'à la date de début —
      // c'est la tâche quotidienne qui basculera son statut le moment venu.
      const dateDebut = new Date(c.date_debut);
      const aujourdHui = new Date();
      aujourdHui.setHours(0, 0, 0, 0);
      if (dateDebut <= aujourdHui) {
        await client.query(
          "UPDATE biens SET statut = 'occupe', sur_le_marche = false, description_marche = NULL, updated_at = NOW() WHERE id = $1",
          [c.bien_id]
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await notifier({
      user_id: c.proprietaire_id,
      email: c.proprietaire_email,
      nom: c.proprietaire_nom,
      titre: 'Contrat validé',
      message: `${req.user.nom} a signé le contrat du bien ${c.numero_bien}. Le contrat est maintenant actif et les échéances ont été générées.`,
      type: 'approbation',
      lien: '/locataires',
      sujet_email: '[RentEasy] Votre contrat a été validé',
      contenu_email: `
        <h2>Contrat validé</h2>
        <p>Bonjour ${echapperHtml(c.proprietaire_nom)},</p>
        <p><strong>${echapperHtml(req.user.nom)}</strong> a signé le contrat pour le bien <strong>${c.numero_bien}</strong>.</p>
        <p>Le contrat est désormais officiellement actif et les échéances de paiement ont été générées.</p>
      `,
    });

    return res.json({ message: 'Contrat signé avec succès. Il est maintenant officiellement actif.', contrat: contratMisAJour });
  } catch (err) {
    console.error('Erreur signature contrat :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Le locataire refuse le contrat proposé
async function refuserContrat(req, res) {
  const { id } = req.params;
  const user_id = req.user.id;

  try {
    const contrat = await pool.query(
      `SELECT c.*, b.numero_bien, b.proprietaire_id, p.nom AS proprietaire_nom, p.email AS proprietaire_email
       FROM contrats c
       JOIN locataires l ON l.id = c.locataire_id
       JOIN biens b ON b.id = c.bien_id
       JOIN users p ON p.id = b.proprietaire_id
       WHERE c.id = $1 AND l.user_id = $2 AND c.statut = 'en_attente_signature'`,
      [id, user_id]
    );

    if (contrat.rows.length === 0) {
      return res.status(404).json({ message: 'Contrat non trouvé ou déjà traité' });
    }

    const c = contrat.rows[0];

    await pool.query("UPDATE contrats SET statut = 'refuse' WHERE id = $1", [id]);

    await notifier({
      user_id: c.proprietaire_id,
      email: c.proprietaire_email,
      nom: c.proprietaire_nom,
      titre: 'Contrat refusé',
      message: `${req.user.nom} a refusé le contrat proposé pour le bien ${c.numero_bien}.`,
      type: 'annulation',
      lien: '/locataires',
      sujet_email: '[RentEasy] Contrat refusé par le locataire',
      contenu_email: `
        <h2>Contrat refusé</h2>
        <p>Bonjour ${echapperHtml(c.proprietaire_nom)},</p>
        <p><strong>${echapperHtml(req.user.nom)}</strong> a refusé de signer le contrat proposé pour le bien <strong>${c.numero_bien}</strong>.</p>
      `,
    });

    return res.json({ message: 'Contrat refusé' });
  } catch (err) {
    console.error('Erreur refus contrat :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Détail complet d'un contrat (pour le locataire, avant ou après signature)
async function obtenirContratLocataire(req, res) {
  const { id } = req.params;
  const user_id = req.user.id;

  try {
    const contrat = await pool.query(
      `SELECT c.*, b.numero_bien, b.adresse, b.ville, b.quartier, b.type_bien, b.lieu_depot, b.photos,
              p.nom AS proprietaire_nom, p.telephone AS proprietaire_telephone, p.email AS proprietaire_email
       FROM contrats c
       JOIN locataires l ON l.id = c.locataire_id
       JOIN biens b ON b.id = c.bien_id
       JOIN users p ON p.id = b.proprietaire_id
       WHERE c.id = $1 AND l.user_id = $2`,
      [id, user_id]
    );

    if (contrat.rows.length === 0) {
      return res.status(404).json({ message: 'Contrat non trouvé' });
    }

    const echeances = await pool.query(
      `SELECT e.*,
              COALESCE((SELECT SUM(p.montant) FROM paiements p WHERE p.echeance_id = e.id AND p.statut = 'reussi'), 0) AS montant_paye,
              e.montant_du - COALESCE((SELECT SUM(p.montant) FROM paiements p WHERE p.echeance_id = e.id AND p.statut = 'reussi'), 0) AS montant_restant
       FROM echeances e WHERE e.contrat_id = $1 ORDER BY e.mois_concerne ASC`,
      [id]
    );

    return res.json({ ...contrat.rows[0], echeances: echeances.rows });
  } catch (err) {
    console.error('Erreur détail contrat locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Infos de l'agent responsable (agent assigné au propriétaire) pour un contrat du locataire connecté
async function obtenirAgentDuContrat(req, res) {
  const { id } = req.params;
  const user_id = req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT a.id, a.nom, a.email, a.telephone, a.ville
       FROM contrats c
       JOIN locataires l ON l.id = c.locataire_id
       JOIN biens b ON b.id = c.bien_id
       JOIN users p ON p.id = b.proprietaire_id
       JOIN users a ON a.id = p.agent_id
       WHERE c.id = $1 AND l.user_id = $2`,
      [id, user_id]
    );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Aucun agent assigné trouvé pour ce contrat' });
    }

    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur agent du contrat :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = {
  dashboardLocataire,
  paiementsLocataire,
  quittanceLocataire,
  listerLiaisonsEnAttenteLocataire,
  accepterLiaison,
  refuserLiaison,
  listerContratsEnAttenteSignature,
  signerContrat,
  refuserContrat,
  obtenirContratLocataire,
  obtenirAgentDuContrat,
};
