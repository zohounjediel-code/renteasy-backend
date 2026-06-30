-- Migration initiale RentEasy Bénin
-- À exécuter dans la console PostgreSQL de Railway (comme pour OJADA BANK)

-- Extension pour générer des UUID
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Table des utilisateurs (propriétaires, agents, admins) - une seule table avec un rôle
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nom VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    telephone VARCHAR(20) UNIQUE NOT NULL,
    mot_de_passe_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('proprietaire', 'agent', 'admin')),
    ville VARCHAR(100),
    actif BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Table des biens immobiliers
CREATE TABLE IF NOT EXISTS biens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proprietaire_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    adresse VARCHAR(255) NOT NULL,
    ville VARCHAR(100) NOT NULL,
    quartier VARCHAR(100),
    type_bien VARCHAR(50) CHECK (type_bien IN ('appartement', 'maison', 'studio', 'chambre', 'commerce')),
    loyer_mensuel INTEGER NOT NULL,
    statut VARCHAR(20) DEFAULT 'libre' CHECK (statut IN ('libre', 'occupe')),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Table des locataires
CREATE TABLE IF NOT EXISTS locataires (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nom VARCHAR(150) NOT NULL,
    telephone VARCHAR(20) NOT NULL,
    email VARCHAR(150),
    numero_piece_identite VARCHAR(50),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Table des contrats de location (lie un bien à un locataire)
CREATE TABLE IF NOT EXISTS contrats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bien_id UUID NOT NULL REFERENCES biens(id) ON DELETE CASCADE,
    locataire_id UUID NOT NULL REFERENCES locataires(id) ON DELETE CASCADE,
    date_debut DATE NOT NULL,
    date_fin DATE,
    jour_echeance INTEGER NOT NULL DEFAULT 5 CHECK (jour_echeance BETWEEN 1 AND 28),
    loyer_mensuel INTEGER NOT NULL,
    caution INTEGER DEFAULT 0,
    statut VARCHAR(20) DEFAULT 'actif' CHECK (statut IN ('actif', 'resilie', 'expire')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Table des échéances de loyer (générées mensuellement pour chaque contrat actif)
CREATE TABLE IF NOT EXISTS echeances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contrat_id UUID NOT NULL REFERENCES contrats(id) ON DELETE CASCADE,
    mois_concerne DATE NOT NULL,
    montant_du INTEGER NOT NULL,
    date_limite DATE NOT NULL,
    statut VARCHAR(20) DEFAULT 'en_attente' CHECK (statut IN ('en_attente', 'payee', 'partielle', 'impayee', 'en_recouvrement')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Table des paiements
CREATE TABLE IF NOT EXISTS paiements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    echeance_id UUID NOT NULL REFERENCES echeances(id) ON DELETE CASCADE,
    montant INTEGER NOT NULL,
    methode VARCHAR(20) NOT NULL CHECK (methode IN ('mtn_momo', 'moov_money', 'especes', 'virement')),
    reference_transaction VARCHAR(100),
    commission_renteasy INTEGER NOT NULL,
    statut VARCHAR(20) DEFAULT 'en_cours' CHECK (statut IN ('en_cours', 'reussi', 'echoue')),
    date_paiement TIMESTAMP DEFAULT NOW(),
    quittance_url VARCHAR(255)
);

-- Table des interventions de recouvrement terrain
CREATE TABLE IF NOT EXISTS recouvrements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    echeance_id UUID NOT NULL REFERENCES echeances(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES users(id),
    date_intervention TIMESTAMP DEFAULT NOW(),
    type_action VARCHAR(30) CHECK (type_action IN ('appel', 'visite', 'mise_en_demeure', 'autre')),
    resultat VARCHAR(30) CHECK (resultat IN ('promesse_paiement', 'paiement_partiel', 'refus', 'absent', 'paiement_complet')),
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index utiles pour les requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_biens_proprietaire ON biens(proprietaire_id);
CREATE INDEX IF NOT EXISTS idx_contrats_bien ON contrats(bien_id);
CREATE INDEX IF NOT EXISTS idx_echeances_contrat ON echeances(contrat_id);
CREATE INDEX IF NOT EXISTS idx_echeances_statut ON echeances(statut);
CREATE INDEX IF NOT EXISTS idx_paiements_echeance ON paiements(echeance_id);
CREATE INDEX IF NOT EXISTS idx_recouvrements_agent ON recouvrements(agent_id);
