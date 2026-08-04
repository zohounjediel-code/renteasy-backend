const pool = require('../config/database');

// Lister les notifications de l'utilisateur connecté
async function listerNotifications(req, res) {
  const user_id = req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [user_id]
    );

    // Compté séparément sur TOUTES les notifications, pas seulement parmi les 50 dernières
    // affichées ci-dessus — sinon le compteur sous-évaluait le nombre réel de non lues dès
    // qu'il y en avait plus que ça d'accumulées.
    const compteur = await pool.query(
      `SELECT COUNT(*) AS total FROM notifications WHERE user_id = $1 AND lue = false`,
      [user_id]
    );
    const nonLues = parseInt(compteur.rows[0].total, 10);

    return res.json({ notifications: resultat.rows, non_lues: nonLues });
  } catch (err) {
    console.error('Erreur liste notifications :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Marquer une notification comme lue
async function marquerLue(req, res) {
  const { id } = req.params;
  const user_id = req.user.id;

  try {
    await pool.query(
      'UPDATE notifications SET lue = true WHERE id = $1 AND user_id = $2',
      [id, user_id]
    );
    return res.json({ message: 'Notification marquée comme lue' });
  } catch (err) {
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Marquer toutes les notifications comme lues
async function marquerToutesLues(req, res) {
  const user_id = req.user.id;

  try {
    await pool.query('UPDATE notifications SET lue = true WHERE user_id = $1', [user_id]);
    return res.json({ message: 'Toutes les notifications marquées comme lues' });
  } catch (err) {
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = { listerNotifications, marquerLue, marquerToutesLues };
