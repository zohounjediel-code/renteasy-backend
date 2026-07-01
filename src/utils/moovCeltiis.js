const axios = require('axios');

// ============================================================
// MOOV MONEY BÉNIN
// À brancher dès réception de la documentation API officielle
// et des credentials partenaire de Moov Bénin
// ============================================================
async function demanderPaiementMoov({ montant, telephone, referenceExterne, description }) {
  const MOOV_BASE_URL = process.env.MOOV_BASE_URL;
  const MOOV_API_KEY = process.env.MOOV_API_KEY;
  const MOOV_API_SECRET = process.env.MOOV_API_SECRET;

  if (!MOOV_BASE_URL || !MOOV_API_KEY) {
    throw new Error('Credentials Moov Money non configurés. Contactez Moov Bénin pour obtenir vos clés API.');
  }

  // Structure générique REST — à adapter selon la doc officielle Moov Bénin
  const reponse = await axios.post(
    `${MOOV_BASE_URL}/payment/request`,
    {
      amount: montant,
      currency: 'XOF',
      phone: telephone,
      reference: referenceExterne,
      description: description || 'Paiement de loyer RentEasy',
    },
    {
      headers: {
        Authorization: `Bearer ${MOOV_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return reponse.data;
}

async function verifierStatutMoov(referenceTransaction) {
  const MOOV_BASE_URL = process.env.MOOV_BASE_URL;
  const MOOV_API_KEY = process.env.MOOV_API_KEY;

  if (!MOOV_BASE_URL || !MOOV_API_KEY) {
    throw new Error('Credentials Moov Money non configurés.');
  }

  const reponse = await axios.get(
    `${MOOV_BASE_URL}/payment/status/${referenceTransaction}`,
    {
      headers: { Authorization: `Bearer ${MOOV_API_KEY}` },
    }
  );

  return reponse.data;
}

// ============================================================
// CELTIIS PAY BÉNIN
// À brancher dès réception de la documentation API officielle
// et des credentials partenaire de Celtiis
// ============================================================
async function demanderPaiementCeltiis({ montant, telephone, referenceExterne, description }) {
  const CELTIIS_BASE_URL = process.env.CELTIIS_BASE_URL;
  const CELTIIS_API_KEY = process.env.CELTIIS_API_KEY;

  if (!CELTIIS_BASE_URL || !CELTIIS_API_KEY) {
    throw new Error('Credentials Celtiis Pay non configurés. Contactez Celtiis pour obtenir vos clés API.');
  }

  const reponse = await axios.post(
    `${CELTIIS_BASE_URL}/payment/request`,
    {
      amount: montant,
      currency: 'XOF',
      phone: telephone,
      reference: referenceExterne,
      description: description || 'Paiement de loyer RentEasy',
    },
    {
      headers: {
        Authorization: `Bearer ${CELTIIS_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return reponse.data;
}

async function verifierStatutCeltiis(referenceTransaction) {
  const CELTIIS_BASE_URL = process.env.CELTIIS_BASE_URL;
  const CELTIIS_API_KEY = process.env.CELTIIS_API_KEY;

  if (!CELTIIS_BASE_URL || !CELTIIS_API_KEY) {
    throw new Error('Credentials Celtiis Pay non configurés.');
  }

  const reponse = await axios.get(
    `${CELTIIS_BASE_URL}/payment/status/${referenceTransaction}`,
    {
      headers: { Authorization: `Bearer ${CELTIIS_API_KEY}` },
    }
  );

  return reponse.data;
}

module.exports = {
  demanderPaiementMoov,
  verifierStatutMoov,
  demanderPaiementCeltiis,
  verifierStatutCeltiis,
};
