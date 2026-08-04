-- Migration 034 : rappels d'échéances (avant paiement, jour J, et retard)
--
-- Aucun mécanisme de rappel n'existait jusqu'ici : une échéance passait de "en_attente" à
-- "impayee" (cf. cronBiens.js) sans que personne ne soit jamais relancé entre-temps. Cette table
-- trace quels rappels ont déjà été envoyés pour quelle échéance, avec une contrainte UNIQUE qui
-- rend l'envoi idempotent — un redémarrage du serveur, ou plusieurs passages du cron le même
-- jour, ne renverront jamais deux fois le même rappel.
CREATE TABLE IF NOT EXISTS rappels_echeances_envoyes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  echeance_id UUID NOT NULL REFERENCES echeances(id) ON DELETE CASCADE,
  type_rappel VARCHAR(20) NOT NULL CHECK (type_rappel IN ('avant_3j', 'jour_j', 'retard_3j', 'retard_7j')),
  envoye_le TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (echeance_id, type_rappel)
);
