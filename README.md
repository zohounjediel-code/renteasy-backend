# RentEasy Bénin — Backend

API backend de la plateforme de gestion et recouvrement de loyers.

## Stack
- Node.js + Express
- PostgreSQL (via Railway en production)
- JWT pour l'authentification
- bcrypt pour le hash des mots de passe

## Démarrage local

1. `npm install`
2. Copier `.env.example` vers `.env` et remplir les valeurs (surtout `DATABASE_URL` et `JWT_SECRET`)
3. Créer la base de données PostgreSQL localement, puis exécuter le contenu de `migrations/001_init.sql`
4. `npm run dev`

## Déploiement (Railway)
- Créer un nouveau projet Railway, ajouter un service PostgreSQL
- Laisser Railway générer `DATABASE_URL` automatiquement (ne jamais le coder en dur)
- Définir les autres variables d'environnement dans Railway (JWT_SECRET, CORS_ORIGINS, etc.)
- Exécuter `migrations/001_init.sql` directement dans la console PostgreSQL de Railway

## Structure
```
src/
  config/        connexion base de données
  controllers/   logique métier (auth, biens, paiements...)
  middleware/    authentification JWT, vérification de rôle
  routes/        définition des endpoints API
  utils/         fonctions utilitaires
migrations/      scripts SQL
```

## Routes disponibles (Module 1)
- `POST /api/auth/inscription` — créer un compte propriétaire
- `POST /api/auth/connexion` — se connecter
- `GET /api/health` — vérifier que l'API tourne
