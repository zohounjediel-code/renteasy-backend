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

## Routes disponibles (Module 2)
Toutes nécessitent le header `Authorization: Bearer <token>` obtenu à la connexion.

- `POST /api/biens` — ajouter un bien immobilier
- `GET /api/biens` — lister mes biens
- `GET /api/biens/:id` — détail d'un bien
- `PUT /api/biens/:id` — modifier un bien
- `DELETE /api/biens/:id` — supprimer un bien

- `POST /api/locataires` — ajouter un locataire
- `GET /api/locataires` — lister mes locataires
- `GET /api/locataires/:id` — détail d'un locataire
- `PUT /api/locataires/:id` — modifier un locataire

- `POST /api/contrats` — créer un contrat (lie un bien à un locataire, génère 12 mois d'échéances automatiquement)
- `GET /api/contrats` — lister mes contrats
- `GET /api/contrats/:id` — détail d'un contrat avec ses échéances
- `PATCH /api/contrats/:id/resilier` — résilier un contrat

## Routes disponibles (Module 3)
- `POST /api/paiements` — enregistrer un paiement sur une échéance (calcule la commission 5%, met à jour le statut, génère une quittance PDF)
- `GET /api/paiements` — historique des paiements du propriétaire
- `GET /api/paiements/impayes` — liste des échéances en retard de paiement
- `GET /api/paiements/:id/quittance` — télécharger la quittance PDF d'un paiement
