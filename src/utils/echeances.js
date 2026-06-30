// Génère les échéances de loyer pour un contrat donné, sur un nombre de mois défini.
// Appelée à la création du contrat (par exemple sur les 12 prochains mois),
// puis pourra être rappelée périodiquement (cron) pour générer les mois suivants.

function genererDatesEcheances(dateDebut, jourEcheance, nombreMois) {
  const echeances = [];
  const depart = new Date(dateDebut);

  for (let i = 0; i < nombreMois; i++) {
    const moisConcerne = new Date(depart.getFullYear(), depart.getMonth() + i, 1);
    const dateLimite = new Date(depart.getFullYear(), depart.getMonth() + i, jourEcheance);

    echeances.push({
      mois_concerne: moisConcerne.toISOString().slice(0, 10),
      date_limite: dateLimite.toISOString().slice(0, 10),
    });
  }

  return echeances;
}

async function creerEcheancesPourContrat(pool, contrat, nombreMois = 12) {
  const dates = genererDatesEcheances(contrat.date_debut, contrat.jour_echeance, nombreMois);

  const requetes = dates.map((d) =>
    pool.query(
      `INSERT INTO echeances (contrat_id, mois_concerne, montant_du, date_limite)
       VALUES ($1, $2, $3, $4)`,
      [contrat.id, d.mois_concerne, contrat.loyer_mensuel, d.date_limite]
    )
  );

  await Promise.all(requetes);
}

module.exports = { genererDatesEcheances, creerEcheancesPourContrat };
