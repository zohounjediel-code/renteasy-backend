const pool = require('../config/database');
const { notifier, echapperHtml } = require('./notifications');
const { enregistrerErreur } = require('./erreurs');

// Calendrier des rappels : combien de jours avant (positif) ou après (négatif) la date limite
// de l'échéance chaque type de rappel se déclenche.
const JOURS_AVANT_ECHEANCE = 3;
const JOURS_RETARD_PREMIER_RAPPEL = 3;
const JOURS_RETARD_SECOND_RAPPEL = 7;

function formaterMontant(n) {
  return parseInt(n || 0).toLocaleString('fr-FR');
}
function formaterDate(d) {
  return new Date(d).toLocaleDateString('fr-FR');
}

async function dejaEnvoye(echeanceId, typeRappel) {
  const r = await pool.query(
    'SELECT 1 FROM rappels_echeances_envoyes WHERE echeance_id = $1 AND type_rappel = $2',
    [echeanceId, typeRappel]
  );
  return r.rows.length > 0;
}

async function marquerEnvoye(echeanceId, typeRappel) {
  // ON CONFLICT DO NOTHING plutôt qu'un simple INSERT : la contrainte UNIQUE fait déjà tout le
  // travail d'idempotence, pas besoin de faire planter le job si un envoi concurrent a gagné la
  // course entre le dejaEnvoye() et ce marquage.
  await pool.query(
    `INSERT INTO rappels_echeances_envoyes (echeance_id, type_rappel) VALUES ($1, $2)
     ON CONFLICT (echeance_id, type_rappel) DO NOTHING`,
    [echeanceId, typeRappel]
  );
}

// Échéances dont la date limite tombe exactement à decalageJours de aujourd'hui (positif =
// dans le futur, négatif = dans le passé), sur un contrat actif, avec tout le contexte
// nécessaire pour notifier locataire ET propriétaire.
async function trouverEcheances({ decalageJours, statutsAutorises }) {
  const resultat = await pool.query(
    `SELECT e.id, e.mois_concerne, e.montant_du, e.date_limite, e.statut,
            b.numero_bien, b.adresse, b.ville, b.proprietaire_id,
            l.user_id AS locataire_user_id, l.nom AS locataire_nom,
            l.email AS locataire_email, l.telephone AS locataire_telephone,
            p.nom AS proprietaire_nom, p.email AS proprietaire_email, p.telephone AS proprietaire_telephone
     FROM echeances e
     JOIN contrats c ON c.id = e.contrat_id AND c.statut = 'actif'
     JOIN biens b ON b.id = c.bien_id
     JOIN locataires l ON l.id = c.locataire_id
     JOIN users p ON p.id = b.proprietaire_id
     WHERE e.date_limite = (CURRENT_DATE + $1::int)
       AND e.statut = ANY($2::text[])`,
    [decalageJours, statutsAutorises]
  );
  return resultat.rows;
}

async function notifierRappel(e, typeRappel, enRetard) {
  const montant = formaterMontant(e.montant_du);
  const dateLimite = formaterDate(e.date_limite);

  const TEXTES = {
    avant_3j: {
      titre: 'Loyer à régler bientôt',
      locataireMessage: `Votre loyer de ${montant} FCFA pour le bien ${e.numero_bien} est à régler avant le ${dateLimite}.`,
      locataireSms: `RentEasy : loyer de ${montant} FCFA (bien ${e.numero_bien}) à régler avant le ${dateLimite}.`,
    },
    jour_j: {
      titre: "Loyer à régler aujourd'hui",
      locataireMessage: `Votre loyer de ${montant} FCFA pour le bien ${e.numero_bien} est à régler aujourd'hui.`,
      locataireSms: `RentEasy : loyer de ${montant} FCFA (bien ${e.numero_bien}) à régler aujourd'hui.`,
    },
    retard_3j: {
      titre: 'Loyer en retard',
      locataireMessage: `Votre loyer de ${montant} FCFA pour le bien ${e.numero_bien}, échu le ${dateLimite}, n'est toujours pas réglé. Merci de régulariser rapidement.`,
      locataireSms: `RentEasy : loyer de ${montant} FCFA (bien ${e.numero_bien}) en retard depuis le ${dateLimite}. Merci de régulariser.`,
      proprietaireMessage: `Le loyer de ${e.locataire_nom} pour le bien ${e.numero_bien} (${montant} FCFA, échu le ${dateLimite}) n'est toujours pas réglé.`,
    },
    retard_7j: {
      titre: 'Loyer toujours en retard',
      locataireMessage: `Rappel : votre loyer de ${montant} FCFA pour le bien ${e.numero_bien}, échu le ${dateLimite}, n'est toujours pas réglé.`,
      locataireSms: `RentEasy : rappel — loyer de ${montant} FCFA (bien ${e.numero_bien}) toujours impayé depuis le ${dateLimite}.`,
      proprietaireMessage: `Le loyer de ${e.locataire_nom} pour le bien ${e.numero_bien} (${montant} FCFA, échu le ${dateLimite}) reste impayé une semaine après l'échéance.`,
    },
  };
  const texte = TEXTES[typeRappel];

  // Locataire — le contact (email/téléphone) vient de la fiche locataire elle-même, pas d'un
  // compte utilisateur : un locataire n'a pas toujours activé de compte RentEasy, mais ses
  // coordonnées de contact sont toujours connues (locataires.telephone est NOT NULL en base).
  await notifier({
    user_id: e.locataire_user_id,
    email: e.locataire_email,
    nom: e.locataire_nom,
    telephone: e.locataire_telephone,
    sms: texte.locataireSms,
    titre: texte.titre,
    message: texte.locataireMessage,
    type: 'rappel_echeance',
    lien: '/locataire/dashboard',
    sujet_email: `[RentEasy] ${texte.titre}`,
    contenu_email: `
      <h2>${echapperHtml(texte.titre)}</h2>
      <p>Bonjour ${echapperHtml(e.locataire_nom)},</p>
      <p>${echapperHtml(texte.locataireMessage)}</p>
    `,
  });

  // En cas de retard, le propriétaire est aussi prévenu — c'est justement ce qui alimente le
  // recouvrement (l'agent/propriétaire sait qu'il doit relancer, sans attendre de le remarquer
  // lui-même en consultant son dashboard).
  if (enRetard) {
    await notifier({
      user_id: e.proprietaire_id,
      email: e.proprietaire_email,
      nom: e.proprietaire_nom,
      telephone: e.proprietaire_telephone,
      sms: `RentEasy : loyer de ${e.locataire_nom} (bien ${e.numero_bien}) en retard, échu le ${dateLimite}.`,
      titre: `Loyer impayé — ${e.locataire_nom}`,
      message: texte.proprietaireMessage,
      type: 'rappel_echeance',
      lien: '/paiements',
      sujet_email: '[RentEasy] Loyer impayé',
      contenu_email: `
        <h2>Loyer impayé</h2>
        <p>Bonjour ${echapperHtml(e.proprietaire_nom)},</p>
        <p>${echapperHtml(texte.proprietaireMessage)}</p>
      `,
    });
  }
}

async function traiterRappel({ decalageJours, statutsAutorises, typeRappel, enRetard }) {
  const echeances = await trouverEcheances({ decalageJours, statutsAutorises });
  let envoyes = 0;

  for (const e of echeances) {
    try {
      if (await dejaEnvoye(e.id, typeRappel)) continue;
      await notifierRappel(e, typeRappel, enRetard);
      await marquerEnvoye(e.id, typeRappel);
      envoyes++;
    } catch (errUne) {
      console.error(`Erreur rappel échéance ${e.id} (${typeRappel}) :`, errUne.message);
    }
  }

  return envoyes;
}

async function envoyerRappelsEcheances() {
  try {
    const resultats = await Promise.all([
      traiterRappel({ decalageJours: JOURS_AVANT_ECHEANCE, statutsAutorises: ['en_attente'], typeRappel: 'avant_3j', enRetard: false }),
      traiterRappel({ decalageJours: 0, statutsAutorises: ['en_attente'], typeRappel: 'jour_j', enRetard: false }),
      traiterRappel({ decalageJours: -JOURS_RETARD_PREMIER_RAPPEL, statutsAutorises: ['impayee', 'partielle'], typeRappel: 'retard_3j', enRetard: true }),
      traiterRappel({ decalageJours: -JOURS_RETARD_SECOND_RAPPEL, statutsAutorises: ['impayee', 'partielle'], typeRappel: 'retard_7j', enRetard: true }),
    ]);
    const total = resultats.reduce((s, n) => s + n, 0);
    if (total > 0) {
      console.log(`[rappels échéances] ${total} rappel(s) envoyé(s) (avant: ${resultats[0]}, jour J: ${resultats[1]}, retard 3j: ${resultats[2]}, retard 7j: ${resultats[3]})`);
    }
  } catch (err) {
    enregistrerErreur({ erreur: err });
  }
}

module.exports = { envoyerRappelsEcheances };
