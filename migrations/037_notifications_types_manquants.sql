-- Découvert en testant l'intégration Mobile Money : une erreur serveur déclenche
-- utils/erreurs.js (type 'erreur_serveur'), qui échouait à son tour en tentant de créer sa
-- propre notification, ce type n'étant pas non plus dans la contrainte. Un audit complet de
-- tous les appels notifier({ type: ... }) du code montre que 5 types sont utilisés en réalité
-- mais absents de la contrainte (posée hors migration suivie, cf. 036) : escalade,
-- reassignation_agent, moderation, compte, erreur_serveur — chacune de ces catégories de
-- notification a donc toujours silencieusement échoué à se créer en base.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'info', 'demande', 'approbation', 'annulation', 'paiement', 'rappel_echeance',
    'escalade', 'reassignation_agent', 'moderation', 'compte', 'erreur_serveur'
  ));
