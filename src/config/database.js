const { Pool } = require('pg');
require('dotenv').config();

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
