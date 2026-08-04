-- Migration 032 : signalement d'annonce par les utilisateurs
--
-- Distinct de la modération admin-initiée (biens.moderation_masque, migration 028) : ici,
-- n'importe quel utilisateur connecté qui tombe sur une annonce suspecte peut la signaler,
-- sans attendre qu'un super admin la découvre par hasard. Le signalement ne masque rien tout
-- seul (statut 'en_attente') — c'est toujours un super admin qui décide, depuis la file de
-- modération, de masquer l'annonce (via l'action existante) ou de rejeter le signalement.
CREATE TABLE IF NOT EXISTS signalements_annonces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bien_id UUID NOT NULL REFERENCES biens(id) ON DELETE CASCADE,
  signale_par UUID NOT NULL REFERENCES users(id),
  motif VARCHAR(50) NOT NULL CHECK (motif IN (
    'photos_non_conformes', 'coordonnees_trompeuses', 'annonce_en_double',
    'bien_indisponible', 'contenu_inapproprie', 'autre'
  )),
  description TEXT,
  statut VARCHAR(20) NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'traite', 'rejete')),
  traite_par UUID REFERENCES users(id),
  traite_le TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_signalements_statut ON signalements_annonces(statut, created_at DESC);
