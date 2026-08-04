-- Migration 020 : Journal d'activité de l'agent (audit log)
--
-- Historique horodaté et permanent de toutes les actions effectuées par un agent au nom d'un
-- propriétaire (délégation). Contrairement aux colonnes effectue_par_agent_id (qui ne montrent
-- que l'état ACTUEL d'un bien/contrat/locataire), cette table garde une trace complète même si
-- la ressource est ensuite modifiée, résiliée ou supprimée, et même si la délégation est révoquée.

CREATE TABLE IF NOT EXISTS journal_activite_agent (
  id SERIAL PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES users(id),
  proprietaire_id UUID NOT NULL REFERENCES users(id),
  type_action VARCHAR(40) NOT NULL,
  description TEXT NOT NULL,
  reference_type VARCHAR(20),
  reference_id UUID,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journal_activite_agent_proprietaire ON journal_activite_agent(proprietaire_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_journal_activite_agent_agent ON journal_activite_agent(agent_id, created_at DESC);
