const pool = require('../config/database');
const { genererQuittancePDF } = require('../utils/quittance');
const { notifier, echapperHtml } = require('../utils/notifications');
const { enregistrerActionAgent } = require('../utils/journalAgent');
const { resoudreProprietaireConsulte } = require('../utils/delegationAgent');
const { obtenirTauxCommission } = require('../utils/parametres');

// Enregistrer un paiement sur une échéance
async function creerPaiement(req, res) {
  const { echeance_id, montant, methode, reference_transaction } = req.body;

  if (!echeance_id || montant === undefined || montant === null || !methode) {
    return res.status(400).json({ message: 'Champs obligatoires manquants (echeance_id, montant, methode)' });
  }

  // Validation stricte : "!montant" laisse passer un montant négatif (ex: -5000 est "truthy" en
  // JS), il faut vérifier explicitement que c'est un nombre fini et strictement positif.
  const montantNombre = Number(montant);
  if (!Number.isFinite(montantNombre) || montantNombre <= 0 || !Number.isInteger(montantNombre)) {
    return res.status(400).json({ message: 'Le montant doit être un nombre entier strictement positif' });
  }

  try {
    // Récupère l'échéance avec tout le contexte nécessaire (bien, locataire, propriétaire)
    const contexte = await pool.query(
      `SELECT e.*, c.bien_id, c.locataire_id, c.loyer_mensuel,
              b.adresse, b.ville, b.quartier, b.numero_bien, b.proprietaire_id,
              l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM echeances e
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE e.id = $1`,
      [echeance_id]
    );

    if (contexte.rows.length === 0) {
      return res.status(404).json({ message: 'Échéance non trouvée' });
    }

    const echeance = contexte.rows[0];

    // Si la requête vient d'un propriétaire, vérifier que c'est bien son bien
    if (req.user.role === 'proprietaire' && echeance.proprietaire_id !== req.user.id) {
      return res.status(403).json({ message: 'Accès non autorisé à cette échéance' });
    }

    // Garde anti-doublon n°1 : une référence de transaction externe (mobile money, virement...)
    // ne doit jamais être enregistrée deux fois — sinon un webhook ou un clic répété créerait
    // deux paiements pour la même transaction réelle.
    if (reference_transaction) {
      const doublonRef = await pool.query(
        `SELECT id FROM paiements WHERE reference_transaction = $1 AND statut = 'reussi'`,
        [reference_transaction]
      );
      if (doublonRef.rows.length > 0) {
        return res.status(409).json({ message: 'Cette référence de transaction a déjà été enregistrée' });
      }
    }

    // Garde anti-doublon n°2 : pour les paiements sans référence (espèces...), on refuse un
    // paiement identique (même échéance, montant, méthode) soumis dans les 30 dernières
    // secondes — protège contre un double-clic ou une double-soumission réseau.
    const doublonRecent = await pool.query(
      `SELECT id FROM paiements
       WHERE echeance_id = $1 AND montant = $2 AND methode = $3 AND statut = 'reussi'
         AND date_paiement > NOW() - INTERVAL '30 seconds'`,
      [echeance_id, montantNombre, methode]
    );
    if (doublonRecent.rows.length > 0) {
      return res.status(409).json({ message: 'Un paiement identique vient déjà d\'être enregistré il y a moins de 30 secondes' });
    }

    // Plafond : un paiement ne peut jamais dépasser ce qu'il reste réellement à payer sur
    // cette échéance (même logique que payerEcheanceSolde et le paiement mobile money).
    const totalPayeAvant = await pool.query(
      `SELECT COALESCE(SUM(montant), 0) AS total FROM paiements WHERE echeance_id = $1 AND statut = 'reussi'`,
      [echeance_id]
    );
    const dejaPaye = parseInt(totalPayeAvant.rows[0].total, 10);
    const reste = echeance.montant_du - dejaPaye;

    if (reste <= 0) {
      return res.status(409).json({ message: 'Cette échéance est déjà entièrement payée' });
    }
    if (montantNombre > reste) {
      return res.status(400).json({ message: `Le montant dépasse le reste dû (${reste.toLocaleString('fr-FR')} FCFA)` });
    }

    const tauxCommission = await obtenirTauxCommission();
    const commission = Math.round(montantNombre * tauxCommission);

    const resultatPaiement = await pool.query(
      `INSERT INTO paiements (echeance_id, montant, methode, reference_transaction, commission_renteasy, statut)
       VALUES ($1, $2, $3, $4, $5, 'reussi')
       RETURNING *`,
      [echeance_id, montantNombre, methode, reference_transaction || null, commission]
    );

    const paiement = resultatPaiement.rows[0];

    // Met à jour le statut de l'échéance selon le montant payé au total
    const totalPaye = await pool.query(
      `SELECT COALESCE(SUM(montant), 0) AS total FROM paiements WHERE echeance_id = $1 AND statut = 'reussi'`,
      [echeance_id]
    );
    const montantTotal = parseInt(totalPaye.rows[0].total, 10);

    let nouveauStatut = 'partielle';
    if (montantTotal >= echeance.montant_du) {
      nouveauStatut = 'payee';
    }

    await pool.query('UPDATE echeances SET statut = $1 WHERE id = $2', [nouveauStatut, echeance_id]);

    // Génère la quittance PDF
    const cheminQuittance = await genererQuittancePDF({
      paiement,
      echeance,
      bien: echeance,
      locataire: { nom: echeance.locataire_nom, telephone: echeance.locataire_telephone },
    });

    await pool.query('UPDATE paiements SET quittance_url = $1 WHERE id = $2', [cheminQuittance, paiement.id]);

    // Notifie le propriétaire, comme pour tout autre mode de paiement
    const proprietaireInfo = await pool.query('SELECT nom, email, telephone FROM users WHERE id = $1', [echeance.proprietaire_id]);
    if (proprietaireInfo.rows.length > 0) {
      await notifier({
        user_id: echeance.proprietaire_id,
        email: proprietaireInfo.rows[0].email,
        nom: proprietaireInfo.rows[0].nom,
        telephone: proprietaireInfo.rows[0].telephone,
        // Message SMS volontairement plus court que le message in-app/email — un SMS facturé au
        // caractère près ne doit contenir que l'essentiel (montant, bien, qui a payé).
        sms: `RentEasy : ${echeance.locataire_nom} a payé ${montantNombre.toLocaleString('fr-FR')} FCFA pour le bien ${echeance.numero_bien}.`,
        titre: nouveauStatut === 'payee' ? 'Loyer payé' : 'Paiement partiel reçu',
        message: `${echeance.locataire_nom} a payé ${montantNombre.toLocaleString('fr-FR')} FCFA (${methode}) pour le bien ${echeance.numero_bien}.`,
        type: 'paiement',
        lien: '/paiements',
        sujet_email: '[RentEasy] Paiement reçu',
        contenu_email: `
          <h2>Paiement reçu</h2>
          <p>Bonjour ${echapperHtml(proprietaireInfo.rows[0].nom)},</p>
          <p><strong>${echapperHtml(echeance.locataire_nom)}</strong> a payé <strong>${montantNombre.toLocaleString('fr-FR')} FCFA</strong> (${methode}) pour le bien ${echeance.numero_bien}.</p>
        `,
      });
    }

    // Si c'est un agent qui a enregistré ce paiement, on trace l'action pour la transparence
    // du propriétaire (journal d'activité de l'agent)
    const roles = (req.user.role || '').split(',').map(r => r.trim());
    if (roles.includes('agent')) {
      await enregistrerActionAgent({
        agent_id: req.user.id,
        proprietaire_id: echeance.proprietaire_id,
        type_action: 'enregistrement_paiement',
        description: `Enregistrement d'un paiement de ${montantNombre.toLocaleString('fr-FR')} FCFA (${methode}) reçu de ${echeance.locataire_nom} pour le bien ${echeance.numero_bien}`,
        reference_type: 'paiement',
        reference_id: paiement.id,
      });
    }

    return res.status(201).json({
      message: 'Paiement enregistré avec succès',
      paiement: { ...paiement, quittance_url: cheminQuittance },
      statut_echeance: nouveauStatut,
    });
  } catch (err) {
    console.error('Erreur création paiement :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de l\'enregistrement du paiement' });
  }
}

// Télécharger une quittance PDF
async function telechargerQuittance(req, res) {
  const { id } = req.params;
  const path = require('path');
  const fs = require('fs');

  try {
    const resultat = await pool.query('SELECT quittance_url FROM paiements WHERE id = $1', [id]);

    if (resultat.rows.length === 0 || !resultat.rows[0].quittance_url) {
      return res.status(404).json({ message: 'Quittance non trouvée' });
    }

    const cheminComplet = path.join(__dirname, '..', '..', resultat.rows[0].quittance_url);

    if (!fs.existsSync(cheminComplet)) {
      return res.status(404).json({ message: 'Fichier de quittance introuvable' });
    }

    return res.download(cheminComplet);
  } catch (err) {
    console.error('Erreur téléchargement quittance :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Lister les échéances impayées/en retard pour le propriétaire connecté (ou pour tout le
// portefeuille de l'agent, ou pour un propriétaire ciblé par un admin via ?proprietaire_id=...)
async function listerImpayes(req, res) {
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAgent = roles.includes('agent') && !roles.includes('proprietaire');
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const proprietaireIdCible = req.query.proprietaire_id;

  if (estAdmin && !proprietaireIdCible) {
    return res.status(400).json({ message: 'proprietaire_id requis pour une consultation admin' });
  }

  const idFiltre = estAdmin ? proprietaireIdCible : req.user.id;

  try {
    const resultat = await pool.query(
      `SELECT e.*, b.adresse, b.ville, b.numero_bien, l.nom AS locataire_nom, l.telephone AS locataire_telephone,
              e.montant_du - COALESCE((SELECT SUM(p.montant) FROM paiements p WHERE p.echeance_id = e.id AND p.statut = 'reussi'), 0) AS montant_restant
       FROM echeances e
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       JOIN users pr ON pr.id = b.proprietaire_id
       WHERE ${estAgent ? 'pr.agent_id = $1' : 'b.proprietaire_id = $1'}
         AND e.statut IN ('impayee', 'en_attente', 'partielle', 'en_recouvrement')
         AND e.date_limite < NOW()
       ORDER BY e.date_limite ASC`,
      [idFiltre]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste impayés :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Historique des paiements pour le propriétaire connecté (ou, pour un admin, du propriétaire
// ciblé via ?proprietaire_id=...)
async function listerPaiements(req, res) {
  const proprietaire_id = resoudreProprietaireConsulte(req);
  if (!proprietaire_id) {
    return res.status(400).json({ message: 'proprietaire_id requis pour une consultation admin' });
  }

  try {
    const resultat = await pool.query(
      `SELECT p.*, e.mois_concerne, b.adresse, l.nom AS locataire_nom
       FROM paiements p
       JOIN echeances e ON e.id = p.echeance_id
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE b.proprietaire_id = $1
       ORDER BY p.date_paiement DESC`,
      [proprietaire_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste paiements :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Le locataire (ou son agent, avec le solde de CE DERNIER) paie une échéance
// (totalement ou partiellement) depuis un solde RentEasy
async function payerEcheanceSolde(req, res) {
  const { id } = req.params;
  const user_id = req.user.id;
  const { montant } = req.body; // optionnel : si absent, paie le reste dû en totalité

  try {
    const contexte = await pool.query(
      `SELECT e.*, c.bien_id, c.locataire_id,
              b.proprietaire_id, b.adresse, b.ville, b.numero_bien,
              l.nom AS locataire_nom, l.telephone AS locataire_telephone, l.user_id AS locataire_user_id,
              pr.agent_id AS proprietaire_agent_id
       FROM echeances e
       JOIN contrats c ON c.id = e.contrat_id
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       JOIN users pr ON pr.id = b.proprietaire_id
       WHERE e.id = $1`,
      [id]
    );

    if (contexte.rows.length === 0) {
      return res.status(404).json({ message: 'Échéance non trouvée' });
    }

    const echeance = contexte.rows[0];

    const roles = (req.user.role || '').split(',').map(r => r.trim());
    const estLocataire = echeance.locataire_user_id === user_id;
    // L'agent doit être assigné au propriétaire du bien concerné pour pouvoir payer à sa place
    // (recouvrement terrain) — pas besoin de la délégation "gestion biens/contrats/locataires",
    // qui couvre un périmètre différent. L'admin a un accès de supervision inconditionnel.
    const estAdmin = roles.includes('admin') || roles.includes('super_admin');
    const estAgentAutorise = roles.includes('agent') && echeance.proprietaire_agent_id === user_id;

    if (!estLocataire && !estAgentAutorise && !estAdmin) {
      return res.status(403).json({ message: 'Accès non autorisé à cette échéance' });
    }
    const paye_par_agent_id = (estAgentAutorise || estAdmin) ? user_id : null;

    if (echeance.statut === 'payee') {
      return res.status(409).json({ message: 'Cette échéance est déjà payée' });
    }

    const totalPayeRes = await pool.query(
      `SELECT COALESCE(SUM(montant), 0) AS total FROM paiements WHERE echeance_id = $1 AND statut = 'reussi'`,
      [id]
    );
    const dejaPaye = parseInt(totalPayeRes.rows[0].total, 10);
    const reste = echeance.montant_du - dejaPaye;

    if (reste <= 0) {
      return res.status(409).json({ message: 'Cette échéance est déjà entièrement payée' });
    }

    const montantAPayer = montant ? parseInt(montant) : reste;

    if (!montantAPayer || montantAPayer <= 0) {
      return res.status(400).json({ message: 'Montant invalide' });
    }
    if (montantAPayer > reste) {
      return res.status(400).json({ message: `Le montant ne peut pas dépasser le reste à payer (${reste} FCFA)` });
    }

    const client = await pool.connect();
    let paiement, nouveauStatut;
    try {
      await client.query('BEGIN');

      const userRes = await client.query('SELECT solde FROM users WHERE id = $1 FOR UPDATE', [user_id]);
      const solde = userRes.rows[0].solde;

      if (solde < montantAPayer) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ message: `Solde insuffisant. Solde disponible : ${solde} FCFA` });
      }

      const superAdminRes = await client.query(
        "SELECT id FROM users WHERE role LIKE '%super_admin%' ORDER BY created_at ASC LIMIT 1"
      );
      if (superAdminRes.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(500).json({ message: 'Compte super admin introuvable, paiement impossible' });
      }
      const superAdminId = superAdminRes.rows[0].id;

      const tauxCommission = await obtenirTauxCommission();
      const commission = Math.round(montantAPayer * tauxCommission);
      const partProprietaire = montantAPayer - commission;

      await client.query('UPDATE users SET solde = solde - $1 WHERE id = $2', [montantAPayer, user_id]);
      await client.query('UPDATE users SET solde = solde + $1 WHERE id = $2', [partProprietaire, echeance.proprietaire_id]);
      await client.query('UPDATE users SET solde = solde + $1 WHERE id = $2', [commission, superAdminId]);

      const paiementRes = await client.query(
        `INSERT INTO paiements (echeance_id, montant, methode, commission_renteasy, statut, paye_par_agent_id)
         VALUES ($1, $2, 'solde_renteasy', $3, 'reussi', $4)
         RETURNING *`,
        [id, montantAPayer, commission, paye_par_agent_id]
      );
      paiement = paiementRes.rows[0];

      const nouveauTotalPaye = dejaPaye + montantAPayer;
      nouveauStatut = nouveauTotalPaye >= echeance.montant_du ? 'payee' : 'partielle';
      await client.query('UPDATE echeances SET statut = $1 WHERE id = $2', [nouveauStatut, id]);

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Génère la quittance PDF (hors transaction)
    try {
      const cheminQuittance = await genererQuittancePDF({
        paiement,
        echeance,
        bien: echeance,
        locataire: { nom: echeance.locataire_nom, telephone: echeance.locataire_telephone },
      });
      await pool.query('UPDATE paiements SET quittance_url = $1 WHERE id = $2', [cheminQuittance, paiement.id]);
      paiement.quittance_url = cheminQuittance;
    } catch (e) {
      console.error('Erreur génération quittance :', e);
    }

    // Notifie le propriétaire
    const proprietaireInfo = await pool.query('SELECT nom, email, telephone FROM users WHERE id = $1', [echeance.proprietaire_id]);
    const texteRegleur = paye_par_agent_id ? "Votre agent (pour le compte du locataire)" : echeance.locataire_nom;
    await notifier({
      user_id: echeance.proprietaire_id,
      email: proprietaireInfo.rows[0].email,
      nom: proprietaireInfo.rows[0].nom,
      telephone: proprietaireInfo.rows[0].telephone,
      sms: `RentEasy : ${texteRegleur} a payé ${montantAPayer.toLocaleString('fr-FR')} FCFA pour le bien ${echeance.numero_bien}.`,
      titre: nouveauStatut === 'payee' ? 'Loyer payé' : 'Paiement partiel reçu',
      message: `${texteRegleur} a payé ${montantAPayer.toLocaleString('fr-FR')} FCFA pour le bien ${echeance.numero_bien}.`,
      type: 'paiement',
      lien: '/paiements',
      sujet_email: '[RentEasy] Paiement reçu',
      contenu_email: `
        <h2>Paiement reçu</h2>
        <p>Bonjour ${echapperHtml(proprietaireInfo.rows[0].nom)},</p>
        <p><strong>${echapperHtml(texteRegleur)}</strong> a payé <strong>${montantAPayer.toLocaleString('fr-FR')} FCFA</strong> pour le bien ${echeance.numero_bien}.</p>
        <p>Statut de l'échéance : ${nouveauStatut === 'payee' ? 'Payée intégralement' : 'Partiellement payée'}.</p>
      `,
    });

    // Si c'est l'agent qui a réglé (avec son propre solde), on notifie le locataire (qui n'a
    // rien payé lui-même sur l'app) et on journalise l'action pour la traçabilité du propriétaire
    if (paye_par_agent_id) {
      if (echeance.locataire_user_id) {
        const agentInfo = await pool.query('SELECT nom FROM users WHERE id = $1', [paye_par_agent_id]);
        await notifier({
          user_id: echeance.locataire_user_id,
          nom: echeance.locataire_nom,
          titre: nouveauStatut === 'payee' ? 'Votre loyer a été réglé' : 'Paiement partiel enregistré',
          message: `${agentInfo.rows[0].nom} a réglé ${montantAPayer.toLocaleString('fr-FR')} FCFA pour votre échéance du bien ${echeance.numero_bien} (montant reçu sur le terrain).`,
          type: 'paiement',
          lien: '/locataire/dashboard',
        });
      }

      await enregistrerActionAgent({
        agent_id: paye_par_agent_id,
        proprietaire_id: echeance.proprietaire_id,
        type_action: nouveauStatut === 'payee' ? 'paiement_echeance' : 'paiement_partiel_echeance',
        description: `Paiement ${nouveauStatut === 'payee' ? 'total' : 'partiel'} de ${montantAPayer.toLocaleString('fr-FR')} FCFA avec son solde, pour le compte de ${echeance.locataire_nom} (bien ${echeance.numero_bien})`,
        reference_type: 'echeance',
        reference_id: echeance.id,
      });
    }

    return res.status(201).json({
      message: nouveauStatut === 'payee' ? 'Paiement effectué avec succès' : 'Paiement partiel effectué avec succès',
      paiement,
      statut_echeance: nouveauStatut,
    });
  } catch (err) {
    console.error('Erreur paiement solde :', err);
    // Si une réponse a déjà été envoyée (ex: succès suivi d'une erreur secondaire non bloquante),
    // ne JAMAIS retenter d'envoyer une réponse : cela provoque un crash ERR_HTTP_HEADERS_SENT
    // qui arrête tout le serveur Node.
    if (res.headersSent) return;
    return res.status(500).json({ message: 'Erreur serveur lors du paiement' });
  }
}

module.exports = { creerPaiement, telechargerQuittance, listerImpayes, listerPaiements, payerEcheanceSolde };
