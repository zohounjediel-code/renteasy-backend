const pool = require('../config/database');
const axios = require('axios');
const { envoyerSMS } = require('./sms');

// Échappe le texte libre saisi par un utilisateur (nom, note, adresse...) avant de l'insérer
// dans un email HTML — sans ça, un locataire ou un propriétaire pouvait injecter des balises
// ou des liens arbitraires dans un email "officiel" RentEasy envoyé à quelqu'un d'autre.
// À utiliser sur CHAQUE variable interpolée dans un contenu_email qui vient d'un champ libre
// (nom, note, adresse, ville...) — pas sur les montants, dates ou valeurs fixes (déjà sûrs).
function echapperHtml(texte) {
  if (texte === null || texte === undefined) return '';
  return String(texte)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Crée une notification in-app pour un utilisateur
async function creerNotification({ user_id, titre, message, type = 'info', lien = null }) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, titre, message, type, lien)
       VALUES ($1, $2, $3, $4, $5)`,
      [user_id, titre, message, type, lien]
    );
  } catch (err) {
    console.error('Erreur création notification :', err);
  }
}

// Envoie un email via Brevo (comme OJADA BANK)
async function envoyerEmail({ destinataire_email, destinataire_nom, sujet, contenu_html }) {
  if (!process.env.BREVO_API_KEY) {
    console.log('BREVO_API_KEY non configurée, email non envoyé');
    return;
  }

  try {
    await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: { name: 'RentEasy Bénin', email: process.env.EMAIL_FROM || 'noreply@renteasy.bj' },
        to: [{ email: destinataire_email, name: destinataire_nom }],
        subject: sujet,
        htmlContent: contenu_html,
      },
      {
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    console.error('Erreur envoi email :', err.response?.data || err.message);
  }
}

// Notification complète : in-app + email + SMS (SMS optionnel, seulement si telephone ET un
// message court sms sont fournis par l'appelant — pas de SMS automatique pour tout, seulement
// pour les moments jugés assez importants pour justifier le coût et l'intrusion d'un SMS).
async function notifier({ user_id, email, nom, telephone, sms, titre, message, type, lien, sujet_email, contenu_email }) {
  // notifications.user_id est NOT NULL en base : pas de compte (locataire connu seulement par
  // son email) = rien à créer côté in-app, sinon chaque appel déclenchait une violation de
  // contrainte avalée silencieusement, pour rien, à chaque demande le concernant.
  if (user_id) {
    await creerNotification({ user_id, titre, message, type, lien });
  }

  if (email) {
    await envoyerEmail({
      destinataire_email: email,
      destinataire_nom: nom,
      sujet: sujet_email || titre,
      // Repli utilisé quand l'appelant ne construit pas son propre contenu_email : message
      // peut contenir du texte utilisateur (ex: un nom), donc on l'échappe aussi ici.
      contenu_html: contenu_email || `<p>${echapperHtml(message)}</p>`,
    });
  }

  // Un échec d'envoi SMS (canal désactivé, credentials manquants, opérateur en panne) ne doit
  // jamais faire échouer le reste de la notification (email/in-app déjà envoyés) — d'où le
  // try/catch dédié, sur le modèle de la résilience déjà appliquée à creerNotification.
  if (telephone && sms) {
    try {
      await envoyerSMS({ telephone, message: sms });
    } catch (err) {
      console.error('Erreur envoi SMS (notifier) :', err.message);
    }
  }
}

module.exports = { creerNotification, envoyerEmail, notifier, echapperHtml };
