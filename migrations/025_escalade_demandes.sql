-- Nouvelle fonctionnalité : escalade des demandes bloquées. Une demande 'en_attente' depuis
-- plus de 3 jours (voir SEUIL_ESCALADE_JOURS dans demandeController.js) sans traitement par
-- l'agent assigné est marquée escaladee = true et notifie les admin/super_admin.
ALTER TABLE demandes_contrat ADD COLUMN IF NOT EXISTS escaladee BOOLEAN NOT NULL DEFAULT false;
