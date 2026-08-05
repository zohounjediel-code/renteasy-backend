# RentEasy Bénin — Backend

API backend de la plateforme de gestion et recouvrement de loyers.

## Stack
- Node.js + Express
- PostgreSQL (via Railway en production)
- JWT pour l'authentification
- bcrypt pour le hash des mots de passe
- Brevo pour l'envoi d'emails transactionnels

## Démarrage local

1. `npm install`
2. Copier `.env.example` vers `.env` et remplir les valeurs (surtout `DATABASE_URL` et `JWT_SECRET`)
3. Créer la base de données PostgreSQL localement
4. `npm run migrate` — applique toutes les migrations SQL dans l'ordre (`migrations/*.sql`), en
   suivant celles déjà appliquées dans la table `schema_migrations` (voir `migrations/run.js`)
5. `npm run dev`

## Déploiement (Railway)
- Créer un nouveau projet Railway, ajouter un service PostgreSQL
- Laisser Railway générer `DATABASE_URL` automatiquement (ne jamais le coder en dur)
- Définir les autres variables d'environnement dans Railway (voir `.env.example` pour la liste
  complète — JWT_SECRET, CORS_ORIGINS, FRONTEND_URL, credentials Mobile Money/SMS/Brevo, etc.)
- `NODE_ENV=production` doit être défini (active notamment le SSL sur la connexion PostgreSQL,
  voir `src/config/database.js`)
- Exécuter `npm run migrate` (ou `node migrations/run.js`) contre la base Railway pour appliquer
  toutes les migrations

## Structure
```
src/
  config/        connexion base de données
  controllers/   logique métier (auth, biens, paiements, mobilemoney, agents, superadmin...)
  middleware/    authentification JWT, vérification de rôle, rate limiting, upload
  routes/        définition des endpoints API
  utils/         fonctions utilitaires (emails, SMS, PDF, cron, journal d'activité...)
migrations/      scripts SQL numérotés + script d'exécution (run.js)
```

## Domaines fonctionnels couverts
- **Auth** (`routes/auth.js`) — inscription, connexion, activation de compte, mot de passe oublié
- **Biens / Locataires / Contrats** (`routes/biens.js`, `locataires.js`, `contrats.js`) — gestion
  locative, génération automatique des échéances et du contrat PDF
- **Paiements** (`routes/paiements.js`) — enregistrement des paiements (espèces, virement,
  Mobile Money), commission, quittances PDF
- **Mobile Money** (`routes/mobilemoney.js`, `routes/solde.js`) — intégration MTN MoMo, Moov
  Money, Celtiis Pay ; solde interne et retraits
- **Agents** (`routes/agent.js`) — délégation propriétaire → agent, recouvrement pour compte de tiers
- **Espace locataire** (`routes/locataireEspace.js`) — accès dédié du locataire à son contrat/historique
- **Marché locatif** (page frontend `Marche`, modération via `routes/superAdmin.js`)
- **Messagerie & notifications** (`routes/messages.js`, `routes/notifications.js`)
- **Contact / support** (`routes/contact.js`) — formulaire public, sans authentification
- **Super Admin** (`routes/superAdmin.js`) — utilisateurs, journal d'activité, paramètres de
  plateforme, modération, rapports financiers/régionaux, monitoring d'erreurs

Toutes les routes protégées nécessitent le header `Authorization: Bearer <token>` obtenu à la
connexion (`POST /api/auth/connexion`). Le détail des endpoints est visible directement dans
`src/routes/`, chaque fichier étant court et organisé par domaine.

- `GET /api/health` — vérifier que l'API tourne
