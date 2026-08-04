const pool = require('../config/database');
const { creerEcheancesPourContrat, calculerEcheanceDepuisDebut } = require('../utils/echeances');
const { genererContratPDF } = require('../utils/contratPDF');
const { notifier, echapperHtml } = require('../utils/notifications');
const { resoudreCibleAction, estAutoriseSurProprietaire, resoudreProprietaireConsulte } = require('../utils/delegationAgent');
const { enregistrerActionAgent } = require('../utils/journalAgent');

const UNITES_INTERVAL = { jours: 'days', semaines: 'weeks', mois: 'months', annees: 'years' };

// Vérifie qu'une période [date_debut, date_fin] n'entre pas en collision avec un contrat
// déjà en cours, en attente de signature ou en demande sur le même bien.
// date_fin peut être null (durée indéterminée = occupe le bien indéfiniment à partir de date_debut)
async function verifierCollision(bien_id, date_debut, date_fin, excluContratId = null) {
  const resultat = await pool.query(
    `SELECT c.id, c.date_debut, c.date_fin, c.statut
     FROM contrats c
     WHERE c.bien_id = $1
       AND c.statut IN ('demande_locataire', 'en_attente_signature', 'actif')
       AND ($4::uuid IS NULL OR c.id != $4)
       AND c.date_debut <= COALESCE($3::date, 'infinity'::date)
       AND COALESCE(c.date_fin, 'infinity'::date) >= $2::date`,
    [bien_id, date_debut, date_fin, excluContratId]
  );
  return resultat.rows;
}

function calculerDateFin(date_debut, duree_valeur, duree_unite) {
  if (!duree_valeur || !UNITES_INTERVAL[duree_unite]) return null;
  const d = new Date(date_debut);
  const val = parseInt(duree_valeur);
  if (duree_unite === 'jours') d.setDate(d.getDate() + val);
  else if (duree_unite === 'semaines') d.setDate(d.getDate() + val * 7);
  else if (duree_unite === 'mois') d.setMonth(d.getMonth() + val);
  else if (duree_unite === 'annees') d.setFullYear(d.getFullYear() + val);
  return d.toISOString().slice(0, 10);
}


// Créer un contrat : le propriétaire le signe électroniquement (ou son agent en délégation),
// le locataire doit ensuite le signer à son tour
async function creerContrat(req, res) {
  const { numero_bien, locataire_id, date_debut, type_loyer, loyer_mensuel, caution, duree_valeur, duree_unite, signature_proprietaire } = req.body;
  // L'échéance suit toujours la date de début du contrat, elle n'est jamais choisie manuellement.
  const { jour_echeance, jour_semaine_echeance, jour_echeance_annuel, mois_echeance_annuel } = calculerEcheanceDepuisDebut(date_debut, type_loyer);

  const cible = await resoudreCibleAction(req);
  if (!cible) {
    return res.status(403).json({ message: "Vous n'êtes pas autorisé à créer un contrat pour ce propriétaire" });
  }
  const { proprietaire_id, effectue_par_agent_id } = cible;

  if (!numero_bien || !locataire_id || !date_debut || !type_loyer || !loyer_mensuel) {
    return res.status(400).json({ message: 'Champs obligatoires manquants (numero_bien, locataire_id, date_debut, type_loyer, loyer_mensuel)' });
  }
  if (!signature_proprietaire || !signature_proprietaire.trim()) {
    return res.status(400).json({
      message: effectue_par_agent_id
        ? 'Vous devez signer électroniquement le contrat pour le compte du propriétaire (saisissez votre nom complet)'
        : 'Vous devez signer électroniquement le contrat (saisissez votre nom complet)',
    });
  }

  try {
    // Vérifie que le bien appartient bien au propriétaire connecté
    const bien = await pool.query(
      'SELECT * FROM biens WHERE numero_bien = $1 AND proprietaire_id = $2',
      [numero_bien.trim().toUpperCase(), proprietaire_id]
    );
    if (bien.rows.length === 0) {
      return res.status(404).json({ message: "Aucun bien avec ce numéro n'a été trouvé dans votre liste" });
    }
    const bien_id = bien.rows[0].id;

    if (bien.rows[0].statut !== 'libre') {
      return res.status(409).json({ message: 'Ce bien n\'est pas libre (déjà occupé)' });
    }

    // Vérifie que le type de loyer choisi correspond bien à un tarif proposé pour ce bien
    const tarifs = bien.rows[0].tarifs || {};
    if (Object.keys(tarifs).length > 0 && !tarifs[type_loyer]) {
      return res.status(400).json({ message: `Ce bien ne propose pas de loyer "${type_loyer}". Périodicités disponibles : ${Object.keys(tarifs).join(', ')}` });
    }

    // Vérifie que le locataire appartient bien au propriétaire et que la liaison est confirmée
    const locataire = await pool.query(
      "SELECT id, nom, email, user_id, statut FROM locataires WHERE id = $1 AND proprietaire_id = $2",
      [locataire_id, proprietaire_id]
    );
    if (locataire.rows.length === 0) {
      return res.status(404).json({ message: 'Locataire non trouvé dans votre liste' });
    }
    if (locataire.rows[0].statut !== 'confirme') {
      return res.status(409).json({ message: "Ce locataire n'a pas encore accepté votre demande d'ajout" });
    }

    // Vérifie qu'il n'y a pas de collision avec un contrat existant sur ce bien
    const dateFinCalculee = calculerDateFin(date_debut, duree_valeur, duree_unite);
    const collisions = await verifierCollision(bien_id, date_debut, dateFinCalculee);
    if (collisions.length > 0) {
      return res.status(409).json({
        message: `Ce bien est déjà réservé/occupé sur cette période (du ${collisions[0].date_debut} au ${collisions[0].date_fin || 'indéterminé'})`,
      });
    }

    const dureeValide = duree_valeur && parseInt(duree_valeur) > 0 ? parseInt(duree_valeur) : null;

    if (dureeValide && !UNITES_INTERVAL[duree_unite]) {
      return res.status(400).json({ message: "Unité de durée invalide. Utilisez : jours, semaines, mois ou annees" });
    }
    const uniteValide = dureeValide ? duree_unite : null;
    const intervalPg = dureeValide ? `${dureeValide} ${UNITES_INTERVAL[duree_unite]}` : null;

    const resultatContrat = await pool.query(
      `INSERT INTO contrats (bien_id, locataire_id, date_debut, date_fin, jour_echeance, jour_semaine_echeance, jour_echeance_annuel, mois_echeance_annuel, type_loyer, loyer_mensuel, caution, duree_valeur, duree_unite, statut, signature_proprietaire, date_signature_proprietaire, effectue_par_agent_id)
       VALUES ($1, $2, $3, CASE WHEN $9::text IS NULL THEN NULL ELSE ($3::date + $9::interval)::date END, $4, $12, $13, $14, $5, $6, $7, $10, $11, 'en_attente_signature', $8, NOW(), $15)
       RETURNING *`,
      [bien_id, locataire_id, date_debut, jour_echeance || 5, type_loyer, loyer_mensuel, caution || 0, signature_proprietaire.trim(), intervalPg, dureeValide, uniteValide, jour_semaine_echeance ?? null, jour_echeance_annuel ?? null, mois_echeance_annuel ?? null, effectue_par_agent_id]
    );

    const contrat = resultatContrat.rows[0];
    const proprietaireInfo = await pool.query('SELECT nom FROM users WHERE id = $1', [proprietaire_id]);
    const nomProprietaire = echapperHtml(proprietaireInfo.rows[0].nom);

    // Si le contrat a été créé par un agent en délégation, on le précise dans la notification
    // et le message de retour, pour que tout le monde sache qui a réellement agi.
    let nomSignataire = nomProprietaire;
    if (effectue_par_agent_id) {
      const agentInfo = await pool.query('SELECT nom FROM users WHERE id = $1', [effectue_par_agent_id]);
      nomSignataire = `${echapperHtml(agentInfo.rows[0].nom)} (agent de ${nomProprietaire})`;

      await enregistrerActionAgent({
        agent_id: effectue_par_agent_id,
        proprietaire_id,
        type_action: 'creation_contrat',
        description: `Création et signature du contrat pour le bien ${bien.rows[0].numero_bien} (locataire : ${locataire.rows[0].nom})`,
        reference_type: 'contrat',
        reference_id: contrat.id,
      });
    }

    // Notifie le locataire : le contrat attend sa signature pour être officiellement validé
    if (locataire.rows[0].user_id) {
      await notifier({
        user_id: locataire.rows[0].user_id,
        email: locataire.rows[0].email,
        nom: locataire.rows[0].nom,
        titre: 'Nouveau contrat à signer',
        message: `${nomSignataire} a créé et signé un contrat de location pour le bien ${bien.rows[0].numero_bien}. Rendez-vous sur votre espace pour le signer et le valider.`,
        type: 'demande',
        lien: '/locataire/dashboard',
        sujet_email: '[RentEasy] Un contrat attend votre signature',
        contenu_email: `
          <h2>Contrat à signer</h2>
          <p>Bonjour ${echapperHtml(locataire.rows[0].nom)},</p>
          <p><strong>${nomSignataire}</strong> a créé et signé électroniquement un contrat de location pour vous.</p>
          <p>Connectez-vous à votre espace locataire pour le consulter et le signer à votre tour. Le contrat ne sera officiellement validé qu'après votre signature.</p>
        `,
      });
    }

    // Notifie aussi le propriétaire si c'est son agent qui a agi en son nom, pour transparence
    if (effectue_par_agent_id) {
      await notifier({
        user_id: proprietaire_id,
        titre: 'Contrat créé par votre agent',
        message: `Votre agent a créé et signé en votre nom un contrat pour le bien ${bien.rows[0].numero_bien}. Il attend maintenant la signature du locataire.`,
        type: 'info',
        lien: '/locataires',
      });
    }

    return res.status(201).json({
      message: effectue_par_agent_id
        ? 'Contrat signé pour le compte du propriétaire et envoyé au locataire. Il sera officiellement validé après sa signature.'
        : 'Contrat signé et envoyé au locataire. Il sera officiellement validé après sa signature.',
      contrat,
    });
  } catch (err) {
    console.error('Erreur création contrat :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la création du contrat' });
  }
}

// Lister les contrats du propriétaire connecté (ou, pour un admin, du propriétaire ciblé via
// ?proprietaire_id=... — un admin n'est propriétaire d'aucun contrat lui-même)
async function listerContrats(req, res) {
  const proprietaire_id = resoudreProprietaireConsulte(req);
  if (!proprietaire_id) {
    return res.status(400).json({ message: 'proprietaire_id requis pour une consultation admin' });
  }

  try {
    const resultat = await pool.query(
      `SELECT c.*, b.numero_bien, b.adresse, b.ville, l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE b.proprietaire_id = $1
       ORDER BY c.created_at DESC`,
      [proprietaire_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste contrats :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la récupération des contrats' });
  }
}

// Détail d'un contrat avec ses échéances (un admin peut consulter n'importe quel contrat)
async function obtenirContrat(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');

  try {
    const contrat = await pool.query(
      `SELECT c.*, b.numero_bien, b.adresse, b.ville, b.photos, b.proprietaire_id, l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE c.id = $1`,
      [id]
    );

    if (contrat.rows.length === 0 || (!estAdmin && contrat.rows[0].proprietaire_id !== req.user.id)) {
      return res.status(404).json({ message: 'Contrat non trouvé' });
    }

    const echeances = await pool.query(
      'SELECT * FROM echeances WHERE contrat_id = $1 ORDER BY mois_concerne ASC',
      [id]
    );

    return res.json({ ...contrat.rows[0], echeances: echeances.rows });
  } catch (err) {
    console.error('Erreur détail contrat :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Résilier un contrat
async function resilierContrat(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');

  try {
    const contrat = await pool.query(
      `SELECT c.*, b.proprietaire_id FROM contrats c JOIN biens b ON b.id = c.bien_id WHERE c.id = $1`,
      [id]
    );

    if (contrat.rows.length === 0 || (!estAdmin && contrat.rows[0].proprietaire_id !== req.user.id)) {
      return res.status(404).json({ message: 'Contrat non trouvé' });
    }

    await pool.query("UPDATE contrats SET statut = 'resilie' WHERE id = $1", [id]);
    await pool.query("UPDATE biens SET statut = 'libre', updated_at = NOW() WHERE id = $1", [contrat.rows[0].bien_id]);

    // Supprime les échéances futures pas encore dues (le locataire ne les doit plus une fois parti).
    // Les échéances déjà passées, même impayées ou partielles, restent pour être recouvrées.
    await pool.query(
      "DELETE FROM echeances WHERE contrat_id = $1 AND statut = 'en_attente' AND date_limite > CURRENT_DATE",
      [id]
    );

    return res.json({ message: 'Contrat résilié avec succès' });
  } catch (err) {
    console.error('Erreur résiliation contrat :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la résiliation' });
  }
}

// Télécharger le PDF d'un contrat
async function telechargerContratPDF(req, res) {
  const { id } = req.params;
  const path = require('path');
  const fs = require('fs');

  try {
    const contrat = await pool.query(
      `SELECT c.*, b.adresse, b.ville, b.quartier, b.type_bien, b.proprietaire_id,
              l.nom AS locataire_nom, l.telephone AS locataire_telephone,
              l.email AS locataire_email, l.numero_piece_identite,
              p.nom AS proprietaire_nom, p.email AS proprietaire_email, p.telephone AS proprietaire_telephone
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       JOIN users p ON p.id = b.proprietaire_id
       WHERE c.id = $1`,
      [id]
    );

    if (contrat.rows.length === 0) {
      return res.status(404).json({ message: 'Contrat non trouvé' });
    }

    const c = contrat.rows[0];

    if (req.user.role === 'proprietaire' && c.proprietaire_id !== req.user.id) {
      return res.status(403).json({ message: 'Accès non autorisé' });
    }
    if (req.user.role === 'locataire') {
      const appartientAuLocataire = await pool.query(
        'SELECT 1 FROM locataires WHERE id = $1 AND user_id = $2',
        [c.locataire_id, req.user.id]
      );
      if (appartientAuLocataire.rows.length === 0) {
        return res.status(403).json({ message: 'Accès non autorisé' });
      }
    }

    const cheminPDF = await genererContratPDF({
      contrat: c,
      bien: { adresse: c.adresse, ville: c.ville, quartier: c.quartier, type_bien: c.type_bien },
      locataire: { nom: c.locataire_nom, telephone: c.locataire_telephone, email: c.locataire_email, numero_piece_identite: c.numero_piece_identite },
      proprietaire: { nom: c.proprietaire_nom, email: c.proprietaire_email, telephone: c.proprietaire_telephone },
    });

    const cheminComplet = path.join(__dirname, '..', '..', cheminPDF);
    return res.download(cheminComplet);
  } catch (err) {
    console.error('Erreur PDF contrat :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Le locataire soumet une demande de réservation ou de location directe depuis le marché
async function demanderLocationMarche(req, res) {
  const user_id = req.user.id;
  const { bien_id, date_debut, duree_valeur, duree_unite, type_loyer, note } = req.body;
  // L'échéance suit toujours la date de début du contrat, elle n'est jamais choisie manuellement.
  const { jour_echeance, jour_semaine_echeance, jour_echeance_annuel, mois_echeance_annuel } = calculerEcheanceDepuisDebut(date_debut, type_loyer);
  const origine = req.body.origine === 'location' ? 'locataire_location' : 'locataire_reservation';

  if (!bien_id || !date_debut || !type_loyer) {
    return res.status(400).json({ message: 'Champs obligatoires manquants (bien_id, date_debut, type_loyer)' });
  }

  try {
    const bien = await pool.query(
      `SELECT b.*, p.nom AS proprietaire_nom, p.email AS proprietaire_email, p.agent_id
       FROM biens b JOIN users p ON p.id = b.proprietaire_id
       WHERE b.id = $1`,
      [bien_id]
    );
    if (bien.rows.length === 0) {
      return res.status(404).json({ message: 'Bien non trouvé' });
    }
    const b = bien.rows[0];

    if (!b.sur_le_marche || b.statut !== 'libre') {
      return res.status(409).json({ message: "Ce bien n'est plus disponible sur le marché" });
    }

    const tarifs = b.tarifs || {};
    if (Object.keys(tarifs).length > 0 && !tarifs[type_loyer]) {
      return res.status(400).json({ message: `Ce bien ne propose pas de loyer "${type_loyer}". Périodicités disponibles : ${Object.keys(tarifs).join(', ')}` });
    }
    const loyer_mensuel = tarifs[type_loyer] || b.loyer_mensuel;

    const dateFinCalculee = calculerDateFin(date_debut, duree_valeur, duree_unite);
    const collisions = await verifierCollision(bien_id, date_debut, dateFinCalculee);
    if (collisions.length > 0) {
      return res.status(409).json({
        message: `Ce bien est déjà réservé sur cette période (du ${collisions[0].date_debut} au ${collisions[0].date_fin || 'indéterminé'}). Choisissez d'autres dates.`,
      });
    }

    // Récupère ou crée l'entrée locataire pour ce propriétaire (le locataire a déjà un compte)
    const utilisateur = await pool.query('SELECT nom, email, telephone FROM users WHERE id = $1', [user_id]);
    const u = utilisateur.rows[0];

    let locataire = await pool.query(
      "SELECT id FROM locataires WHERE proprietaire_id = $1 AND user_id = $2 AND statut != 'refuse'",
      [b.proprietaire_id, user_id]
    );
    let locataire_id;
    if (locataire.rows.length > 0) {
      locataire_id = locataire.rows[0].id;
    } else {
      const nouveauLocataire = await pool.query(
        `INSERT INTO locataires (nom, telephone, email, proprietaire_id, user_id, statut)
         VALUES ($1, $2, $3, $4, $5, 'confirme') RETURNING id`,
        [u.nom, u.telephone, u.email, b.proprietaire_id, user_id]
      );
      locataire_id = nouveauLocataire.rows[0].id;
    }

    const dureeValide = duree_valeur && parseInt(duree_valeur) > 0 ? parseInt(duree_valeur) : null;
    const uniteValide = dureeValide ? duree_unite : null;

    const resultatContrat = await pool.query(
      `INSERT INTO contrats (bien_id, locataire_id, date_debut, date_fin, type_loyer, loyer_mensuel, duree_valeur, duree_unite, jour_echeance, jour_semaine_echeance, jour_echeance_annuel, mois_echeance_annuel, statut, origine, note_locataire)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $11, $12, $13, $14, 'demande_locataire', $9, $10)
       RETURNING *`,
      [bien_id, locataire_id, date_debut, dateFinCalculee, type_loyer, loyer_mensuel, dureeValide, uniteValide, origine, note || null, jour_echeance || 5, jour_semaine_echeance ?? null, jour_echeance_annuel ?? null, mois_echeance_annuel ?? null]
    );

    const libelle = origine === 'locataire_location' ? 'de location' : 'de réservation';

    await notifier({
      user_id: b.proprietaire_id,
      email: b.proprietaire_email,
      nom: b.proprietaire_nom,
      titre: `Nouvelle demande ${libelle}`,
      message: `${u.nom} a soumis une demande ${libelle} pour le bien ${b.numero_bien} (du ${date_debut}${dateFinCalculee ? ` au ${dateFinCalculee}` : ''}).`,
      type: 'demande',
      lien: '/biens',
      sujet_email: `[RentEasy] Nouvelle demande ${libelle} — ${b.numero_bien}`,
      contenu_email: `
        <h2>Nouvelle demande ${libelle}</h2>
        <p>Bonjour ${echapperHtml(b.proprietaire_nom)},</p>
        <p><strong>${echapperHtml(u.nom)}</strong> (${echapperHtml(u.telephone)}) souhaite ${origine === 'locataire_location' ? 'louer' : 'réserver'} votre bien <strong>${b.numero_bien}</strong>.</p>
        <p>Période demandée : du ${date_debut}${dateFinCalculee ? ` au ${dateFinCalculee}` : ' (durée indéterminée)'}</p>
        ${note ? `<p>Message du locataire : ${echapperHtml(note)}</p>` : ''}
        <p>Connectez-vous à RentEasy Bénin pour approuver ou refuser cette demande.</p>
      `,
    });

    if (b.agent_id) {
      const agent = await pool.query('SELECT nom, email FROM users WHERE id = $1', [b.agent_id]);
      if (agent.rows.length > 0) {
        await notifier({
          user_id: b.agent_id,
          email: agent.rows[0].email,
          nom: agent.rows[0].nom,
          titre: `Nouvelle demande ${libelle} (info)`,
          message: `${u.nom} a soumis une demande ${libelle} pour le bien ${b.numero_bien} de ${b.proprietaire_nom}.`,
          type: 'demande',
        });
      }
    }

    return res.status(201).json({
      message: `Demande ${libelle} envoyée au propriétaire et à son agent.`,
      contrat: resultatContrat.rows[0],
    });
  } catch (err) {
    console.error('Erreur demande location marché :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Lister les demandes de réservation/location en attente reçues par le propriétaire
async function listerDemandesLocataireProprio(req, res) {
  const proprietaire_id = resoudreProprietaireConsulte(req);
  if (!proprietaire_id) {
    return res.status(400).json({ message: 'proprietaire_id requis pour une consultation admin' });
  }
  try {
    const resultat = await pool.query(
      `SELECT c.*, b.numero_bien, b.adresse, b.ville, l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE b.proprietaire_id = $1 AND c.statut = 'demande_locataire'
       ORDER BY c.created_at DESC`,
      [proprietaire_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste demandes locataire :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Le propriétaire (ou son agent en délégation) approuve et signe la demande :
// elle attend maintenant la signature du locataire
async function approuverDemandeLocataire(req, res) {
  const { id } = req.params;
  const { signature_proprietaire } = req.body;

  if (!signature_proprietaire || !signature_proprietaire.trim()) {
    return res.status(400).json({ message: 'Vous devez signer électroniquement pour approuver cette demande' });
  }

  try {
    const contrat = await pool.query(
      `SELECT c.*, b.numero_bien, b.proprietaire_id, l.nom AS locataire_nom, l.email AS locataire_email, l.user_id AS locataire_user_id
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE c.id = $1 AND c.statut = 'demande_locataire'`,
      [id]
    );
    if (contrat.rows.length === 0) {
      return res.status(404).json({ message: 'Demande non trouvée ou déjà traitée' });
    }
    const c = contrat.rows[0];

    const roles = (req.user.role || '').split(',').map(r => r.trim());
    const estAutorise = await estAutoriseSurProprietaire(req, c.proprietaire_id);
    if (!estAutorise) {
      return res.status(403).json({ message: "Vous n'êtes pas autorisé à traiter cette demande" });
    }
    const effectue_par_agent_id = roles.includes('agent') && req.user.id !== c.proprietaire_id ? req.user.id : null;

    // Re-vérifie qu'aucune collision n'est apparue entre-temps
    const collisions = await verifierCollision(c.bien_id, c.date_debut, c.date_fin, c.id);
    if (collisions.length > 0) {
      return res.status(409).json({ message: 'Ce bien a entre-temps été réservé sur une période qui chevauche cette demande' });
    }

    const resultat = await pool.query(
      `UPDATE contrats SET statut = 'en_attente_signature', signature_proprietaire = $1, date_signature_proprietaire = NOW(), effectue_par_agent_id = $3
       WHERE id = $2 RETURNING *`,
      [signature_proprietaire.trim(), id, effectue_par_agent_id]
    );

    let nomSignataire = 'Le propriétaire';
    if (effectue_par_agent_id) {
      const proprietaireInfo = await pool.query('SELECT nom FROM users WHERE id = $1', [c.proprietaire_id]);
      const agentInfo = await pool.query('SELECT nom FROM users WHERE id = $1', [effectue_par_agent_id]);
      nomSignataire = `${echapperHtml(agentInfo.rows[0].nom)} (agent de ${echapperHtml(proprietaireInfo.rows[0].nom)})`;

      await enregistrerActionAgent({
        agent_id: effectue_par_agent_id,
        proprietaire_id: c.proprietaire_id,
        type_action: 'approbation_demande',
        description: `Approbation et signature de la demande de location pour le bien ${c.numero_bien} (locataire : ${c.locataire_nom})`,
        reference_type: 'contrat',
        reference_id: c.id,
      });
    }

    if (c.locataire_user_id) {
      await notifier({
        user_id: c.locataire_user_id,
        email: c.locataire_email,
        nom: c.locataire_nom,
        titre: 'Demande approuvée — signez votre contrat',
        message: `Votre demande pour le bien ${c.numero_bien} a été approuvée et signée par ${nomSignataire}. Signez à votre tour pour valider le contrat.`,
        type: 'approbation',
        lien: '/locataire/dashboard',
        sujet_email: '[RentEasy] Votre demande a été approuvée',
        contenu_email: `
          <h2>Demande approuvée</h2>
          <p><strong>${nomSignataire}</strong> a approuvé et signé votre demande pour le bien <strong>${c.numero_bien}</strong>.</p>
          <p>Connectez-vous à votre espace locataire pour signer le contrat à votre tour et le valider officiellement.</p>
        `,
      });
    }

    // Notifie le propriétaire si c'est son agent qui a traité la demande, pour transparence
    if (effectue_par_agent_id) {
      await notifier({
        user_id: c.proprietaire_id,
        titre: 'Demande approuvée par votre agent',
        message: `Votre agent a approuvé et signé en votre nom la demande pour le bien ${c.numero_bien}.`,
        type: 'info',
        lien: '/locataires',
      });
    }

    return res.json({ message: 'Demande approuvée et signée. En attente de la signature du locataire.', contrat: resultat.rows[0] });
  } catch (err) {
    console.error('Erreur approbation demande :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Le propriétaire (ou son agent en délégation) refuse la demande de réservation/location
async function refuserDemandeLocataire(req, res) {
  const { id } = req.params;

  try {
    const contrat = await pool.query(
      `SELECT c.*, b.numero_bien, b.proprietaire_id, l.nom AS locataire_nom, l.email AS locataire_email, l.user_id AS locataire_user_id
       FROM contrats c
       JOIN biens b ON b.id = c.bien_id
       JOIN locataires l ON l.id = c.locataire_id
       WHERE c.id = $1 AND c.statut = 'demande_locataire'`,
      [id]
    );
    if (contrat.rows.length === 0) {
      return res.status(404).json({ message: 'Demande non trouvée ou déjà traitée' });
    }
    const c = contrat.rows[0];

    const estAutorise = await estAutoriseSurProprietaire(req, c.proprietaire_id);
    if (!estAutorise) {
      return res.status(403).json({ message: "Vous n'êtes pas autorisé à traiter cette demande" });
    }
    const roles = (req.user.role || '').split(',').map(r => r.trim());
    const effectue_par_agent_id = roles.includes('agent') && req.user.id !== c.proprietaire_id ? req.user.id : null;

    await pool.query("UPDATE contrats SET statut = 'refuse' WHERE id = $1", [id]);

    if (effectue_par_agent_id) {
      await enregistrerActionAgent({
        agent_id: effectue_par_agent_id,
        proprietaire_id: c.proprietaire_id,
        type_action: 'refus_demande',
        description: `Refus de la demande de location pour le bien ${c.numero_bien} (locataire : ${c.locataire_nom})`,
        reference_type: 'contrat',
        reference_id: c.id,
      });
    }

    if (c.locataire_user_id) {
      const refuseurTexte = effectue_par_agent_id ? "par l'agent du propriétaire" : 'par le propriétaire';
      await notifier({
        user_id: c.locataire_user_id,
        email: c.locataire_email,
        nom: c.locataire_nom,
        titre: 'Demande refusée',
        message: `Votre demande pour le bien ${c.numero_bien} a été refusée ${refuseurTexte}.`,
        type: 'annulation',
        sujet_email: '[RentEasy] Votre demande a été refusée',
        contenu_email: `<h2>Demande refusée</h2><p>Votre demande pour le bien <strong>${c.numero_bien}</strong> a été refusée ${refuseurTexte}.</p>`,
      });
    }

    return res.json({ message: 'Demande refusée' });
  } catch (err) {
    console.error('Erreur refus demande :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = {
  creerContrat, listerContrats, obtenirContrat, resilierContrat, telechargerContratPDF,
  demanderLocationMarche, listerDemandesLocataireProprio, approuverDemandeLocataire, refuserDemandeLocataire,
  verifierCollision,
};
