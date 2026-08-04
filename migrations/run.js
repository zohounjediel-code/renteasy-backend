// Exécute chaque fichier .sql de ce dossier, dans l'ordre, en ne rejouant jamais une
// migration déjà appliquée (table de suivi schema_migrations). C'est ce fichier que
// `npm run migrate` cherche à lancer — il n'existait pas du tout, la commande échouait
// systématiquement avec "Cannot find module".
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { Pool } = require('pg');

// Même correctif que config/database.js : évite un ENOTFOUND côté Node quand l'OS, lui,
// résout l'adresse en IPv4 après un raté IPv6 (observé sur reseau.proxy.rlwy.net).
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

// Contrairement à config/database.js (qui tourne SUR le serveur déployé, où NODE_ENV=production
// est correctement défini), ce script est lancé DEPUIS la machine du développeur pour se
// connecter À une base distante — NODE_ENV y vaut rarement "production", donc reprendre la même
// condition désactivait le SSL même vers une base qui l'exige (Railway, entre autres), et la
// connexion se faisait couper (ECONNRESET). On se base plutôt sur l'hôte visé dans DATABASE_URL.
const cibleLocale = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: cibleLocale ? false : { rejectUnauthorized: false },
});

async function run() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        nom VARCHAR(255) PRIMARY KEY,
        applique_le TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    const dejaAppliquees = await client.query('SELECT nom FROM schema_migrations');
    const nomsAppliques = new Set(dejaAppliquees.rows.map((r) => r.nom));

    // Le tri alphabétique correspond à l'ordre numérique voulu (001_, 017_, 019_...),
    // tant que le préfixe reste sur 3 chiffres comme partout dans ce dossier.
    const fichiers = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    console.log(`${fichiers.length} fichier(s) de migration trouvé(s).\n`);

    let nombreAppliquees = 0;

    for (const fichier of fichiers) {
      if (nomsAppliques.has(fichier)) {
        console.log(`⏭  ${fichier} — déjà appliquée, ignorée`);
        continue;
      }

      const contenu = fs.readFileSync(path.join(__dirname, fichier), 'utf8');
      console.log(`▶️  ${fichier} — application en cours...`);

      try {
        await client.query('BEGIN');
        await client.query(contenu);
        await client.query('INSERT INTO schema_migrations (nom) VALUES ($1)', [fichier]);
        await client.query('COMMIT');
        console.log(`✅ ${fichier} — appliquée avec succès`);
        nombreAppliquees++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`❌ ${fichier} — échec : ${err.message}`);
        throw err;
      }
    }

    console.log(`\n${nombreAppliquees} migration(s) appliquée(s), ${fichiers.length - nombreAppliquees} déjà à jour.`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('\nMigration interrompue :', err.message);
  if (['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED'].includes(err.code)) {
    console.error(
      "\nCeci ressemble à un problème de connexion à la base plutôt qu'à une erreur SQL. À vérifier :\n" +
      '  - DATABASE_URL est bien définie dans renteasy-backend/.env\n' +
      "  - si la base est distante (Railway...), qu'elle est bien joignable depuis ta machine\n" +
      '  - un pare-feu / VPN qui bloquerait le port Postgres (5432)'
    );
  }
  process.exit(1);
});
