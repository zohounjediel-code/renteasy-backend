-- Migration 028 : modération des annonces du marché
--
-- moderation_masque est INDÉPENDANT de sur_le_marche (bascule du propriétaire) : une annonce
-- retirée par la modération reste masquée du marché public même si le propriétaire retoggle
-- sur_le_marche à true — sinon la modération n'aurait aucun effet durable. Le propriétaire est
-- notifié du retrait avec le motif, et peut contester/corriger avant une éventuelle republication
-- par le super admin (moderation_masque repassé à false).
ALTER TABLE biens ADD COLUMN IF NOT EXISTS moderation_masque BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE biens ADD COLUMN IF NOT EXISTS moderation_raison TEXT;
ALTER TABLE biens ADD COLUMN IF NOT EXISTS moderation_par UUID REFERENCES users(id);
ALTER TABLE biens ADD COLUMN IF NOT EXISTS moderation_le TIMESTAMP;
