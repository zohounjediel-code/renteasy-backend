const axios = require('axios');
const { obtenirCredentialOperateur } = require('./parametres');

// ============================================================
// MOOV MONEY BÉNIN
// À brancher dès réception de la documentation API officielle
// et des credentials partenaire de Moov Bénin
//
// Les identifiants sont désormais gérables depuis la page Paramètres du super admin (table
// parametres_operateurs) — obtenirCredentialOperateur retombe automatiquement sur la variable
// d'environnement correspondante tant qu'aucune valeur n'a été renseignée en base.
// ============================================================
async function obtenirConfigMoov() {
  const [baseUrl, apiKey] = await Promise.all([
    obtenirCredentialOperateur('moov', 'base_url', 'MOOV_BASE_URL'),
    obtenirCredentialOperateur('moov', 'api_key', 'MOOV_API_KEY'),
  ]);
  return { baseUrl, apiKey };
}

async function demanderPaiementMoov({ montant, telephone, referenceExterne, description }) {
  const { baseUrl, apiKey } = await obtenirConfigMoov();

  if (!baseUrl || !apiKey) {
    throw new Error('Credentials Moov Money non configurés. Contactez Moov Bénin pour obtenir vos clés API.');
  }

  // Structure générique REST — à adapter selon la doc officielle Moov Bénin
  const reponse = await axios.post(
    `${baseUrl}/payment/request`,
    {
      amount: montant,
      currency: 'XOF',
      phone: telephone,
      reference: referenceExterne,
      description: description || 'Paiement de loyer RentEasy',
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return reponse.data;
}

async function verifierStatutMoov(referenceTransaction) {
  const { baseUrl, apiKey } = await obtenirConfigMoov();

  if (!baseUrl || !apiKey) {
    throw new Error('Credentials Moov Money non configurés.');
  }

  const reponse = await axios.get(
    `${baseUrl}/payment/status/${referenceTransaction}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  );

  return reponse.data;
}

// Transfert d'argent vers le client (retrait de solde)
async function demanderTransfertMoov({ montant, telephone, referenceExterne, description }) {
  const { baseUrl, apiKey } = await obtenirConfigMoov();

  if (!baseUrl || !apiKey) {
    throw new Error('Credentials Moov Money non configurés. Contactez Moov Bénin pour obtenir vos clés API.');
  }

  const reponse = await axios.post(
    `${baseUrl}/transfer/request`,
    {
      amount: montant,
      currency: 'XOF',
      phone: telephone,
      reference: referenceExterne,
      description: description || 'Retrait RentEasy',
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return reponse.data;
}

async function verifierStatutTransfertMoov(referenceTransaction) {
  const { baseUrl, apiKey } = await obtenirConfigMoov();

  if (!baseUrl || !apiKey) {
    throw new Error('Credentials Moov Money non configurés.');
  }

  const reponse = await axios.get(
    `${baseUrl}/transfer/status/${referenceTransaction}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  );

  return reponse.data;
}

// ============================================================
// CELTIIS PAY BÉNIN
// À brancher dès réception de la documentation API officielle
// et des credentials partenaire de Celtiis
// ============================================================
async function obtenirConfigCeltiis() {
  const [baseUrl, apiKey] = await Promise.all([
    obtenirCredentialOperateur('celtiis', 'base_url', 'CELTIIS_BASE_URL'),
    obtenirCredentialOperateur('celtiis', 'api_key', 'CELTIIS_API_KEY'),
  ]);
  return { baseUrl, apiKey };
}

async function demanderPaiementCeltiis({ montant, telephone, referenceExterne, description }) {
  const { baseUrl, apiKey } = await obtenirConfigCeltiis();

  if (!baseUrl || !apiKey) {
    throw new Error('Credentials Celtiis Pay non configurés. Contactez Celtiis pour obtenir vos clés API.');
  }

  const reponse = await axios.post(
    `${baseUrl}/payment/request`,
    {
      amount: montant,
      currency: 'XOF',
      phone: telephone,
      reference: referenceExterne,
      description: description || 'Paiement de loyer RentEasy',
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return reponse.data;
}

async function verifierStatutCeltiis(referenceTransaction) {
  const { baseUrl, apiKey } = await obtenirConfigCeltiis();

  if (!baseUrl || !apiKey) {
    throw new Error('Credentials Celtiis Pay non configurés.');
  }

  const reponse = await axios.get(
    `${baseUrl}/payment/status/${referenceTransaction}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  );

  return reponse.data;
}

// Transfert d'argent vers le client (retrait de solde)
async function demanderTransfertCeltiis({ montant, telephone, referenceExterne, description }) {
  const { baseUrl, apiKey } = await obtenirConfigCeltiis();

  if (!baseUrl || !apiKey) {
    throw new Error('Credentials Celtiis Pay non configurés. Contactez Celtiis pour obtenir vos clés API.');
  }

  const reponse = await axios.post(
    `${baseUrl}/transfer/request`,
    {
      amount: montant,
      currency: 'XOF',
      phone: telephone,
      reference: referenceExterne,
      description: description || 'Retrait RentEasy',
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return reponse.data;
}

async function verifierStatutTransfertCeltiis(referenceTransaction) {
  const { baseUrl, apiKey } = await obtenirConfigCeltiis();

  if (!baseUrl || !apiKey) {
    throw new Error('Credentials Celtiis Pay non configurés.');
  }

  const reponse = await axios.get(
    `${baseUrl}/transfer/status/${referenceTransaction}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  );

  return reponse.data;
}

module.exports = {
  demanderPaiementMoov,
  verifierStatutMoov,
  demanderTransfertMoov,
  verifierStatutTransfertMoov,
  demanderPaiementCeltiis,
  verifierStatutCeltiis,
  demanderTransfertCeltiis,
  verifierStatutTransfertCeltiis,
};
