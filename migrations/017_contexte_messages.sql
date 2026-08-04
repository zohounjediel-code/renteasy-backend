-- Migration 017 : Sépare la messagerie par espace (propriétaire / locataire)
-- Un même compte peut avoir les deux rôles ; leurs conversations doivent rester distinctes
-- même si l'interlocuteur (ex: un agent) est identique dans les deux espaces.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS contexte VARCHAR(20) DEFAULT 'proprietaire'
  CHECK (contexte IN ('proprietaire', 'locataire'));
