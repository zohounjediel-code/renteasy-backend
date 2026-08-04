-- Migration 035 : monitoring d'erreurs serveur
--
-- Jusqu'ici, toute erreur serveur (500, exception non attrapée, rejet de promesse non géré)
-- finissait uniquement dans console.error — invisible une fois déployé, sauf à surveiller
-- activement les logs Railway en continu. Cette table centralise ces erreurs pour qu'elles
-- restent consultables après coup, et utils/erreurs.js les persiste ici en plus de les logger.
CREATE TABLE IF NOT EXISTS erreurs_serveur (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message TEXT NOT NULL,
  stack TEXT,
  methode VARCHAR(10),
  route VARCHAR(255),
  statut_http INTEGER,
  user_id UUID REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_erreurs_serveur_date ON erreurs_serveur(created_at DESC);
