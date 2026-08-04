const axios = require('axios');
const { randomUUID } = require('crypto');
const { obtenirCredentialOperateur } = require('./parametres');

// Documentation MTN MoMo API : https://momodeveloper.mtn.com
// On utilise le produit "Collection" pour recevoir des paiements des locataires
//
// Les identifiants sont désormais gérables depuis la page Paramètres du super admin (table
// parametres_operateurs) — obtenirCredentialOperateur retombe automatiquement sur la variable
// d'environnement correspondante tant qu'aucune valeur n'a été renseignée en base, donc rien ne
// casse pour un déploiement existant qui n'a pas encore touché à cette page.
async function obtenirConfigMTN() {
  const [baseUrl, subscriptionKey, targetEnv, apiUser, apiKey] = await Promise.all([
    obtenirCredentialOperateur('mtn', 'base_url', 'MTN_MOMO_BASE_URL'),
    obtenirCredentialOperateur('mtn', 'subscription_key', 'MTN_MOMO_SUBSCRIPTION_KEY'),
    obtenirCredentialOperateur('mtn', 'target_env', 'MTN_MOMO_TARGET_ENV'),
    obtenirCredentialOperateur('mtn', 'api_user', 'MTN_MOMO_API_USER'),
    obtenirCredentialOperateur('mtn', 'api_key', 'MTN_MOMO_API_KEY'),
  ]);
  return {
    baseUrl: baseUrl || 'https://sandbox.momodeveloper.mtn.com',
    subscriptionKey,
    targetEnv: targetEnv || 'sandbox',
    apiUser,
    apiKey,
  };
}

async function obtenirConfigDisbursementMTN() {
  const config = await obtenirConfigMTN();
  const [subscriptionKeyDisb, apiUserDisb, apiKeyDisb] = await Promise.all([
    obtenirCredentialOperateur('mtn', 'disbursement_subscription_key', 'MTN_MOMO_DISBURSEMENT_SUBSCRIPTION_KEY'),
    obtenirCredentialOperateur('mtn', 'disbursement_api_user', 'MTN_MOMO_DISBURSEMENT_API_USER'),
    obtenirCredentialOperateur('mtn', 'disbursement_api_key', 'MTN_MOMO_DISBURSEMENT_API_KEY'),
  ]);
  return {
    ...config,
    subscriptionKey: subscriptionKeyDisb || config.subscriptionKey,
    apiUser: apiUserDisb || config.apiUser,
    apiKey: apiKeyDisb || config.apiKey,
  };
}

// Étape 1 : Obtenir un token d'accès OAuth2
async function obtenirTokenMTN() {
  const { baseUrl, subscriptionKey, apiUser, apiKey } = await obtenirConfigMTN();
  const credentials = Buffer.from(`${apiUser}:${apiKey}`).toString('base64');

  const reponse = await axios.post(
    `${baseUrl}/collection/token/`,
    {},
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
      },
    }
  );

  return reponse.data.access_token;
}

// Étape 2 : Initier une demande de paiement (Request to Pay)
// Le locataire reçoit une notification sur son téléphone MTN MoMo et confirme le paiement
async function demanderPaiementMTN({ montant, telephone, referenceExterne, description }) {
  const { baseUrl, subscriptionKey, targetEnv } = await obtenirConfigMTN();
  const token = await obtenirTokenMTN();
  const referenceTransaction = referenceExterne || randomUUID();

  await axios.post(
    `${baseUrl}/collection/v1_0/requesttopay`,
    {
      amount: montant.toString(),
      currency: targetEnv === 'sandbox' ? 'EUR' : 'XOF', // Sandbox impose EUR, production = XOF (FCFA)
      externalId: referenceTransaction,
      payer: {
        partyIdType: 'MSISDN',
        partyId: telephone.replace(/\+/g, ''), // Supprimer le "+" du numéro
      },
      payerMessage: description || 'Paiement de loyer RentEasy',
      payeeNote: `Loyer - ${description}`,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Reference-Id': referenceTransaction,
        'X-Target-Environment': targetEnv,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
        'Content-Type': 'application/json',
      },
    }
  );

  return referenceTransaction; // On stocke cette référence pour vérifier le statut plus tard
}

// Étape 3 : Vérifier le statut d'un paiement MTN
async function verifierStatutMTN(referenceTransaction) {
  const { baseUrl, subscriptionKey, targetEnv } = await obtenirConfigMTN();
  const token = await obtenirTokenMTN();

  const reponse = await axios.get(
    `${baseUrl}/collection/v1_0/requesttopay/${referenceTransaction}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Target-Environment': targetEnv,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
      },
    }
  );

  // Statuts possibles : PENDING, SUCCESSFUL, FAILED
  return {
    statut: reponse.data.status,          // PENDING | SUCCESSFUL | FAILED
    reference: referenceTransaction,
    details: reponse.data,
  };
}

// ============================================================
// PRODUIT "DISBURSEMENT" — utilisé pour les RETRAITS (transfert d'argent VERS le téléphone du client)
// ============================================================

async function obtenirTokenTransfertMTN() {
  const { baseUrl, subscriptionKey, apiUser, apiKey } = await obtenirConfigDisbursementMTN();
  const credentials = Buffer.from(`${apiUser}:${apiKey}`).toString('base64');

  const reponse = await axios.post(
    `${baseUrl}/disbursement/token/`,
    {},
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
      },
    }
  );

  return reponse.data.access_token;
}

// Envoie de l'argent depuis le compte marchand RentEasy vers le téléphone du client (retrait de solde)
async function demanderTransfertMTN({ montant, telephone, referenceExterne, description }) {
  const { baseUrl, subscriptionKey, targetEnv } = await obtenirConfigDisbursementMTN();
  const token = await obtenirTokenTransfertMTN();
  const referenceTransaction = referenceExterne || randomUUID();

  await axios.post(
    `${baseUrl}/disbursement/v1_0/transfer`,
    {
      amount: montant.toString(),
      currency: targetEnv === 'sandbox' ? 'EUR' : 'XOF',
      externalId: referenceTransaction,
      payee: {
        partyIdType: 'MSISDN',
        partyId: telephone.replace(/\+/g, ''),
      },
      payerMessage: description || 'Retrait RentEasy',
      payeeNote: description || 'Retrait RentEasy',
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Reference-Id': referenceTransaction,
        'X-Target-Environment': targetEnv,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
        'Content-Type': 'application/json',
      },
    }
  );

  return referenceTransaction;
}

async function verifierStatutTransfertMTN(referenceTransaction) {
  const { baseUrl, subscriptionKey, targetEnv } = await obtenirConfigDisbursementMTN();
  const token = await obtenirTokenTransfertMTN();

  const reponse = await axios.get(
    `${baseUrl}/disbursement/v1_0/transfer/${referenceTransaction}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Target-Environment': targetEnv,
        'Ocp-Apim-Subscription-Key': subscriptionKey,
      },
    }
  );

  return {
    statut: reponse.data.status,
    reference: referenceTransaction,
    details: reponse.data,
  };
}

module.exports = { demanderPaiementMTN, verifierStatutMTN, demanderTransfertMTN, verifierStatutTransfertMTN };
