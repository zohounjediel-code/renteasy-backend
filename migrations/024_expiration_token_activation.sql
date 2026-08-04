-- Bug #16 : le token d'invitation locataire n'avait aucune expiration réelle, alors que
-- l'email envoyé annonce explicitement "valable 7 jours". Colonne nullable, sans risque pour
-- les lignes existantes (une valeur NULL est traitée comme "pas de limite" côté code, donc les
-- comptes déjà invités avant cette migration ne sont pas bloqués rétroactivement).
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_expiration TIMESTAMP;
