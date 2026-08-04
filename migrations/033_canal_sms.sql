-- Migration 033 : canal SMS
--
-- Réutilise exactement le même mécanisme que les opérateurs Mobile Money (parametres_operateurs,
-- migration 027) plutôt que d'inventer un système parallèle : mêmes garanties (clés masquées à
-- l'affichage, repli sur les variables d'environnement tant que rien n'est configuré en base,
-- activable/désactivable). "sms" est un opérateur comme un autre du point de vue du stockage.
ALTER TABLE parametres_operateurs DROP CONSTRAINT IF EXISTS parametres_operateurs_operateur_check;
ALTER TABLE parametres_operateurs ADD CONSTRAINT parametres_operateurs_operateur_check
  CHECK (operateur IN ('mtn', 'moov', 'celtiis', 'sms'));

INSERT INTO parametres_operateurs (operateur, cles) VALUES ('sms', '{}')
ON CONFLICT (operateur) DO NOTHING;
