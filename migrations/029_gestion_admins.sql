-- Migration 029 : gestion fine des admins — rétrogradation/désactivation avec réassignation
--
-- Il n'existait jusqu'ici AUCUN lien entre un agent et l'admin qui le supervise (tous les admins
-- voient et gèrent tous les agents sans distinction). Pour pouvoir réassigner "les agents d'un
-- admin" quand celui-ci est rétrogradé ou désactivé, il faut d'abord ce lien : gere_par_admin_id
-- retient qui a créé/supervise chaque agent (rempli à la création du compte agent, cf.
-- authController.js). Nullable : un agent existant avant cette migration n'est rattaché à
-- personne tant qu'un super admin ne l'a pas explicitement réassigné.
ALTER TABLE users ADD COLUMN IF NOT EXISTS gere_par_admin_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_users_gere_par_admin ON users(gere_par_admin_id) WHERE gere_par_admin_id IS NOT NULL;
