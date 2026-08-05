# Tests

## Lancer les tests

```bash
npm test
```

## Pourquoi le test runner natif de Node (`node:test`) et pas Jest ?

Aucune raison technique de fond — c'est un choix pragmatique du moment où cette suite a été
créée (pas d'accès réseau disponible pour `npm install jest` à ce moment-là). `node:test` est
disponible nativement depuis Node 18 (déjà la version minimale requise par ce projet, cf.
`engines` dans `package.json`), ne demande aucune dépendance supplémentaire, et couvre largement
les besoins actuels (tests unitaires de fonctions pures).

Si l'équipe préfère migrer vers Jest plus tard (meilleurs mocks, snapshots, écosystème plus
large), la conversion est directe : les fichiers `test/*.test.js` utilisent déjà `describe`/`test`
et `assert.equal`/`assert.deepEqual`/`assert.match`, qui ont des équivalents quasi identiques
en Jest (`expect(...).toBe(...)`, etc.) — pas besoin de réécrire toute la logique de test,
seulement les assertions.

## Portée actuelle

Cette suite couvre :

- `src/utils/echeances.js` — calcul des dates d'échéances (mensuel/hebdomadaire/annuel/journalier),
  y compris deux régressions déjà rencontrées en production et documentées en commentaire dans
  le code source lui-même (contrat plus court qu'une période complète). Fonctions pures, pas de
  base de données.
- `src/utils/notifications.js` (`echapperHtml`) — protection anti-XSS des emails. Fonction pure.
- `src/utils/rapportFinancier.js` (`genererRapportCSV`) — échappement CSV, BOM UTF-8, calcul des
  totaux. Pas de base de données (juste un faux objet `res`).
- `src/utils/rappelsEcheances.js` — mécanisme de rappels d'échéances (avant paiement, jour J,
  retards). Contrairement aux trois précédents, ce module ne fait quasiment que des appels
  `pool.query` : `pool.query` est mocké directement sur l'instance partagée avec `mock.method`
  (stable, pas besoin du flag expérimental `--experimental-test-module-mocks` qu'aurait demandé
  `mock.module`). Le test le plus important vérifie qu'un rappel déjà envoyé n'est jamais
  renvoyé deux fois.
- `src/utils/erreurs.js` — monitoring d'erreurs serveur. Même technique de mock que
  `rappelsEcheances.js`. Le test le plus important vérifie l'anti-spam : trois occurrences
  immédiates de la même erreur ne déclenchent qu'**une seule** alerte email, tout en restant
  chacune bien enregistrées en base pour l'historique.
- `src/controllers/paiementController.js` (`creerPaiement`, `payerEcheanceSolde`) — le mouvement
  d'argent le plus critique de la plateforme. Couvre : validation du montant (négatif, non
  entier, zéro — un `-5000` est "truthy" en JS, piège classique), les deux gardes anti-doublon
  (référence de transaction déjà utilisée, double-clic dans les 30s), le plafonnement au reste dû,
  le calcul de la commission à 5%, la transition de statut de l'échéance (partielle/payée), et
  pour le paiement par solde : la répartition transactionnelle solde locataire → part
  propriétaire + commission RentEasy, avec `ROLLBACK` vérifié si le solde est insuffisant.
  `genererQuittancePDF` n'est PAS mockée (écrit un vrai PDF, supprimé après coup dans `after()`).

Voir `test/rappelsEcheances.test.js` ou `test/erreurs.test.js` pour le pattern complet de mock
sur `pool.query`, et `test/paiements.test.js` pour le mock de `pool.connect()` (transaction avec
client dédié, `BEGIN`/`COMMIT`/`ROLLBACK`) — modèles à suivre pour tester un controller qui
touche la base.

## Ce qui n'est PAS encore testé automatiquement

Les controllers d'authentification (`authController.js`), de contrats/biens, l'intégration
Mobile Money réelle (appels HTTP vers MTN/Moov/Celtiis), ainsi que le rendu visuel du PDF
(quittances et contrats — vérifié manuellement lors de son développement, pas via ces tests).

## Étendre la suite : tester un controller qui utilise la base

Deux approches possibles :

1. **Mocker `pool.query` directement** (`mock.method(pool, 'query', ...)`) — le plus simple, ne
   demande aucun flag expérimental, fonctionne dès Node 18. Le mock doit distinguer les requêtes
   par leur texte SQL (`sql.includes(...)`) puisqu'il n'y a qu'une seule méthode à intercepter
   pour toutes les requêtes du module testé.
2. **Mocker le module entier** (`mock.module`, nécessite `--experimental-test-module-mocks`) —
   utile si le module importe autre chose que `pool` (ex : un client HTTP externe) et qu'on veut
   remplacer l'import lui-même plutôt qu'une seule méthode.

Pour de vrais tests d'intégration (avec une vraie base), la manière la plus fiable reste une
base Postgres de test dédiée (conteneur Docker jetable, ou schéma séparé sur la même instance) —
aucune de ces deux options n'est configurée dans ce projet pour l'instant.
