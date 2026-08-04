const pool = require('../config/database');

// Cache court (60s) : ces valeurs sont lues à chaque paiement (commission) ou appel Mobile Money
// (credentials), donc taper la base à chaque fois serait inutilement coûteux. 60s reste assez
// court pour qu'une modification depuis la page Paramètres soit prise en compte quasi immédiatement.
const DUREE_CACHE_MS = 60 * 1000;

let cachePlateforme = null;
let expirePlateforme = 0;
let cacheOperateurs = null;
let expireOperateurs = 0;

async function rafraichirPlateforme() {
  const resultat = await pool.query('SELECT cle, valeur FROM parametres_plateforme');
  cachePlateforme = {};
  for (const row of resultat.rows) cachePlateforme[row.cle] = row.valeur;
  expirePlateforme = Date.now() + DUREE_CACHE_MS;
}

async function rafraichirOperateurs() {
  const resultat = await pool.query('SELECT * FROM parametres_operateurs');
  cacheOperateurs = {};
  for (const row of resultat.rows) cacheOperateurs[row.operateur] = row;
  expireOperateurs = Date.now() + DUREE_CACHE_MS;
}

// Taux de commission RentEasy (0.05 = 5%), avec repli sur 5% si jamais la ligne n'existe pas
// en base (ne devrait pas arriver, la migration 027 l'insère, mais on reste défensif).
async function obtenirTauxCommission() {
  if (!cachePlateforme || Date.now() > expirePlateforme) await rafraichirPlateforme();
  const valeur = cachePlateforme.taux_commission;
  return valeur !== undefined ? parseFloat(valeur) : 0.05;
}

async function listerParametresPlateforme() {
  const resultat = await pool.query('SELECT * FROM parametres_plateforme ORDER BY cle');
  return resultat.rows;
}

async function definirParametrePlateforme(cle, valeur, userId) {
  await pool.query(
    `INSERT INTO parametres_plateforme (cle, valeur, modifie_par, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur, modifie_par = EXCLUDED.modifie_par, updated_at = NOW()`,
    [cle, String(valeur), userId]
  );
  cachePlateforme = null; // invalide le cache : la prochaine lecture repart de la base
}

// Une clé API : priorité à la base (si renseignée et non vide), repli sur la variable
// d'environnement correspondante sinon — ce qui permet de migrer opérateur par opérateur, champ
// par champ, sans jamais casser un identifiant déjà en place côté .env.
async function obtenirCredentialOperateur(operateur, cleJson, varEnvRepli) {
  if (!cacheOperateurs || Date.now() > expireOperateurs) await rafraichirOperateurs();
  const enBase = cacheOperateurs[operateur]?.cles?.[cleJson];
  if (enBase) return enBase;
  return varEnvRepli ? process.env[varEnvRepli] : undefined;
}

async function operateurEstActif(operateur) {
  if (!cacheOperateurs || Date.now() > expireOperateurs) await rafraichirOperateurs();
  return !!cacheOperateurs[operateur]?.actif;
}

async function listerOperateurs() {
  const resultat = await pool.query('SELECT * FROM parametres_operateurs ORDER BY operateur');
  return resultat.rows;
}

async function definirOperateur(operateur, { actif, cles }, userId) {
  await pool.query(
    `UPDATE parametres_operateurs
     SET actif = COALESCE($2, actif), cles = COALESCE($3::jsonb, cles), modifie_par = $4, updated_at = NOW()
     WHERE operateur = $1`,
    [operateur, actif === undefined ? null : actif, cles === undefined ? null : JSON.stringify(cles), userId]
  );
  cacheOperateurs = null;
}

module.exports = {
  obtenirTauxCommission,
  listerParametresPlateforme,
  definirParametrePlateforme,
  obtenirCredentialOperateur,
  operateurEstActif,
  listerOperateurs,
  definirOperateur,
};
