const pool = require('../config/database');
const path = require('path');
const fs = require('fs');
const { DOSSIER_PHOTOS } = require('../middleware/uploadPhotosBien');
const { resoudreCibleAction, verifierAccesBien, resoudreProprietaireConsulte } = require('../utils/delegationAgent');
const { enregistrerActionAgent } = require('../utils/journalAgent');

// Créer un bien (propriétaire connecté, ou agent agissant en délégation pour un propriétaire assigné)
async function creerBien(req, res) {
  const { adresse, ville, quartier, type_bien, loyer_mensuel, type_loyer, caracteristiques, lieu_depot, tarifs } = req.body;

  const cible = await resoudreCibleAction(req);
  if (!cible) {
    return res.status(403).json({ message: "Vous n'êtes pas autorisé à créer un bien pour ce propriétaire" });
  }
  const { proprietaire_id, effectue_par_agent_id } = cible;

  const estVehicule = type_bien === 'vehicule';

  if (!ville || !type_bien || !loyer_mensuel) {
    return res.status(400).json({ message: 'Ville, type de bien et loyer sont obligatoires' });
  }
  if (!estVehicule && !adresse) {
    return res.status(400).json({ message: "L'adresse est obligatoire pour un bien immobilier" });
  }

  try {
    const resultat = await pool.query(
      `INSERT INTO biens (proprietaire_id, adresse, ville, quartier, type_bien, loyer_mensuel, type_loyer, caracteristiques, lieu_depot, tarifs, effectue_par_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        proprietaire_id,
        adresse || null,
        ville,
        quartier || null,
        type_bien,
        loyer_mensuel,
        type_loyer || 'mensuel',
        JSON.stringify(caracteristiques || {}),
        lieu_depot || null,
        JSON.stringify(tarifs || {}),
        effectue_par_agent_id,
      ]
    );
    const bien = resultat.rows[0];

    await enregistrerActionAgent({
      agent_id: effectue_par_agent_id,
      proprietaire_id,
      type_action: 'creation_bien',
      description: `Ajout du bien 🔖 ${bien.numero_bien} (${bien.adresse || bien.lieu_depot || '—'}, ${bien.ville})`,
      reference_type: 'bien',
      reference_id: bien.id,
    });

    return res.status(201).json(bien);
  } catch (err) {
    console.error('Erreur création bien :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la création du bien' });
  }
}

// Lister les biens du propriétaire connecté (ou, pour un admin, du propriétaire ciblé via
// ?proprietaire_id=... — un admin n'est propriétaire d'aucun bien lui-même)
async function listerBiens(req, res) {
  const proprietaire_id = resoudreProprietaireConsulte(req);
  if (!proprietaire_id) {
    return res.status(400).json({ message: 'proprietaire_id requis pour une consultation admin' });
  }

  try {
    const resultat = await pool.query(
      `SELECT b.*,
        (SELECT COUNT(*) FROM contrats c WHERE c.bien_id = b.id AND c.statut = 'actif') AS contrat_actif
       FROM biens b
       WHERE b.proprietaire_id = $1
       ORDER BY b.created_at DESC`,
      [proprietaire_id]
    );
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste biens :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la récupération des biens' });
  }
}

// Récupérer le détail d'un bien (un admin peut consulter n'importe quel bien, le propriétaire
// uniquement les siens)
async function obtenirBien(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');

  try {
    const resultat = estAdmin
      ? await pool.query('SELECT * FROM biens WHERE id = $1', [id])
      : await pool.query('SELECT * FROM biens WHERE id = $1 AND proprietaire_id = $2', [id, req.user.id]);

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Bien non trouvé' });
    }

    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur détail bien :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Modifier un bien
async function modifierBien(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const { adresse, ville, quartier, type_bien, loyer_mensuel, type_loyer, statut, caracteristiques, lieu_depot, tarifs } = req.body;

  try {
    const verif = estAdmin
      ? await pool.query('SELECT id, statut FROM biens WHERE id = $1', [id])
      : await pool.query('SELECT id, statut FROM biens WHERE id = $1 AND proprietaire_id = $2', [id, req.user.id]);
    if (verif.rows.length === 0) {
      return res.status(404).json({ message: 'Bien non trouvé' });
    }
    if (verif.rows[0].statut === 'occupe') {
      return res.status(409).json({ message: 'Ce bien est occupé et ne peut pas être modifié. Résiliez le contrat en cours pour le modifier.' });
    }

    const resultat = await pool.query(
      `UPDATE biens SET
        adresse = COALESCE($1, adresse),
        ville = COALESCE($2, ville),
        quartier = COALESCE($3, quartier),
        type_bien = COALESCE($4, type_bien),
        loyer_mensuel = COALESCE($5, loyer_mensuel),
        type_loyer = COALESCE($6, type_loyer),
        statut = COALESCE($7, statut),
        caracteristiques = COALESCE($8, caracteristiques),
        lieu_depot = COALESCE($9, lieu_depot),
        tarifs = COALESCE($10, tarifs),
        updated_at = NOW()
       WHERE id = $11
       RETURNING *`,
      [adresse, ville, quartier, type_bien, loyer_mensuel, type_loyer, statut,
       caracteristiques ? JSON.stringify(caracteristiques) : null, lieu_depot,
       tarifs ? JSON.stringify(tarifs) : null, id]
    );

    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur modification bien :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la modification' });
  }
}

// Supprimer un bien
async function supprimerBien(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');

  try {
    const verif = estAdmin
      ? await pool.query('SELECT id, statut FROM biens WHERE id = $1', [id])
      : await pool.query('SELECT id, statut FROM biens WHERE id = $1 AND proprietaire_id = $2', [id, req.user.id]);
    if (verif.rows.length === 0) {
      return res.status(404).json({ message: 'Bien non trouvé' });
    }
    if (verif.rows[0].statut === 'occupe') {
      return res.status(409).json({ message: 'Ce bien est occupé et ne peut pas être supprimé. Résiliez le contrat en cours avant de le supprimer.' });
    }

    // Bloque la suppression dès qu'un contrat existe, quel que soit son statut — le champ
    // "statut" du bien seul ne suffit pas : un bien libre peut très bien avoir eu un ou
    // plusieurs locataires par le passé. contrats.bien_id, echeances.contrat_id et
    // paiements.echeance_id sont en ON DELETE CASCADE (voir migrations) : supprimer un bien
    // ayant eu ne serait-ce qu'un contrat résilié effacerait définitivement l'historique
    // d'échéances et de paiements de tous les locataires qui y sont passés.
    const contrats = await pool.query('SELECT id FROM contrats WHERE bien_id = $1', [id]);
    if (contrats.rows.length > 0) {
      return res.status(409).json({
        message: "Impossible de supprimer ce bien : un historique de contrat existe (actif ou passé). Le supprimer effacerait définitivement les échéances et paiements de tous les locataires qui y sont passés.",
      });
    }

    await pool.query('DELETE FROM biens WHERE id = $1', [id]);

    return res.json({ message: 'Bien supprimé avec succès' });
  } catch (err) {
    console.error('Erreur suppression bien :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la suppression' });
  }
}

// Mettre/retirer un bien du marché
async function toggleMarche(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');
  const { description_marche } = req.body;

  try {
    const bien = estAdmin
      ? await pool.query('SELECT id, statut, sur_le_marche, moderation_masque, moderation_raison FROM biens WHERE id = $1', [id])
      : await pool.query('SELECT id, statut, sur_le_marche, moderation_masque, moderation_raison FROM biens WHERE id = $1 AND proprietaire_id = $2', [id, req.user.id]);

    if (bien.rows.length === 0) {
      return res.status(404).json({ message: 'Bien non trouvé' });
    }

    const b = bien.rows[0];

    // Seuls les biens libres (sans contrat actif) peuvent être mis sur le marché
    if (b.statut === 'occupe' && !b.sur_le_marche) {
      return res.status(400).json({ message: 'Ce bien est sous contrat actif. Résiliez le contrat avant de le mettre sur le marché.' });
    }

    const nouvellValeur = !b.sur_le_marche;

    await pool.query(
      'UPDATE biens SET sur_le_marche = $1, description_marche = $2, updated_at = NOW() WHERE id = $3',
      [nouvellValeur, description_marche || null, id]
    );

    // Remettre sur_le_marche à true ne suffit pas à faire réapparaître une annonce retirée par
    // la modération (moderation_masque est indépendant, cf. migration 028) — le propriétaire
    // doit le savoir plutôt que de croire son annonce republiée alors qu'elle reste invisible.
    if (nouvellValeur && b.moderation_masque) {
      return res.json({
        message: `Attention : cette annonce reste invisible sur le marché, elle a été retirée par la modération (motif : ${b.moderation_raison || 'non précisé'}). Contactez le support RentEasy.`,
        sur_le_marche: nouvellValeur,
        moderation_masque: true,
      });
    }

    return res.json({
      message: nouvellValeur ? 'Bien mis sur le marché avec succès !' : 'Bien retiré du marché.',
      sur_le_marche: nouvellValeur,
    });
  } catch (err) {
    console.error('Erreur toggle marché :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Lister tous les biens disponibles sur le marché (public)
async function listerMarche(req, res) {
  const { type_bien, ville, type_loyer, loyer_min, loyer_max,
          nb_chambres, nb_sanitaires, nb_etages, superficie_min, superficie_max, climatise,
          meuble, jardin, garage, piscine, salon, cuisine, type_vehicule } = req.query;

  try {
    let query = `
      SELECT b.id, b.adresse, b.ville, b.quartier, b.type_bien,
             b.loyer_mensuel, b.type_loyer, b.tarifs, b.caracteristiques,
             b.description_marche, b.photos, b.created_at,
             p.nom AS proprietaire_nom
      FROM biens b
      JOIN users p ON p.id = b.proprietaire_id
      WHERE b.sur_le_marche = true AND b.statut = 'libre' AND b.moderation_masque = false
    `;
    const params = [];

    if (type_bien) {
      params.push(type_bien);
      query += ` AND b.type_bien = $${params.length}`;
    }
    if (ville) {
      params.push(`%${ville}%`);
      query += ` AND b.ville ILIKE $${params.length}`;
    }
    let typeLoyerParamIndex = null;
    if (type_loyer) {
      params.push(type_loyer);
      typeLoyerParamIndex = params.length;
      // b.type_loyer ne retient qu'UNE SEULE valeur (le premier tarif renseigné à la
      // création du bien), alors qu'un bien peut proposer plusieurs types de loyer à la fois
      // (mensuel ET journalier ET hebdomadaire...) dans b.tarifs. Filtrer sur b.type_loyer
      // excluait donc à tort tout bien dont ce n'était pas le tarif "principal", même s'il
      // proposait bien la période demandée. jsonb_exists vérifie la présence de la clé
      // directement dans tarifs, quel que soit celui posé comme type_loyer par défaut.
      query += ` AND jsonb_exists(b.tarifs, $${typeLoyerParamIndex})`;
    }
    if (loyer_min) {
      params.push(parseInt(loyer_min));
      // Si une périodicité précise est demandée, comparer au tarif réel de CETTE périodicité
      // (b.tarifs->>type_loyer), pas à b.loyer_mensuel qui ne reflète que le tarif "principal"
      // du bien — sinon un bien loué à la journée à 5 000 FCFA/jour (mais dont le loyer_mensuel
      // affiché est de 150 000 FCFA) était comparé à tort à un budget mensuel.
      query += typeLoyerParamIndex
        ? ` AND (b.tarifs->>$${typeLoyerParamIndex})::int >= $${params.length}`
        : ` AND b.loyer_mensuel >= $${params.length}`;
    }
    if (loyer_max) {
      params.push(parseInt(loyer_max));
      query += typeLoyerParamIndex
        ? ` AND (b.tarifs->>$${typeLoyerParamIndex})::int <= $${params.length}`
        : ` AND b.loyer_mensuel <= $${params.length}`;
    }
    // Filtres sur caractéristiques JSON
    if (nb_chambres) {
      params.push(nb_chambres);
      query += ` AND (b.caracteristiques->>'nb_chambres')::int >= $${params.length}::int`;
    }
    if (nb_sanitaires) {
      params.push(nb_sanitaires);
      query += ` AND (b.caracteristiques->>'nb_sanitaires')::int >= $${params.length}::int`;
    }
    if (nb_etages) {
      params.push(nb_etages);
      query += ` AND (b.caracteristiques->>'nb_etages')::int >= $${params.length}::int`;
    }
    if (superficie_min) {
      params.push(superficie_min);
      query += ` AND (b.caracteristiques->>'superficie')::float >= $${params.length}::float`;
    }
    if (superficie_max) {
      params.push(superficie_max);
      query += ` AND (b.caracteristiques->>'superficie')::float <= $${params.length}::float`;
    }
    if (climatise) {
      params.push(climatise);
      query += ` AND b.caracteristiques->>'climatise' = $${params.length}`;
    }
    if (meuble) {
      params.push(meuble);
      query += ` AND b.caracteristiques->>'meuble' = $${params.length}`;
    }
    if (jardin) {
      params.push(jardin);
      query += ` AND b.caracteristiques->>'jardin' = $${params.length}`;
    }
    if (garage) {
      params.push(garage);
      query += ` AND b.caracteristiques->>'garage' = $${params.length}`;
    }
    if (piscine) {
      params.push(piscine);
      query += ` AND b.caracteristiques->>'piscine' = $${params.length}`;
    }
    if (salon) {
      params.push(salon);
      query += ` AND b.caracteristiques->>'salon' = $${params.length}`;
    }
    if (cuisine) {
      params.push(cuisine);
      query += ` AND b.caracteristiques->>'cuisine' = $${params.length}`;
    }
    if (type_vehicule) {
      params.push(type_vehicule);
      query += ` AND b.caracteristiques->>'type_vehicule' = $${params.length}`;
    }

    query += ' ORDER BY b.updated_at DESC';

    const resultat = await pool.query(query, params);
    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur marché :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Rechercher un bien par son numéro d'identification (pour la création de contrat)
async function obtenirBienParNumero(req, res) {
  const { numero } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');

  try {
    const resultat = estAdmin
      ? await pool.query(
          'SELECT id, numero_bien, adresse, ville, quartier, lieu_depot, type_bien, statut, loyer_mensuel, type_loyer, tarifs, caracteristiques FROM biens WHERE numero_bien = $1',
          [numero.trim().toUpperCase()]
        )
      : await pool.query(
          'SELECT id, numero_bien, adresse, ville, quartier, lieu_depot, type_bien, statut, loyer_mensuel, type_loyer, tarifs, caracteristiques FROM biens WHERE numero_bien = $1 AND proprietaire_id = $2',
          [numero.trim().toUpperCase(), req.user.id]
        );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Aucun bien avec ce numéro dans votre liste' });
    }

    return res.json(resultat.rows[0]);
  } catch (err) {
    console.error('Erreur recherche bien par numéro :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Ajouter des photos (aperçu) à un bien
async function ajouterPhotosBien(req, res) {
  const { id } = req.params;

  try {
    const bien = await verifierAccesBien(req, id);
    if (!bien) {
      return res.status(404).json({ message: 'Bien non trouvé' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'Aucune photo envoyée' });
    }

    const photosActuelles = bien.photos || [];
    const nouvellesPhotos = req.files.map(f => `/biens_photos/${f.filename}`);
    const photosFinal = [...photosActuelles, ...nouvellesPhotos];

    const resultat = await pool.query(
      'UPDATE biens SET photos = $1, updated_at = NOW() WHERE id = $2 RETURNING photos',
      [JSON.stringify(photosFinal), id]
    );

    const roles = (req.user.role || '').split(',').map(r => r.trim());
    if (roles.includes('agent') && req.user.id !== bien.proprietaire_id) {
      await enregistrerActionAgent({
        agent_id: req.user.id,
        proprietaire_id: bien.proprietaire_id,
        type_action: 'ajout_photos',
        description: `Ajout de ${nouvellesPhotos.length} photo(s) au bien 🔖 ${bien.numero_bien}`,
        reference_type: 'bien',
        reference_id: bien.id,
      });
    }

    return res.status(201).json({ message: 'Photos ajoutées avec succès', photos: resultat.rows[0].photos });
  } catch (err) {
    console.error('Erreur ajout photos bien :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de l\'ajout des photos' });
  }
}

// Supprimer une photo d'un bien
async function supprimerPhotoBien(req, res) {
  const { id } = req.params;
  const { chemin } = req.body;

  if (!chemin) {
    return res.status(400).json({ message: 'Chemin de la photo requis' });
  }

  try {
    const bien = await verifierAccesBien(req, id);
    if (!bien) {
      return res.status(404).json({ message: 'Bien non trouvé' });
    }

    const photosActuelles = bien.photos || [];
    const photosFinal = photosActuelles.filter(p => p !== chemin);

    await pool.query('UPDATE biens SET photos = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(photosFinal), id]);

    // Supprime le fichier physique
    const nomFichier = path.basename(chemin);
    const cheminComplet = path.join(DOSSIER_PHOTOS, nomFichier);
    if (fs.existsSync(cheminComplet)) {
      fs.unlinkSync(cheminComplet);
    }

    return res.json({ message: 'Photo supprimée', photos: photosFinal });
  } catch (err) {
    console.error('Erreur suppression photo bien :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la suppression de la photo' });
  }
}

// Liste complète des réservations/locations d'un bien (vue propriétaire, avec détails locataire)
async function listerReservationsBien(req, res) {
  const { id } = req.params;
  const roles = (req.user.role || '').split(',').map(r => r.trim());
  const estAdmin = roles.includes('admin') || roles.includes('super_admin');

  try {
    const verif = estAdmin
      ? await pool.query('SELECT id FROM biens WHERE id = $1', [id])
      : await pool.query('SELECT id FROM biens WHERE id = $1 AND proprietaire_id = $2', [id, req.user.id]);
    if (verif.rows.length === 0) {
      return res.status(404).json({ message: 'Bien non trouvé' });
    }

    const resultat = await pool.query(
      `SELECT c.id, c.date_debut, c.date_fin, c.type_loyer, c.loyer_mensuel, c.statut, c.origine, c.note_locataire, c.created_at,
              l.nom AS locataire_nom, l.telephone AS locataire_telephone
       FROM contrats c
       JOIN locataires l ON l.id = c.locataire_id
       WHERE c.bien_id = $1 AND c.statut IN ('demande_locataire', 'en_attente_signature', 'actif')
       ORDER BY c.date_debut ASC`,
      [id]
    );

    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur liste réservations bien :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Disponibilités d'un bien du marché (vue publique : dates occupées uniquement, sans infos personnelles)
async function listerDisponibilitesBienMarche(req, res) {
  const { id } = req.params;

  try {
    const resultat = await pool.query(
      `SELECT date_debut, date_fin, type_loyer, statut
       FROM contrats
       WHERE bien_id = $1 AND statut IN ('demande_locataire', 'en_attente_signature', 'actif')
       ORDER BY date_debut ASC`,
      [id]
    );

    return res.json(resultat.rows);
  } catch (err) {
    console.error('Erreur disponibilités bien :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Signalement d'une annonce par un utilisateur (n'importe quel rôle connecté) — ne masque rien
// tout seul, c'est un super admin qui décide depuis la file de modération (cf. modererAnnonce
// dans superAdminController.js).
const MOTIFS_SIGNALEMENT = ['photos_non_conformes', 'coordonnees_trompeuses', 'annonce_en_double', 'bien_indisponible', 'contenu_inapproprie', 'autre'];

async function signalerAnnonce(req, res) {
  const { id } = req.params;
  const { motif, description } = req.body;

  if (!motif || !MOTIFS_SIGNALEMENT.includes(motif)) {
    return res.status(400).json({ message: 'Motif de signalement invalide.' });
  }

  try {
    const bien = await pool.query('SELECT id FROM biens WHERE id = $1 AND sur_le_marche = true', [id]);
    if (bien.rows.length === 0) {
      return res.status(404).json({ message: 'Annonce non trouvée.' });
    }

    // Anti-doublon : évite qu'un même signalement pèse artificiellement plus lourd dans la file
    // simplement parce que la personne a cliqué plusieurs fois — un signalement déjà en attente
    // sur cette annonce par cette même personne suffit.
    const existant = await pool.query(
      `SELECT id FROM signalements_annonces WHERE bien_id = $1 AND signale_par = $2 AND statut = 'en_attente'`,
      [id, req.user.id]
    );
    if (existant.rows.length > 0) {
      return res.status(409).json({ message: 'Vous avez déjà signalé cette annonce, elle est en cours d\'examen.' });
    }

    await pool.query(
      `INSERT INTO signalements_annonces (bien_id, signale_par, motif, description) VALUES ($1, $2, $3, $4)`,
      [id, req.user.id, motif, description?.trim() || null]
    );

    return res.status(201).json({ message: 'Signalement envoyé, merci — notre équipe va l\'examiner.' });
  } catch (err) {
    console.error('Erreur signalement annonce :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = {
  creerBien, listerBiens, obtenirBien, obtenirBienParNumero, modifierBien, supprimerBien, toggleMarche, listerMarche,
  ajouterPhotosBien, supprimerPhotoBien, listerReservationsBien, listerDisponibilitesBienMarche, signalerAnnonce,
};
