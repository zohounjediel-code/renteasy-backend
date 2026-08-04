const pool = require('../config/database');
const { notifier, echapperHtml } = require('../utils/notifications');
const { resoudreCibleAction } = require('../utils/delegationAgent');
const { enregistrerActionAgent } = require('../utils/journalAgent');
const { resoudreProprietaireConsulte } = require('../utils/delegationAgent');

// Rechercher un utilisateur locataire existant par téléphone ou email
// (le locataire doit déjà avoir un compte sur la plateforme)
async function rechercherLocataire(req, res) {
  const { contact } = req.query;

  if (!contact) {
    return res.status(400).json({ message: 'Renseignez un numéro de téléphone ou un email' });
  }

  try {
    const resultat = await pool.query(
      `SELECT id, nom, email, telephone
       FROM users
       WHERE (telephone = $1 OR email = $1) AND role LIKE '%locataire%' AND actif = true`,
      [contact]
    );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: "Aucun compte locataire trouvé avec ce contact. La personne doit d'abord créer un compte locataire sur RentEasy." });
    }

    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur recherche locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Envoyer une demande de liaison à un locataire existant (statut "en_attente")
async function demanderLiaisonLocataire(req, res) {
  const { user_id, numero_piece_identite } = req.body;

  if (!user_id) {
    return res.status(400).json({ message: 'user_id du locataire requis' });
  }

  const cible = await resoudreCibleAction(req);
  if (!cible) {
    return res.status(403).json({ message: "Vous n'êtes pas autorisé à ajouter un locataire pour ce propriétaire" });
  }
  const { proprietaire_id, effectue_par_agent_id } = cible;

  try {
    const utilisateur = await pool.query(
      "SELECT id, nom, email, telephone FROM users WHERE id = $1 AND role LIKE '%locataire%'",
      [user_id]
    );

    if (utilisateur.rows.length === 0) {
      return res.status(404).json({ message: 'Ce compte locataire est introuvable' });
    }

    const u = utilisateur.rows[0];

    // Vérifie qu'il n'y a pas déjà une liaison active ou en attente entre ce propriétaire et ce locataire
    const existant = await pool.query(
      `SELECT id, statut FROM locataires WHERE proprietaire_id = $1 AND user_id = $2 AND statut IN ('en_attente', 'confirme')`,
      [proprietaire_id, user_id]
    );

    if (existant.rows.length > 0) {
      const statutExistant = existant.rows[0].statut;
      return res.status(409).json({
        message: statutExistant === 'en_attente'
          ? "Une demande d'ajout est déjà en attente pour ce locataire"
          : 'Ce locataire est déjà dans votre liste',
      });
    }

    const proprietaire = await pool.query('SELECT nom FROM users WHERE id = $1', [proprietaire_id]);
    const nomProprietaire = proprietaire.rows[0].nom;

    const resultat = await pool.query(
      `INSERT INTO locataires (nom, telephone, email, numero_piece_identite, proprietaire_id, user_id, statut, effectue_par_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'en_attente', $7)
       RETURNING *`,
      [u.nom, u.telephone, u.email, numero_piece_identite || null, proprietaire_id, user_id, effectue_par_agent_id]
    );

    await enregistrerActionAgent({
      agent_id: effectue_par_agent_id,
      proprietaire_id,
      type_action: 'ajout_locataire',
      description: `Envoi d'une demande d'ajout au locataire ${u.nom} (${u.telephone})`,
      reference_type: 'locataire',
      reference_id: resultat.rows[0].id,
    });

    // Notifie le locataire — c'est à lui d'accepter ou refuser
    await notifier({
      user_id: u.id,
      email: u.email,
      nom: u.nom,
      titre: "Demande d'ajout par un propriétaire",
      message: `${nomProprietaire} souhaite vous ajouter comme locataire. Rendez-vous sur votre espace pour accepter ou refuser.`,
      type: 'demande',
      lien: '/locataire/dashboard',
      sujet_email: '[RentEasy] Demande d\'ajout par un propriétaire',
      contenu_email: `
        <h2>Demande d'ajout</h2>
        <p>Bonjour ${echapperHtml(u.nom)},</p>
        <p><strong>${echapperHtml(nomProprietaire)}</strong> souhaite vous ajouter comme locataire sur RentEasy Bénin.</p>
        <p>Connectez-vous à votre espace locataire pour accepter ou refuser cette demande.</p>
      `,
    });

    return res.status(201).json({
      message: 'Demande envoyée. Le locataire doit accepter avant que la liaison soit confirmée.',
      locataire: resultat.rows[0],
    });
  } catch (err) {
    console.error('Erreur demande liaison locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Lister les locataires confirmés du propriétaire connecté (ou, pour un admin, du propriétaire
// ciblé via ?proprietaire_id=...)
async function listerLocataires(req, res) {
  const proprietaire_id = resoudreProprietaireConsulte(req);
  if (!proprietaire_id) {
    return res.status(400).json({ message: 'proprietaire_id requis pour une consultation admin' });
  }

  try {
    const resultat = await pool.query(
      `SELECT * FROM locataires WHERE proprietaire_id = $1 AND statut = 'confirme' ORDER BY created_at DESC`,
      [proprietaire_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste locataires :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la récupération des locataires' });
  }
}

// Lister les demandes de liaison en attente envoyées par le propriétaire connecté (ou, pour un
// admin, du propriétaire ciblé via ?proprietaire_id=...)
async function listerLiaisonsEnAttente(req, res) {
  const proprietaire_id = resoudreProprietaireConsulte(req);
  if (!proprietaire_id) {
    return res.status(400).json({ message: 'proprietaire_id requis pour une consultation admin' });
  }

  try {
    const resultat = await pool.query(
      `SELECT * FROM locataires WHERE proprietaire_id = $1 AND statut = 'en_attente' ORDER BY created_at DESC`,
      [proprietaire_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste liaisons en attente :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Annuler une demande de liaison en attente (côté propriétaire)
async function annulerLiaison(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');

  try {
    const resultat = estAdmin
      ? await pool.query(`DELETE FROM locataires WHERE id = $1 AND statut = 'en_attente' RETURNING id`, [id])
      : await pool.query(`DELETE FROM locataires WHERE id = $1 AND proprietaire_id = $2 AND statut = 'en_attente' RETURNING id`, [id, req.user.id]);

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Demande non trouvée ou déjà traitée' });
    }

    return res.json({ message: 'Demande annulée' });
  } catch (err) {
    console.error('Erreur annulation liaison :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Récupérer le détail d'un locataire (un admin peut consulter n'importe quel locataire)
async function obtenirLocataire(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');

  try {
    const resultat = estAdmin
      ? await pool.query('SELECT * FROM locataires WHERE id = $1', [id])
      : await pool.query('SELECT * FROM locataires WHERE id = $1 AND proprietaire_id = $2', [id, req.user.id]);

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Locataire non trouvé' });
    }

    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur détail locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Modifier le numéro de pièce d'identité d'un locataire (nom/email/téléphone viennent de son compte utilisateur)
async function modifierLocataire(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const { numero_piece_identite } = req.body;

  try {
    const resultat = estAdmin
      ? await pool.query(
          `UPDATE locataires SET numero_piece_identite = COALESCE($1, numero_piece_identite) WHERE id = $2 RETURNING *`,
          [numero_piece_identite, id]
        )
      : await pool.query(
          `UPDATE locataires SET numero_piece_identite = COALESCE($1, numero_piece_identite) WHERE id = $2 AND proprietaire_id = $3 RETURNING *`,
          [numero_piece_identite, id, req.user.id]
        );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Locataire non trouvé' });
    }

    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur modification locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la modification' });
  }
}

// Supprimer un locataire (uniquement s'il n'a aucun contrat actif, en attente de signature ou en demande)
async function supprimerLocataire(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');

  try {
    const verif = estAdmin
      ? await pool.query('SELECT id FROM locataires WHERE id = $1', [id])
      : await pool.query('SELECT id FROM locataires WHERE id = $1 AND proprietaire_id = $2', [id, req.user.id]);
    if (verif.rows.length === 0) {
      return res.status(404).json({ message: 'Locataire non trouvé' });
    }

    // Bloque la suppression dès qu'un contrat existe, quel que soit son statut — pas
    // seulement actif. contrats.locataire_id, echeances.contrat_id et paiements.echeance_id
    // sont en ON DELETE CASCADE (voir migrations) : supprimer un locataire ayant eu ne
    // serait-ce qu'un contrat résilié effacerait définitivement tout son historique
    // d'échéances et de paiements passés, sans que rien ne le signale.
    const contrats = await pool.query('SELECT id FROM contrats WHERE locataire_id = $1', [id]);
    if (contrats.rows.length > 0) {
      return res.status(409).json({
        message: "Impossible de supprimer ce locataire : un historique de contrat existe (actif ou passé). Le supprimer effacerait définitivement ses échéances et paiements.",
      });
    }

    await pool.query('DELETE FROM locataires WHERE id = $1', [id]);

    return res.json({ message: 'Locataire supprimé avec succès' });
  } catch (err) {
    console.error('Erreur suppression locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la suppression' });
  }
}

module.exports = {
  rechercherLocataire,
  demanderLiaisonLocataire,
  listerLocataires,
  listerLiaisonsEnAttente,
  annulerLiaison,
  obtenirLocataire,
  modifierLocataire,
  supprimerLocataire,
};
