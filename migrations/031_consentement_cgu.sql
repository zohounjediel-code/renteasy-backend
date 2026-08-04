-- Migration 031 : consentement aux CGU / politique de confidentialité
--
-- cgu_acceptees_le trace QUAND la personne a explicitement accepté (case à cocher obligatoire,
-- jamais pré-cochée) — à l'inscription pour un propriétaire/locataire auto-inscrit, ou à
-- l'activation du compte pour un locataire invité (c'est là qu'il prend possession du compte et
-- choisit son mot de passe, pas au moment où le propriétaire l'a invité). Les comptes agent/admin
-- créés directement par un admin ne sont pas concernés par ce clic — ils opèrent dans un cadre
-- professionnel, pas un clickwrap consommateur.
ALTER TABLE users ADD COLUMN IF NOT EXISTS cgu_acceptees_le TIMESTAMP;
