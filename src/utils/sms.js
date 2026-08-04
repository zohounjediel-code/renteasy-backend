const axios = require('axios');
const { obtenirCredentialOperateur, operateurEstActif } = require('./parametres');

// Africa's Talking : choix pragmatique pour un lancement au Bénin — API simple, largement
// utilisée par les plateformes ouest-africaines, pas de contrat opérateur individuel nécessaire
// contrairement au Mobile Money. Les identifiants sont gérables depuis la page Paramètres du
// super admin (opérateur "sms"), avec repli sur les variables d'environnement SMS_API_KEY /
// SMS_USERNAME / SMS_EXPEDITEUR tant que rien n'est configuré en base — donc rien ne casse pour
// un déploiement existant qui n'a pas encore touché à cette page (le SMS est simplement inactif
// par défaut, cf. operateurEstActif ci-dessous).
async function envoyerSMS({ telephone, message }) {
  const actif = await operateurEstActif('sms');
  if (!actif) {
    return { envoye: false, raison: 'sms_desactive' };
  }

  const [apiKey, username, expediteur] = await Promise.all([
    obtenirCredentialOperateur('sms', 'api_key', 'SMS_API_KEY'),
    obtenirCredentialOperateur('sms', 'username', 'SMS_USERNAME'),
    obtenirCredentialOperateur('sms', 'expediteur', 'SMS_EXPEDITEUR'),
  ]);

  if (!apiKey || !username) {
    console.error('SMS non envoyé (canal activé mais credentials manquants : api_key/username).');
    return { envoye: false, raison: 'credentials_manquants' };
  }

  try {
    const reponse = await axios.post(
      'https://api.africastalking.com/version1/messaging',
      new URLSearchParams({
        username,
        to: telephone,
        message,
        ...(expediteur ? { from: expediteur } : {}),
      }).toString(),
      {
        headers: {
          apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      }
    );
    return { envoye: true, details: reponse.data };
  } catch (err) {
    console.error('Erreur envoi SMS :', err.message);
    return { envoye: false, raison: 'erreur_api', erreur: err.message };
  }
}

module.exports = { envoyerSMS };
