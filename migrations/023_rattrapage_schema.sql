-- RATTRAPAGE DE SCHÉMA (bug #10) — migrations 002 à 016 et 018 introuvables dans ce projet.
--
-- ⚠️ IMPORTANT : je n'ai pas accès à ta vraie base de données. Tout ce qui suit est reconstruit
-- en épluchant chaque INSERT/SELECT/comparaison de valeur dans le code (colonnes utilisées,
-- valeurs de statut comparées, opérateurs JSON employés, etc.), PAS extrait d'un schéma réel.
-- Les types/tailles/valeurs par défaut sont donc des déductions raisonnables, pas des
-- certitudes. Si ta vraie base a DÉJÀ certaines de ces colonnes (ce qui est probable, sinon
-- l'app ne tournerait pas), tout est écrit en IF NOT EXISTS / IF EXISTS pour être rejouable
-- sans casser l'existant. Vérifie idéalement section par section avant d'exécuter en
-- production (ex: `\d+ nom_table` dans psql pour comparer avec ce qui existe déjà).

-- ============================================================
-- USERS
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS compte_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_activation VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS solde INTEGER NOT NULL DEFAULT 0;

-- La contrainte d'origine (role IN ('proprietaire','agent','admin')) ne permet ni 'locataire'
-- ni 'super_admin', ni les rôles cumulés stockés en chaîne séparée par virgules
-- (ex: 'proprietaire,locataire') pourtant utilisés partout dans le code. Une contrainte fiable
-- pour valider chaque valeur d'une chaîne cumulée est plus risquée à écrire à l'aveugle qu'à
-- laisser le contrôle à l'application (qui ne construit déjà que ces combinaisons connues) :
-- je supprime simplement la contrainte plutôt que d'en écrire une mal calibrée.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

-- ============================================================
-- LOCATAIRES (fiche contact, indépendante d'un compte de connexion)
-- ============================================================
ALTER TABLE locataires ADD COLUMN IF NOT EXISTS proprietaire_id UUID REFERENCES users(id);
ALTER TABLE locataires ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE locataires ADD COLUMN IF NOT EXISTS statut VARCHAR(20) NOT NULL DEFAULT 'en_attente';
ALTER TABLE locataires DROP CONSTRAINT IF EXISTS locataires_statut_check;
ALTER TABLE locataires ADD CONSTRAINT locataires_statut_check
  CHECK (statut IN ('en_attente', 'confirme', 'refuse'));

-- ============================================================
-- BIENS
-- ============================================================
ALTER TABLE biens ADD COLUMN IF NOT EXISTS type_loyer VARCHAR(20) NOT NULL DEFAULT 'mensuel';
ALTER TABLE biens ADD COLUMN IF NOT EXISTS tarifs JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE biens ADD COLUMN IF NOT EXISTS caracteristiques JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE biens ADD COLUMN IF NOT EXISTS photos JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE biens ADD COLUMN IF NOT EXISTS sur_le_marche BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE biens ADD COLUMN IF NOT EXISTS description_marche TEXT;
ALTER TABLE biens ADD COLUMN IF NOT EXISTS lieu_depot VARCHAR(255);

-- numero_bien : format confirmé par l'utilisateur — "BIEN-00008" (préfixe + numéro sur 5
-- chiffres avec zéros de tête), donc bien une chaîne formatée et non un entier brut (cohérent
-- avec le `.trim().toUpperCase()` appliqué dessus dans contratController.js, qui n'aurait aucun
-- sens sur un simple entier). Une séquence dédiée génère le numéro incrémental, formaté avec
-- LPAD. Si cette colonne existe déjà réellement (probable), cette ligne est ignorée sans effet.
CREATE SEQUENCE IF NOT EXISTS biens_numero_seq;

ALTER TABLE biens ADD COLUMN IF NOT EXISTS numero_bien VARCHAR(20) UNIQUE
  DEFAULT ('BIEN-' || LPAD(nextval('biens_numero_seq')::text, 5, '0'));

ALTER TABLE biens DROP CONSTRAINT IF EXISTS biens_type_bien_check;
ALTER TABLE biens ADD CONSTRAINT biens_type_bien_check
  CHECK (type_bien IN ('appartement', 'maison', 'studio', 'chambre', 'commerce', 'villa', 'vehicule'));

-- ============================================================
-- CONTRATS
-- ============================================================
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS type_loyer VARCHAR(20) NOT NULL DEFAULT 'mensuel';
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS duree_valeur INTEGER;
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS duree_unite VARCHAR(20);
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS signature_proprietaire TEXT;
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS signature_locataire TEXT;
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS date_signature_proprietaire TIMESTAMP;
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS date_signature_locataire TIMESTAMP;
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS jour_semaine_echeance INTEGER;
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS jour_echeance_annuel INTEGER;
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS mois_echeance_annuel INTEGER;
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS origine VARCHAR(30);
ALTER TABLE contrats ADD COLUMN IF NOT EXISTS note_locataire TEXT;

ALTER TABLE contrats DROP CONSTRAINT IF EXISTS contrats_type_loyer_check;
ALTER TABLE contrats ADD CONSTRAINT contrats_type_loyer_check
  CHECK (type_loyer IN ('journalier', 'hebdomadaire', 'mensuel', 'annuel'));

ALTER TABLE contrats DROP CONSTRAINT IF EXISTS contrats_duree_unite_check;
ALTER TABLE contrats ADD CONSTRAINT contrats_duree_unite_check
  CHECK (duree_unite IS NULL OR duree_unite IN ('jours', 'semaines', 'mois', 'annees'));

-- 'proprietaire' : valeur historique confirmée en base (SELECT origine, COUNT(*) FROM contrats
-- GROUP BY origine) — posée par une version antérieure de creerContrat, avant qu'un refactor
-- ne retire cette colonne de son INSERT (les contrats créés directement par un propriétaire/agent
-- ont aujourd'hui origine = NULL, mais les anciennes lignes 'proprietaire' restent en base et
-- doivent rester valides).
ALTER TABLE contrats DROP CONSTRAINT IF EXISTS contrats_origine_check;
ALTER TABLE contrats ADD CONSTRAINT contrats_origine_check
  CHECK (origine IS NULL OR origine IN ('locataire_location', 'locataire_reservation', 'proprietaire'));

-- Statuts intermédiaires du cycle de vie (signature en attente, demande venue du marché,
-- refusé) en plus des 3 valeurs d'origine (actif, resilie, expire).
ALTER TABLE contrats DROP CONSTRAINT IF EXISTS contrats_statut_check;
ALTER TABLE contrats ADD CONSTRAINT contrats_statut_check
  CHECK (statut IN ('actif', 'resilie', 'expire', 'en_attente_signature', 'demande_locataire', 'refuse'));

-- ============================================================
-- PAIEMENTS — élargir la méthode (solde interne RentEasy et Celtiis Pay)
-- ============================================================
ALTER TABLE paiements DROP CONSTRAINT IF EXISTS paiements_methode_check;
ALTER TABLE paiements ADD CONSTRAINT paiements_methode_check
  CHECK (methode IN ('mtn_momo', 'moov_money', 'especes', 'virement', 'solde_renteasy', 'celtiis_pay'));

-- ============================================================
-- MESSAGES (table de base — 017_contexte_messages.sql modifie déjà cette table sans la
-- créer, donc elle existe forcément quelque part ; recréée ici uniquement si absente)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  expediteur_id UUID NOT NULL REFERENCES users(id),
  destinataire_id UUID NOT NULL REFERENCES users(id),
  contenu TEXT NOT NULL,
  lu BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(expediteur_id, destinataire_id, created_at);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  titre VARCHAR(150) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(30),
  lien VARCHAR(255),
  lue BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);

-- ============================================================
-- DEMANDES_CONTRAT (résiliation / modification / fin de contrat)
-- ============================================================
CREATE TABLE IF NOT EXISTS demandes_contrat (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrat_id UUID NOT NULL REFERENCES contrats(id) ON DELETE CASCADE,
  proprietaire_id UUID NOT NULL REFERENCES users(id),
  agent_id UUID REFERENCES users(id),
  type_demande VARCHAR(20) NOT NULL CHECK (type_demande IN ('resiliation', 'modification', 'fin_contrat')),
  conditions_demandees JSONB,
  note_proprietaire TEXT,
  note_agent TEXT,
  statut VARCHAR(20) NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'approuvee', 'annulee')),
  initiee_par VARCHAR(20) NOT NULL DEFAULT 'proprietaire' CHECK (initiee_par IN ('proprietaire', 'locataire', 'systeme')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_demandes_contrat_contrat ON demandes_contrat(contrat_id);

-- ============================================================
-- TRANSACTIONS_SOLDE (recharge / retrait du solde RentEasy)
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions_solde (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type VARCHAR(20) NOT NULL CHECK (type IN ('recharge', 'retrait')),
  montant INTEGER NOT NULL,
  methode VARCHAR(20) NOT NULL CHECK (methode IN ('mtn_momo', 'moov_money', 'celtiis_pay')),
  telephone VARCHAR(20),
  reference_transaction VARCHAR(100),
  statut VARCHAR(20) NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours', 'reussi', 'echoue')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transactions_solde_user ON transactions_solde(user_id, created_at DESC);
