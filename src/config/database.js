const { Pool } = require('pg');
require('dotenv').config();
const dns = require('dns');

// Le nslookup fait à la main a montré un raté IPv6 avant de réussir en IPv4 sur
// reseau.proxy.rlwy.net (Railway) — Node ne fait pas toujours ce même repli automatiquement
// et peut échouer en ENOTFOUND là où l'OS réussit. On force IPv4 en priorité pour éviter ça.
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// En production (Railway), DATABASE_URL est fourni automatiquement.
// On laisse Railway gérer cette variable plutôt que de la coder en dur
// (leçon apprise sur OJADA BANK : ne jamais figer une URL locale).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('connect', () => {
  console.log('Connexion à la base de données PostgreSQL établie');
});

pool.on('error', (err) => {
  console.error('Erreur inattendue sur le pool PostgreSQL', err);
  process.exit(-1);
});

module.exports = pool;
