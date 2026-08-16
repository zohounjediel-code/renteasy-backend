const { notifier, echapperHtml } = require('./notifications');

// Nombre d'unités de période (jour/semaine/mois/année selon type_loyer) que représente la
// caution — appliqué uniformément quel que soit le type_loyer puisque loyer_mensuel représente
// déjà le montant d'UNE période, quelle qu'elle soit.
const UNITES_CAUTION = 3;

function calculerCaution(loyerMensuel) {
  return UNITES_CAUTION * loyerMensuel;
}

// Transfère ce qui reste en caution_solde vers le solde principal du locataire — appelé à
// chaque chemin qui termine réellement un contrat (résiliation directe, approbation d'une
// demande de résiliation, finalisation d'une fin de contrat). `client` doit faire partie de la
// même transaction que le changement de statut du contrat (modification de solde). Ne notifie
// pas elle-même : renvoie les infos nécessaires, à passer à notifierCautionTransferee() une fois
// la transaction validée (jamais d'appel réseau pendant qu'une transaction est ouverte).
async function transfererCautionFinContrat(client, contratId) {
  const contratRes = await client.query(
    `SELECT c.caution_solde, b.numero_bien, l.user_id AS locataire_user_id, l.nom AS locataire_nom
     FROM contrats c
     JOIN biens b ON b.id = c.bien_id
     JOIN locataires l ON l.id = c.locataire_id
     WHERE c.id = $1`,
    [contratId]
  );
  if (contratRes.rows.length === 0) return null;
  const c = contratRes.rows[0];

  if (c.caution_solde <= 0) return null;

  // Le locataire n'a pas toujours de compte RentEasy (ajouté directement par le propriétaire) :
  // sans compte, il n'y a pas de solde à créditer. On laisse caution_solde tel quel plutôt que
  // de faire disparaître la somme silencieusement — à régulariser manuellement le cas échéant.
  if (!c.locataire_user_id) return null;

  await client.query('UPDATE users SET solde = solde + $1 WHERE id = $2', [c.caution_solde, c.locataire_user_id]);
  await client.query(
    `INSERT INTO caution_mouvements (contrat_id, type, montant) VALUES ($1, 'transfert', $2)`,
    [contratId, c.caution_solde]
  );
  await client.query(
    `UPDATE contrats SET caution_solde = 0, statut_caution = 'transferee' WHERE id = $1`,
    [contratId]
  );

  return {
    montantTransfere: c.caution_solde,
    locataireUserId: c.locataire_user_id,
    locataireNom: c.locataire_nom,
    numeroBien: c.numero_bien,
  };
}

async function notifierCautionTransferee(info) {
  if (!info) return;
  await notifier({
    user_id: info.locataireUserId,
    nom: info.locataireNom,
    titre: 'Caution transférée sur votre solde',
    message: `Le contrat pour le bien ${info.numeroBien} est terminé : votre caution de ${info.montantTransfere.toLocaleString('fr-FR')} FCFA a été transférée sur votre solde principal.`,
    type: 'paiement',
    lien: '/profil',
    sujet_email: '[RentEasy] Caution transférée sur votre solde',
    contenu_email: `
      <h2>Caution transférée</h2>
      <p>Bonjour ${echapperHtml(info.locataireNom)},</p>
      <p>Le contrat pour le bien <strong>${info.numeroBien}</strong> est terminé. Votre caution de
      <strong>${info.montantTransfere.toLocaleString('fr-FR')} FCFA</strong> a été transférée sur votre solde principal, disponible pour retrait ou tout autre usage sur la plateforme.</p>
    `,
  });
}

// Après une déduction sur la caution (loyer impayé couvert automatiquement), détecte si l'agent
// géreur du propriétaire doit être prévenu — dès que le solde restant tombe à une unité ou moins,
// une seule fois tant que le solde ne remonte pas au-dessus (alerte_caution_envoyee évite le
// spam à chaque passage du cron horaire tant que la situation ne s'améliore pas). Comme
// transfererCautionFinContrat, ne notifie pas elle-même : renvoie la liste des destinataires à
// prévenir via notifierCautionFaible() une fois la transaction validée.
async function verifierAlerteCautionFaible(client, contratId) {
  const contratRes = await client.query(
    `SELECT c.caution_solde, c.loyer_mensuel, c.alerte_caution_envoyee, b.numero_bien,
            l.nom AS locataire_nom, p.agent_id
     FROM contrats c
     JOIN biens b ON b.id = c.bien_id
     JOIN locataires l ON l.id = c.locataire_id
     JOIN users p ON p.id = b.proprietaire_id
     WHERE c.id = $1`,
    [contratId]
  );
  if (contratRes.rows.length === 0) return null;
  const c = contratRes.rows[0];

  if (c.caution_solde > c.loyer_mensuel) {
    // Remonté au-dessus du seuil (ex : nouvelle caution repayée sur un autre contrat) : réarme
    // l'alerte pour la prochaine fois que ça redescendra.
    if (c.alerte_caution_envoyee) {
      await client.query('UPDATE contrats SET alerte_caution_envoyee = false WHERE id = $1', [contratId]);
    }
    return null;
  }
  if (c.alerte_caution_envoyee) return null;

  const destinataires = c.agent_id
    ? [c.agent_id]
    : (await client.query(`SELECT id FROM users WHERE role LIKE '%admin%'`)).rows.map(r => r.id);

  await client.query('UPDATE contrats SET alerte_caution_envoyee = true WHERE id = $1', [contratId]);

  return { destinataires, locataireNom: c.locataire_nom, numeroBien: c.numero_bien, caution_solde: c.caution_solde };
}

async function notifierCautionFaible(info) {
  if (!info) return;
  for (const userId of info.destinataires) {
    await notifier({
      user_id: userId,
      titre: 'Caution presque épuisée',
      message: `La caution du locataire ${info.locataireNom} (bien ${info.numeroBien}) est tombée à ${info.caution_solde.toLocaleString('fr-FR')} FCFA, soit une unité de loyer ou moins — une nouvelle absence de paiement ne pourra plus être couverte.`,
      type: 'demande',
      lien: '/agent/proprietaires',
    });
  }
}

module.exports = {
  calculerCaution,
  transfererCautionFinContrat,
  notifierCautionTransferee,
  verifierAlerteCautionFaible,
  notifierCautionFaible,
  UNITES_CAUTION,
};
