const pool = require('../config/database');
const { notifier } = require('./notifications');

// Anti-spam en mémoire : une même erreur (route + début du message) ne redéclenche pas d'alerte
// email plus d'une fois toutes les 30 minutes — sans ça, une panne systémique (ex : base de
// données injoignable) enverrait des centaines d'emails d'alerte en quelques minutes, noyant
// l'information utile. En mémoire (pas en base) volontairement : un redémarrage du serveur
// réinitialise le compteur, ce qui est le comportement souhaité (un nouveau déploiement mérite
// une alerte fraîche si le problème persiste).
const DUREE_ANTI_SPAM_MS = 30 * 60 * 1000;
const dernieresAlertes = new Map();

function cleSignature(route, message) {
  return `${route || '?'}::${(message || '').slice(0, 200)}`;
}

async function alerterSuperAdmin({ message, route, statutHttp }) {
  const cle = cleSignature(route, message);
  const derniere = dernieresAlertes.get(cle);
  if (derniere && Date.now() - derniere < DUREE_ANTI_SPAM_MS) return;
  dernieresAlertes.set(cle, Date.now());

  const superAdmins = await pool.query("SELECT id, nom, email FROM users WHERE role LIKE '%super_admin%'");
  for (const sa of superAdmins.rows) {
    await notifier({
      user_id: sa.id,
      email: sa.email,
      nom: sa.nom,
      titre: 'Erreur serveur RentEasy',
      message: `Une erreur serveur est survenue${route ? ` sur ${route}` : ''} (HTTP ${statutHttp || 500}) : ${message}`,
      type: 'erreur_serveur',
      lien: '/superadmin/erreurs',
      sujet_email: `[RentEasy] Erreur serveur${route ? ` — ${route}` : ''}`,
      contenu_email: `
        <h2>Erreur serveur</h2>
        <p><strong>${statutHttp || 500}</strong>${route ? ` — ${route}` : ''}</p>
        <pre style="background:#f5f5f5;padding:12px;border-radius:6px;white-space:pre-wrap;">${message}</pre>
        <p>Détail complet (avec la pile d'appel) dans la page Erreurs du super admin.</p>
      `,
    });
  }
}

// Point d'entrée central : à appeler partout où une erreur "sérieuse" doit rester visible
// au-delà des logs console. Ne lève jamais elle-même — un problème dans l'enregistrement de
// l'erreur (base injoignable, email en échec...) ne doit jamais faire planter le code appelant,
// ni masquer l'erreur d'origine.
async function enregistrerErreur({ erreur, req, statutHttp }) {
  const message = erreur?.message || String(erreur);
  const stack = erreur?.stack || null;
  const route = req ? `${req.method} ${req.originalUrl}` : null;
  const userId = req?.user?.id || null;

  console.error(stack || message);

  try {
    await pool.query(
      `INSERT INTO erreurs_serveur (message, stack, methode, route, statut_http, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [message, stack, req?.method || null, route, statutHttp || null, userId]
    );
  } catch (errDB) {
    console.error('Impossible d\'enregistrer l\'erreur en base :', errDB.message);
  }

  try {
    await alerterSuperAdmin({ message, route, statutHttp });
  } catch (errAlerte) {
    console.error('Impossible d\'alerter le super admin par email :', errAlerte.message);
  }
}

module.exports = { enregistrerErreur };
