// Génère les échéances de loyer pour un contrat, en respectant sa périodicité
// (journalier, hebdomadaire, mensuel, annuel), le jour d'échéance choisi pour
// chaque périodicité, et sa durée (date_fin si définie).

const PERIODES_PAR_DEFAUT = { journalier: 30, hebdomadaire: 12, mensuel: 12, annuel: 3 };
const SEUIL_RENOUVELLEMENT = { journalier: 5, hebdomadaire: 3, mensuel: 2, annuel: 1 };

// Calcule automatiquement les paramètres d'échéance (jour_echeance, jour_semaine_echeance,
// jour_echeance_annuel, mois_echeance_annuel) à partir de la date de début du contrat et
// du type de loyer choisi. L'échéance suit toujours la date de début :
//  - hebdomadaire : échéance = date_debut + 7 jours (même jour de semaine que le début)
//  - mensuel      : échéance chaque mois au même quantième que la date de début (plafonné à 28)
//  - annuel       : échéance chaque année au même jour/mois que la date de début
//  - journalier   : pas de jour particulier, échéance chaque jour
// Toutes les dates de ce fichier sont des chaînes 'YYYY-MM-DD' (sans heure), donc parsées par
// `new Date(...)` comme minuit UTC. Sur un serveur dont le fuseau local n'est pas UTC, les
// accesseurs locaux (getDate/getDay/getMonth...) peuvent alors renvoyer la veille — d'où
// l'usage systématique des variantes UTC dans tout ce fichier, y compris pour construire de
// nouvelles dates (Date.UTC plutôt que `new Date(année, mois, jour)`, qui construit en local).
function calculerEcheanceDepuisDebut(date_debut, type_loyer) {
  const d = new Date(date_debut);
  if (type_loyer === 'hebdomadaire') {
    return { jour_echeance: null, jour_semaine_echeance: d.getUTCDay(), jour_echeance_annuel: null, mois_echeance_annuel: null };
  }
  if (type_loyer === 'annuel') {
    return { jour_echeance: null, jour_semaine_echeance: null, jour_echeance_annuel: d.getUTCDate(), mois_echeance_annuel: d.getUTCMonth() + 1 };
  }
  if (type_loyer === 'mensuel') {
    return { jour_echeance: Math.min(d.getUTCDate(), 28), jour_semaine_echeance: null, jour_echeance_annuel: null, mois_echeance_annuel: null };
  }
  // journalier (ou tout autre cas) : pas de jour d'échéance particulier
  return { jour_echeance: null, jour_semaine_echeance: null, jour_echeance_annuel: null, mois_echeance_annuel: null };
}

function ajouterPeriode(date, typeLoyer, n) {
  const d = new Date(date);
  if (typeLoyer === 'journalier') d.setUTCDate(d.getUTCDate() + n);
  else if (typeLoyer === 'hebdomadaire') d.setUTCDate(d.getUTCDate() + n * 7);
  else if (typeLoyer === 'annuel') d.setUTCFullYear(d.getUTCFullYear() + n);
  else d.setUTCMonth(d.getUTCMonth() + n); // mensuel par défaut
  return d;
}

// Trouve la première occurrence du jour de semaine souhaité à partir d'une date (incluse)
function premierJourSemaine(depart, jourSemaineVoulu) {
  const d = new Date(depart);
  if (jourSemaineVoulu === null || jourSemaineVoulu === undefined) return d;
  const ecart = (jourSemaineVoulu - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + ecart);
  return d;
}

// Trouve la première occurrence jour/mois souhaitée à partir d'une date (incluse)
function premiereDateAnnuelle(depart, jourVoulu, moisVoulu) {
  const d = new Date(depart);
  if (!jourVoulu || !moisVoulu) return d;
  let candidate = new Date(Date.UTC(d.getUTCFullYear(), moisVoulu - 1, jourVoulu));
  if (candidate < d) candidate = new Date(Date.UTC(d.getUTCFullYear() + 1, moisVoulu - 1, jourVoulu));
  return candidate;
}

// Point de départ des périodes, ajusté selon le jour d'échéance choisi pour le type de loyer
function ancrerDepart(contrat, depart) {
  const type = contrat.type_loyer || 'mensuel';
  if (type === 'hebdomadaire' && contrat.jour_semaine_echeance !== null && contrat.jour_semaine_echeance !== undefined) {
    return premierJourSemaine(depart, contrat.jour_semaine_echeance);
  }
  if (type === 'annuel' && contrat.jour_echeance_annuel && contrat.mois_echeance_annuel) {
    return premiereDateAnnuelle(depart, contrat.jour_echeance_annuel, contrat.mois_echeance_annuel);
  }
  return depart;
}

// Calcule les dates de N prochaines périodes à partir d'un point de départ donné
function genererDatesEcheances(contrat, dateDepart = null, nombrePeriodes = null) {
  const type = contrat.type_loyer || 'mensuel';
  const departBrut = dateDepart ? new Date(dateDepart) : new Date(contrat.date_debut);
  const depart = ancrerDepart(contrat, departBrut);
  const fin = contrat.date_fin ? new Date(contrat.date_fin) : null;
  const maxPeriodes = nombrePeriodes || PERIODES_PAR_DEFAUT[type] || 12;
  // La toute première période du contrat (jour/semaine/mois/année de démarrage) ne
  // doit jamais constituer une échéance à elle seule : la première échéance tombe
  // sur la période suivante.
  const dateDebutContrat = new Date(contrat.date_debut).toISOString().slice(0, 10);

  const echeances = [];
  for (let i = 0; echeances.length < maxPeriodes; i++) {
    const periodeDebut = ajouterPeriode(depart, type, i);
    if (fin && periodeDebut > fin) break;
    if (i > maxPeriodes + 5) break; // garde-fou anti-boucle infinie

    if (periodeDebut.toISOString().slice(0, 10) === dateDebutContrat) {
      continue; // on saute la période de départ du contrat lui-même
    }

    let dateLimite;
    if (type === 'mensuel') {
      dateLimite = new Date(Date.UTC(periodeDebut.getUTCFullYear(), periodeDebut.getUTCMonth(), contrat.jour_echeance || 5));
    } else {
      // Journalier / hebdomadaire (ancré) / annuel (ancré) : échéance = fin de période
      dateLimite = periodeDebut;
    }

    echeances.push({
      mois_concerne: periodeDebut.toISOString().slice(0, 10),
      date_limite: dateLimite.toISOString().slice(0, 10),
    });
  }

  // Contrat (ou renouvellement) plus court qu'une période complète du type de loyer choisi
  // (ex: bail "mensuel" de quelques jours seulement) : la boucle ci-dessus ne produit alors
  // aucune échéance, puisque même la période suivant le point de départ dépasse déjà la date
  // de fin. Sans ce filet, le loyer de ce bail n'était jamais réclamé nulle part — ni à la
  // création, ni par le cron de rattrapage (qui ignorait un contrat sans aucune échéance
  // existante, faute de date à partir de laquelle continuer). On facture alors la durée
  // restante en une seule échéance, due à la date de fin — sans proratiser, comme partout
  // ailleurs dans ce fichier (chaque échéance facture déjà le loyer plein, quelle que soit
  // la durée exacte de la période qu'elle couvre).
  if (echeances.length === 0 && fin && depart <= fin) {
    echeances.push({
      mois_concerne: depart.toISOString().slice(0, 10),
      date_limite: fin.toISOString().slice(0, 10),
    });
  }

  return echeances;
}

async function creerEcheancesPourContrat(pool, contrat) {
  const dates = genererDatesEcheances(contrat);

  const requetes = dates.map((d) =>
    pool.query(
      `INSERT INTO echeances (contrat_id, mois_concerne, montant_du, date_limite)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [contrat.id, d.mois_concerne, contrat.loyer_mensuel, d.date_limite]
    )
  );

  await Promise.all(requetes);
}

async function completerEcheancesContratsActifs(pool) {
  const contrats = await pool.query(
    `SELECT * FROM contrats WHERE statut = 'actif' AND (date_fin IS NULL OR date_fin >= CURRENT_DATE)`
  );

  for (const contrat of contrats.rows) {
    const type = contrat.type_loyer || 'mensuel';
    const derniere = await pool.query(
      'SELECT MAX(mois_concerne) AS derniere FROM echeances WHERE contrat_id = $1',
      [contrat.id]
    );
    const derniereDate = derniere.rows[0].derniere;

    // Un contrat actif sans AUCUNE échéance (typiquement une durée personnalisée plus courte
    // qu'une période complète — cf. le filet ajouté dans genererDatesEcheances) restait
    // ignoré ici pour toujours : sans date de départ à partir de laquelle continuer, son
    // loyer n'était jamais réclamé. On retente depuis le début du contrat, comme à sa
    // création — une fois la première échéance générée, la prochaine exécution du cron
    // retombera normalement dans le cas ci-dessous.
    if (!derniereDate) {
      const dates = genererDatesEcheances(contrat);
      const requetes = dates.map((d) =>
        pool.query(
          `INSERT INTO echeances (contrat_id, mois_concerne, montant_du, date_limite)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [contrat.id, d.mois_concerne, contrat.loyer_mensuel, d.date_limite]
        )
      );
      await Promise.all(requetes);
      continue;
    }

    const seuil = SEUIL_RENOUVELLEMENT[type] || 2;
    const prochaine = ajouterPeriode(derniereDate, type, 1);

    let periodesRestantes = 0;
    let curseur = new Date();
    while (curseur < new Date(derniereDate) && periodesRestantes < 1000) {
      curseur = ajouterPeriode(curseur, type, 1);
      periodesRestantes++;
    }

    if (periodesRestantes <= seuil) {
      const nouvelles = genererDatesEcheances(contrat, prochaine, PERIODES_PAR_DEFAUT[type] || 12);
      const requetes = nouvelles.map((d) =>
        pool.query(
          `INSERT INTO echeances (contrat_id, mois_concerne, montant_du, date_limite)
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [contrat.id, d.mois_concerne, contrat.loyer_mensuel, d.date_limite]
        )
      );
      await Promise.all(requetes);
    }
  }
}

module.exports = { genererDatesEcheances, creerEcheancesPourContrat, completerEcheancesContratsActifs, ajouterPeriode, calculerEcheanceDepuisDebut };
