const pool = require('../config/database');

const CONTEXTES_VALIDES = ['proprietaire', 'locataire'];

// Vérifie qu'un lien réel existe entre les deux comptes avant d'autoriser un message :
// agent <-> propriétaire qui lui est assigné, locataire <-> propriétaire du bien qu'il loue,
// locataire <-> agent de ce propriétaire, ou tout admin/super_admin (accès de supervision,
// comme partout ailleurs dans l'app). Sans ce contrôle, n'importe quel compte connecté
// pouvait écrire à n'importe quel destinataire_id, sans aucune relation entre les deux.
async function relationLegitime(idA, idB, rolesA) {
  if (idA === idB) return false;
  if (rolesA.includes('admin') || rolesA.includes('super_admin')) return true;

  const lienAgent = await pool.query(
    `SELECT 1 FROM users WHERE (id = $1 AND agent_id = $2) OR (id = $2 AND agent_id = $1) LIMIT 1`,
    [idA, idB]
  );
  if (lienAgent.rows.length > 0) return true;

  // Locataire <-> propriétaire du bien loué, ou locataire <-> agent de ce propriétaire
  const lienLocataire = await pool.query(
    `SELECT 1
     FROM locataires l
     JOIN contrats c ON c.locataire_id = l.id
     JOIN biens b ON b.id = c.bien_id
     JOIN users p ON p.id = b.proprietaire_id
     WHERE (l.user_id = $1 AND (p.id = $2 OR p.agent_id = $2))
        OR (l.user_id = $2 AND (p.id = $1 OR p.agent_id = $1))
     LIMIT 1`,
    [idA, idB]
  );
  return lienLocataire.rows.length > 0;
}

// Envoyer un message
async function envoyerMessage(req, res) {
  const expediteur_id = req.user.id;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const { destinataire_id, contenu, contexte } = req.body;
  const contexteFinal = CONTEXTES_VALIDES.includes(contexte) ? contexte : 'proprietaire';

  if (!destinataire_id || !contenu?.trim()) {
    return res.status(400).json({ message: 'Destinataire et contenu requis' });
  }

  try {
    const destinataireExiste = await pool.query('SELECT id FROM users WHERE id = $1', [destinataire_id]);
    if (destinataireExiste.rows.length === 0) {
      return res.status(404).json({ message: 'Destinataire introuvable' });
    }

    const autorise = await relationLegitime(expediteur_id, destinataire_id, roles);
    if (!autorise) {
      return res.status(403).json({
        message: "Vous ne pouvez écrire qu'aux personnes avec qui vous avez un lien sur RentEasy (votre agent, votre propriétaire, ou vos locataires)",
      });
    }

    const resultat = await pool.query(
      `INSERT INTO messages (expediteur_id, destinataire_id, contenu, contexte)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [expediteur_id, destinataire_id, contenu.trim(), contexteFinal]
    );
    return res.status(201).json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur envoi message :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Récupérer la conversation entre deux utilisateurs, dans un espace précis
// (propriétaire ou locataire) pour éviter que les deux espaces d'un même
// compte à double rôle ne partagent la même conversation avec un interlocuteur commun.
async function obtenirConversation(req, res) {
  const user_id = req.user.id;
  const { interlocuteur_id } = req.params;
  const contexte = CONTEXTES_VALIDES.includes(req.query.contexte) ? req.query.contexte : 'proprietaire';

  try {
    const messages = await pool.query(
      `SELECT m.*, 
              e.nom AS expediteur_nom, e.role AS expediteur_role
       FROM messages m
       JOIN users e ON e.id = m.expediteur_id
       WHERE ((m.expediteur_id = $1 AND m.destinataire_id = $2)
          OR (m.expediteur_id = $2 AND m.destinataire_id = $1))
          AND m.contexte = $3
       ORDER BY m.created_at ASC`,
      [user_id, interlocuteur_id, contexte]
    );

    // Marquer comme lus les messages reçus dans cet espace
    await pool.query(
      `UPDATE messages SET lu = true 
       WHERE destinataire_id = $1 AND expediteur_id = $2 AND contexte = $3 AND lu = false`,
      [user_id, interlocuteur_id, contexte]
    );

    return res.json(messages.rows);
  } catch (err) {
    console.error('Erreur conversation :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Nombre de messages non lus (tous espaces confondus)
async function messagesNonLus(req, res) {
  const user_id = req.user.id;
  try {
    const resultat = await pool.query(
      'SELECT COUNT(*) AS non_lus FROM messages WHERE destinataire_id = $1 AND lu = false',
      [user_id]
    );
    return res.json({ non_lus: parseInt(resultat.rows[0].non_lus) });
  } catch (err) {
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = { envoyerMessage, obtenirConversation, messagesNonLus };
