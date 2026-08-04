-- OPTIONNEL — défense en profondeur pour le bug #7 (suppression en cascade destructrice).
--
-- Le correctif applicatif (locataireController.js / bienController.js) bloque déjà toute
-- suppression via l'API tant qu'un contrat existe pour ce locataire/bien, quel que soit son
-- statut. Cette migration n'est donc pas strictement nécessaire pour corriger le bug.
--
-- Elle protège en plus contre un accès direct à la base (script, futur code, admin SQL) qui
-- contournerait ce contrôle applicatif : tant que contrats.locataire_id et contrats.bien_id
-- restent en ON DELETE CASCADE, n'importe quel DELETE direct sur locataires/biens effacerait
-- toujours contrats -> echeances -> paiements/recouvrements en cascade.
--
-- ⚠️ À VÉRIFIER AVANT D'EXÉCUTER : les noms de contraintes ci-dessous supposent la convention
-- de nommage par défaut de Postgres (table_colonne_fkey), utilisée quand aucun nom explicite
-- n'est donné à la création. Vérifie d'abord avec :
--   SELECT conname FROM pg_constraint WHERE conrelid = 'contrats'::regclass AND contype = 'f';
-- et adapte les noms ci-dessous si une migration que je n'ai pas dans ce projet leur a donné
-- un nom différent.

ALTER TABLE contrats DROP CONSTRAINT IF EXISTS contrats_locataire_id_fkey;
ALTER TABLE contrats
  ADD CONSTRAINT contrats_locataire_id_fkey
  FOREIGN KEY (locataire_id) REFERENCES locataires(id) ON DELETE RESTRICT;

ALTER TABLE contrats DROP CONSTRAINT IF EXISTS contrats_bien_id_fkey;
ALTER TABLE contrats
  ADD CONSTRAINT contrats_bien_id_fkey
  FOREIGN KEY (bien_id) REFERENCES biens(id) ON DELETE RESTRICT;
