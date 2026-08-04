-- Migration 019 : Délégation "agir au nom de" pour les agents, avec traçabilité
--
-- 1. Un propriétaire peut autoriser (ou révoquer à tout moment) son agent assigné à gérer
--    ses biens/contrats/locataires à sa place.
-- 2. Chaque enregistrement créé par un agent dans ce cadre est marqué avec l'identifiant
--    de l'agent (effectue_par_agent_id), pour une traçabilité complète et permanente,
--    même si la délégation est révoquée par la suite.

ALTER TABLE users ADD COLUMN IF NOT EXISTS autorise_agent_gestion BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE biens ADD COLUMN IF NOT EXISTS effectue_par_agent_id UUID REFERENCES users(id);
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS effectue_par_agent_id UUID REFERENCES users(id);
ALTER TABLE locataires ADD COLUMN IF NOT EXISTS effectue_par_agent_id UUID REFERENCES users(id);

-- Sur un contrat, effectue_par_agent_id renseigné en même temps qu'une signature_proprietaire
-- signifie que l'agent a signé électroniquement pour le compte du propriétaire (délégation).
