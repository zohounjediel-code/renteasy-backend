-- Migration 027 : paramètres de plateforme configurables (au lieu de codés en dur)
--
-- parametres_plateforme : réglages simples clé/valeur (taux de commission pour commencer,
-- extensible à d'autres réglages plus tard sans nouvelle migration).
CREATE TABLE IF NOT EXISTS parametres_plateforme (
  cle VARCHAR(100) PRIMARY KEY,
  valeur TEXT NOT NULL,
  description VARCHAR(255),
  modifie_par UUID REFERENCES users(id),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO parametres_plateforme (cle, valeur, description) VALUES
  ('taux_commission', '0.05', 'Taux de commission RentEasy prélevé sur chaque paiement de loyer (ex : 0.05 = 5%)')
ON CONFLICT (cle) DO NOTHING;

-- parametres_operateurs : clés API Mobile Money par opérateur, gérées depuis la page Paramètres
-- au lieu d'être exclusivement dans les variables d'environnement. "cles" est un JSON dont les
-- champs varient selon l'opérateur (ex : subscription_key/api_user/api_key pour MTN,
-- base_url/api_key/api_secret pour Moov et Celtiis). Une clé absente ou vide continue de
-- retomber sur la variable d'environnement correspondante (cf. utils/parametres.js) — remplir
-- cette table n'est donc pas obligatoire pour que l'existant continue de fonctionner.
CREATE TABLE IF NOT EXISTS parametres_operateurs (
  operateur VARCHAR(20) PRIMARY KEY CHECK (operateur IN ('mtn', 'moov', 'celtiis')),
  actif BOOLEAN NOT NULL DEFAULT false,
  cles JSONB NOT NULL DEFAULT '{}',
  modifie_par UUID REFERENCES users(id),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

INSERT INTO parametres_operateurs (operateur, cles) VALUES
  ('mtn', '{}'),
  ('moov', '{}'),
  ('celtiis', '{}')
ON CONFLICT (operateur) DO NOTHING;
