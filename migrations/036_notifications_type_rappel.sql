-- La contrainte notifications_type_check (ajoutée hors migration suivie, directement en base)
-- n'autorisait pas le type 'rappel_echeance' utilisé par les rappels d'échéances automatiques
-- (avant_3j, jour_j, retard_3j, retard_7j) : chaque tentative d'insertion échouait en silence
-- (erreur journalisée mais non bloquante), donc aucune notification in-app de rappel n'était
-- jamais créée pour les locataires ni les propriétaires.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('info', 'demande', 'approbation', 'annulation', 'paiement', 'rappel_echeance'));
