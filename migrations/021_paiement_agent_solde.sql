-- Migration 021 : Paiement par l'agent avec son propre solde, pour le compte d'un locataire
--
-- Cas d'usage : l'agent recouvre de l'argent en espèces sur le terrain, recharge son propre
-- solde RentEasy (circuit de recharge déjà existant), puis règle l'échéance du locataire avec
-- ce solde (totalement ou par tranche). paye_par_agent_id trace qui a réellement effectué le
-- paiement, même si le solde débité est bien celui de l'agent (pas celui du locataire).

ALTER TABLE paiements ADD COLUMN IF NOT EXISTS paye_par_agent_id UUID REFERENCES users(id);
