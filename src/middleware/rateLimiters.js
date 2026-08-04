const rateLimit = require('express-rate-limit');

// Jusqu'ici seule /api/auth était protégée contre les abus (limiteurAuth dans server.js). Les
// routes de paiement, de messagerie et de demandes n'avaient aucune limite : un compte
// compromis ou un script pouvait spammer des demandes de contrat, marteler l'initiation de
// paiements Mobile Money (chaque appel a un coût réel côté opérateur), ou inonder la
// messagerie d'autres utilisateurs.

// Filet générique sur toute l'API, volontairement généreux pour ne jamais gêner un usage
// normal, même intensif (ex : un agent qui enchaîne beaucoup d'actions) — sert avant tout
// contre le scraping et les bots.
const limiteurGeneral = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  message: { message: 'Trop de requêtes, réessayez plus tard' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Paiements (cash, solde, Mobile Money) : chaque tentative Mobile Money déclenche un appel
// facturé chez l'opérateur — un abus ici a un coût financier réel, pas seulement une charge
// serveur.
const limiteurPaiements = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: { message: 'Trop de tentatives de paiement, réessayez dans quelques minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Messagerie interne : limite le spam d'un compte compromis ou d'un script vers d'autres
// utilisateurs de la plateforme.
const limiteurMessages = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { message: 'Trop de messages envoyés, réessayez dans quelques minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Demandes de contrat / résiliation / signalement d'annonce : ce sont des actions qui
// déclenchent des notifications à d'autres personnes (agent, propriétaire, super admin) — à
// limiter pour éviter à la fois le spam de notifications et l'engorgement de la file de
// modération.
const limiteurDemandes = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { message: 'Trop de demandes envoyées, réessayez dans quelques minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { limiteurGeneral, limiteurPaiements, limiteurMessages, limiteurDemandes };
