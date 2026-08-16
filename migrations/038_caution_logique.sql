-- Logique de caution : montant retenu par contrat, alimenté uniquement depuis le solde du
-- locataire, consommé automatiquement en cas de loyer impayé, transféré au solde principal du
-- locataire à la fin du contrat.

ALTER TABLE contrats ADD COLUMN caution_solde INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contrats ADD COLUMN statut_caution VARCHAR(20) NOT NULL DEFAULT 'non_requise';
ALTER TABLE contrats ADD CONSTRAINT contrats_statut_caution_check
  CHECK (statut_caution IN ('non_requise', 'en_attente', 'payee', 'transferee'));

-- Évite de renvoyer l'alerte "caution faible" à chaque passage du cron une fois qu'elle est déjà
-- descendue sous le seuil : un seul envoi tant que le solde ne remonte pas au-dessus.
ALTER TABLE contrats ADD COLUMN alerte_caution_envoyee BOOLEAN NOT NULL DEFAULT false;

-- Autorise 'caution' comme méthode de paiement : un loyer impayé peut désormais être couvert
-- automatiquement par la caution du contrat, au même titre qu'un paiement classique.
ALTER TABLE paiements DROP CONSTRAINT paiements_methode_check;
ALTER TABLE paiements ADD CONSTRAINT paiements_methode_check
  CHECK (methode IN ('mtn_momo', 'moov_money', 'especes', 'virement', 'solde_renteasy', 'celtiis_pay', 'caution'));

-- Journal des mouvements de caution (paiement par le locataire, déduction pour loyer impayé,
-- transfert final vers le solde principal) — sert à afficher un historique lisible.
CREATE TABLE caution_mouvements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contrat_id UUID NOT NULL REFERENCES contrats(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('paiement', 'deduction', 'transfert')),
  montant INTEGER NOT NULL,
  echeance_id UUID REFERENCES echeances(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_caution_mouvements_contrat ON caution_mouvements(contrat_id);
