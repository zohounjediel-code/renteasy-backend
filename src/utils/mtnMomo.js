const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

// Documentation MTN MoMo API : https://momodeveloper.mtn.com
// On utilise le produit "Collection" pour recevoir des paiements des locataires

const MTN_BASE_URL = process.env.MTN_MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com';
const MTN_SUBSCRIPTION_KEY = process.env.MTN_MOMO_SUBSCRIPTION_KEY;
const MTN_TARGET_ENV = process.env.MTN_MOMO_TARGET_ENV || 'sandbox';

// Étape 1 : Obtenir un token d'accès OAuth2
async function obtenirTokenMTN() {
  const credentials = Buffer.from(
    `${process.env.MTN_MOMO_API_USER}:${process.env.MTN_MOMO_API_KEY}`
  ).toString('base64');

  const reponse = await axios.post(
    `${MTN_BASE_URL}/collection/token/`,
    {},
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Ocp-Apim-Subscription-Key': MTN_SUBSCRIPTION_KEY,
      },
    }
  );

  return reponse.data.access_token;
}

// Étape 2 : Initier une demande de paiement (Request to Pay)
// Le locataire reçoit une notification sur son téléphone MTN MoMo et confirme le paiement
async function demanderPaiementMTN({ montant, telephone, referenceExterne, description }) {
  const token = await obtenirTokenMTN();
  const referenceTransaction = referenceExterne || uuidv4();

  await axios.post(
    `${MTN_BASE_URL}/collection/v1_0/requesttopay`,
    {
      amount: montant.toString(),
      currency: MTN_TARGET_ENV === 'sandbox' ? 'EUR' : 'XOF', // Sandbox impose EUR, production = XOF (FCFA)
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
        'X-Target-Environment': MTN_TARGET_ENV,
        'Ocp-Apim-Subscription-Key': MTN_SUBSCRIPTION_KEY,
        'Content-Type': 'application/json',
      },
    }
  );

  return referenceTransaction; // On stocke cette référence pour vérifier le statut plus tard
}

// Étape 3 : Vérifier le statut d'un paiement MTN
async function verifierStatutMTN(referenceTransaction) {
  const token = await obtenirTokenMTN();

  const reponse = await axios.get(
    `${MTN_BASE_URL}/collection/v1_0/requesttopay/${referenceTransaction}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Target-Environment': MTN_TARGET_ENV,
        'Ocp-Apim-Subscription-Key': MTN_SUBSCRIPTION_KEY,
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

module.exports = { demanderPaiementMTN, verifierStatutMTN };
