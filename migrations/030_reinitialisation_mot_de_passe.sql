-- Migration 030 : réinitialisation de mot de passe
--
-- Distinct de token_activation (réservé aux comptes locataires invités, non encore activés) :
-- ce token sert à un compte DÉJÀ actif qui a oublié son mot de passe. Les deux flux ne doivent
-- jamais se marcher dessus, d'où des colonnes séparées plutôt qu'une réutilisation.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_reinitialisation VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_reinitialisation_expiration TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_users_token_reinitialisation ON users(token_reinitialisation) WHERE token_reinitialisation IS NOT NULL;
