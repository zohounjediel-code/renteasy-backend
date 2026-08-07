const { envoyerEmail, echapperHtml } = require('../utils/notifications');

const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Message envoyé depuis la page publique /contact — sert de canal de support pour
// les demandes RGPD (accès/rectification/suppression) évoquées par les CGU, et pour
// tout visiteur sans compte encore créé.
async function envoyerMessageContact(req, res) {
  const { nom, email, sujet, message } = req.body;

  if (!nom || !email || !message) {
    return res.status(400).json({ message: 'Champs obligatoires manquants' });
  }
  if (!REGEX_EMAIL.test(email)) {
    return res.status(400).json({ message: 'Adresse email invalide' });
  }
  if (nom.length > 100 || (sujet && sujet.length > 150) || message.length > 3000) {
    return res.status(400).json({ message: 'Un des champs dépasse la longueur autorisée' });
  }

  const destinataire = process.env.SUPPORT_EMAIL || process.env.EMAIL_FROM || 'renteasy243@gmail.com';

  try {
    await envoyerEmail({
      destinataire_email: destinataire,
      destinataire_nom: 'Support RentEasy Bénin',
      sujet: `[Contact] ${sujet ? echapperHtml(sujet) : 'Nouveau message'}`,
      contenu_html: `
        <p><strong>De :</strong> ${echapperHtml(nom)} (${echapperHtml(email)})</p>
        <p><strong>Message :</strong></p>
        <p>${echapperHtml(message).replace(/\n/g, '<br>')}</p>
      `,
      reply_to: email,
    });

    res.json({ message: 'Votre message a bien été envoyé. Nous vous répondrons dans les meilleurs délais.' });
  } catch (err) {
    console.error('Erreur envoi message de contact :', err.message);
    res.status(500).json({ message: "Erreur lors de l'envoi du message" });
  }
}

module.exports = { envoyerMessageContact };
