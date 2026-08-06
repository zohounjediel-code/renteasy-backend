const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');
const { envoyerEmail, echapperHtml } = require('../utils/notifications');
const { enregistrerActionAgent } = require('../utils/journalAgent');

const SALT_ROUNDS = 10;

// Inscription — propriétaire ou locataire uniquement
async function inscrire(req, res) {
  const { nom, telephone, mot_de_passe, ville, role, cgu_acceptees } = req.body;
  // Un espace en trop (copié-collé, clavier mobile) ferait échouer silencieusement toute
  // connexion future : email = $1 est une comparaison stricte, jamais tolérante aux espaces.
  const email = req.body.email?.trim();

  if (!nom || !email || !telephone || !mot_de_passe) {
    return res.status(400).json({ message: 'Champs obligatoires manquants' });
  }
  if (!cgu_acceptees) {
    return res.status(400).json({ message: "Vous devez accepter les conditions générales d'utilisation pour créer un compte." });
  }

  const rolesAutorises = ['proprietaire', 'locataire'];
  const roleFinal = role && rolesAutorises.includes(role) ? role : 'proprietaire';

  try {
    const existant = await pool.query(
      'SELECT id, role FROM users WHERE email = $1 OR telephone = $2',
      [email, telephone]
    );

    // Si le compte existe déjà, on peut ajouter un rôle supplémentaire
    if (existant.rows.length > 0) {
      const utilisateurExistant = existant.rows[0];
      const rolesActuels = utilisateurExistant.role.split(',').map(r => r.trim());

      if (rolesActuels.includes(roleFinal)) {
        return res.status(409).json({ message: 'Un compte existe déjà avec cet email ou ce téléphone' });
      }

      // Ajouter le nouveau rôle
      const nouveauxRoles = [...rolesActuels, roleFinal].join(',');
      const resultat = await pool.query(
        'UPDATE users SET role = $1 WHERE id = $2 RETURNING id, nom, email, telephone, role, ville',
        [nouveauxRoles, utilisateurExistant.id]
      );

      const token = genererToken(resultat.rows[0]);
      return res.status(200).json({
        message: `Rôle ${roleFinal} ajouté à votre compte`,
        utilisateur: resultat.rows[0],
        token,
      });
    }

    const hash = await bcrypt.hash(mot_de_passe, SALT_ROUNDS);

    // Pour un propriétaire : assigner automatiquement un agent
    let agent_id = null;
    if (roleFinal === 'proprietaire') {
      const agentDisponible = await pool.query(
        `SELECT u.id FROM users u
         WHERE u.role LIKE '%agent%' AND u.actif = true
         ORDER BY (SELECT COUNT(*) FROM users p WHERE p.agent_id = u.id) ASC
         LIMIT 1`
      );
      agent_id = agentDisponible.rows.length > 0 ? agentDisponible.rows[0].id : null;
    }

    const resultat = await pool.query(
      `INSERT INTO users (nom, email, telephone, mot_de_passe_hash, role, ville, agent_id, compte_active, cgu_acceptees_le)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW())
       RETURNING id, nom, email, telephone, role, ville, agent_id, created_at`,
      [nom, email, telephone, hash, roleFinal, ville || null, agent_id]
    );

    const utilisateur = resultat.rows[0];
    const token = genererToken(utilisateur);

    return res.status(201).json({ utilisateur, token });
  } catch (err) {
    console.error('Erreur inscription :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de l\'inscription' });
  }
}

// Connexion
async function connecter(req, res) {
  const { mot_de_passe } = req.body;
  // cf. inscrire() : même raison de trim() ici, sinon un espace collé par erreur dans l'email
  // bloque la connexion avec un simple "Identifiants incorrects" impossible à diagnostiquer
  // depuis l'écran de connexion.
  const email = req.body.email?.trim();

  if (!email || !mot_de_passe) {
    return res.status(400).json({ message: 'Email et mot de passe requis' });
  }

  try {
    const resultat = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND actif = true',
      [email]
    );

    if (resultat.rows.length === 0) {
      return res.status(401).json({ message: 'Identifiants incorrects' });
    }

    const utilisateur = resultat.rows[0];

    if (!utilisateur.compte_active) {
      return res.status(401).json({ message: 'Votre compte n\'est pas encore activé. Vérifiez votre email.' });
    }

    const motDePasseValide = await bcrypt.compare(mot_de_passe, utilisateur.mot_de_passe_hash);

    if (!motDePasseValide) {
      return res.status(401).json({ message: 'Identifiants incorrects' });
    }

    const token = genererToken(utilisateur);
    delete utilisateur.mot_de_passe_hash;

    return res.json({ utilisateur, token });
  } catch (err) {
    console.error('Erreur connexion :', err);
    return res.status(500).json({ message: 'Erreur serveur lors de la connexion' });
  }
}

// Activation du compte locataire via token d'invitation
async function activerCompte(req, res) {
  const { token, mot_de_passe, cgu_acceptees } = req.body;

  if (!token || !mot_de_passe) {
    return res.status(400).json({ message: 'Token et mot de passe requis' });
  }
  if (!cgu_acceptees) {
    return res.status(400).json({ message: "Vous devez accepter les conditions générales d'utilisation pour activer votre compte." });
  }

  try {
    const resultat = await pool.query(
      'SELECT * FROM users WHERE token_activation = $1 AND compte_active = false',
      [token]
    );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Token invalide ou compte déjà activé' });
    }

    // token_expiration peut être NULL pour un compte invité avant ce correctif — dans ce cas
    // on ne bloque pas rétroactivement un lien déjà envoyé sans limite de validité annoncée.
    if (resultat.rows[0].token_expiration && new Date() > new Date(resultat.rows[0].token_expiration)) {
      return res.status(410).json({
        message: "Ce lien d'activation a expiré. Demandez à votre propriétaire de vous renvoyer une invitation.",
      });
    }

    const hash = await bcrypt.hash(mot_de_passe, SALT_ROUNDS);

    const utilisateur = await pool.query(
      `UPDATE users SET mot_de_passe_hash = $1, compte_active = true, token_activation = null, token_expiration = null, cgu_acceptees_le = NOW()
       WHERE token_activation = $2
       RETURNING id, nom, email, telephone, role`,
      [hash, token]
    );

    const jwtToken = genererToken(utilisateur.rows[0]);
    return res.json({ message: 'Compte activé avec succès !', utilisateur: utilisateur.rows[0], token: jwtToken });
  } catch (err) {
    console.error('Erreur activation :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Email de réinitialisation de mot de passe — même style que l'activation, lien à durée de vie
// courte (1h) car demandé activement par la personne, contrairement à une invitation reçue.
async function envoyerEmailReinitialisation({ nom, email, token }) {
  const lien = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reinitialiser-mot-de-passe?token=${token}`;

  await envoyerEmail({
    destinataire_email: email,
    destinataire_nom: nom,
    sujet: '[RentEasy Bénin] Réinitialisation de votre mot de passe',
    contenu_html: `
      <h2>Réinitialisation de mot de passe</h2>
      <p>Bonjour ${echapperHtml(nom)},</p>
      <p>Vous avez demandé la réinitialisation de votre mot de passe RentEasy Bénin.</p>
      <p>Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe :</p>
      <a href="${lien}" style="background:#e8a020;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin:16px 0;">
        Réinitialiser mon mot de passe
      </a>
      <p style="color:#888;font-size:12px;">Ce lien est valable 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email — votre mot de passe actuel reste inchangé.</p>
    `,
  });
}

// Étape 1 : la personne indique son email, reçoit un lien si un compte actif correspond
async function demanderReinitialisationMotDePasse(req, res) {
  const email = req.body.email?.trim();
  if (!email) {
    return res.status(400).json({ message: 'Email requis' });
  }

  try {
    const user = await pool.query('SELECT id, nom, email, compte_active FROM users WHERE email = $1', [email]);

    // Réponse strictement identique que le compte existe ou non, et qu'il soit actif ou non —
    // sinon ce formulaire deviendrait un moyen de vérifier quels emails sont inscrits sur
    // RentEasy (énumération de comptes). Seul l'envoi réel de l'email est conditionnel.
    if (user.rows.length > 0 && user.rows[0].compte_active) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiration = new Date(Date.now() + 60 * 60 * 1000); // 1 heure

      await pool.query(
        'UPDATE users SET token_reinitialisation = $1, token_reinitialisation_expiration = $2 WHERE id = $3',
        [token, expiration, user.rows[0].id]
      );

      await envoyerEmailReinitialisation({ nom: user.rows[0].nom, email: user.rows[0].email, token });
    }

    return res.json({ message: 'Si un compte existe avec cet email, un lien de réinitialisation vient de lui être envoyé.' });
  } catch (err) {
    console.error('Erreur demande réinitialisation :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Étape 2 : la personne clique le lien reçu et choisit un nouveau mot de passe
async function reinitialiserMotDePasse(req, res) {
  const { token, nouveau_mot_de_passe } = req.body;
  if (!token || !nouveau_mot_de_passe) {
    return res.status(400).json({ message: 'Token et nouveau mot de passe requis' });
  }
  if (nouveau_mot_de_passe.length < 8) {
    return res.status(400).json({ message: 'Le mot de passe doit contenir au moins 8 caractères' });
  }

  try {
    const resultat = await pool.query(
      'SELECT id, token_reinitialisation_expiration FROM users WHERE token_reinitialisation = $1',
      [token]
    );

    if (resultat.rows.length === 0) {
      return res.status(404).json({ message: 'Lien invalide ou déjà utilisé' });
    }
    if (new Date() > new Date(resultat.rows[0].token_reinitialisation_expiration)) {
      return res.status(410).json({ message: 'Ce lien a expiré. Redemandez une réinitialisation.' });
    }

    const hash = await bcrypt.hash(nouveau_mot_de_passe, SALT_ROUNDS);

    await pool.query(
      'UPDATE users SET mot_de_passe_hash = $1, token_reinitialisation = null, token_reinitialisation_expiration = null WHERE id = $2',
      [hash, resultat.rows[0].id]
    );

    return res.json({ message: 'Mot de passe réinitialisé avec succès. Vous pouvez vous connecter.' });
  } catch (err) {
    console.error('Erreur réinitialisation mot de passe :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Créer un compte agent (admin ou super_admin uniquement)
async function creerAgent(req, res) {
  const { nom, email, telephone, mot_de_passe, ville } = req.body;
  const createur = req.user;

  const rolesCreateur = (createur.role || '').split(',');
  if (!rolesCreateur.includes('admin') && !rolesCreateur.includes('super_admin')) {
    return res.status(403).json({ message: 'Seul un admin peut créer un compte agent' });
  }

  if (!nom || !email || !telephone || !mot_de_passe) {
    return res.status(400).json({ message: 'Champs obligatoires manquants' });
  }

  try {
    const existant = await pool.query('SELECT id FROM users WHERE email = $1 OR telephone = $2', [email, telephone]);
    if (existant.rows.length > 0) {
      return res.status(409).json({ message: 'Un compte existe déjà avec cet email ou ce téléphone' });
    }

    const hash = await bcrypt.hash(mot_de_passe, SALT_ROUNDS);

    const resultat = await pool.query(
      `INSERT INTO users (nom, email, telephone, mot_de_passe_hash, role, ville, compte_active, gere_par_admin_id)
       VALUES ($1, $2, $3, $4, 'agent', $5, true, $6)
       RETURNING id, nom, email, telephone, role, ville, created_at`,
      [nom, email, telephone, hash, ville || null, createur.id]
    );

    await enregistrerActionAgent({
      agent_id: createur.id,
      proprietaire_id: resultat.rows[0].id,
      type_action: 'creation_compte_agent',
      description: `A créé le compte agent ${resultat.rows[0].nom}.`,
      reference_type: 'user',
      reference_id: resultat.rows[0].id,
    });

    return res.status(201).json({ message: 'Compte agent créé avec succès', agent: resultat.rows[0] });
  } catch (err) {
    console.error('Erreur création agent :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}
// Créer un compte admin (super_admin uniquement)
async function creerAdmin(req, res) {
  const { nom, email, telephone, mot_de_passe, ville } = req.body;
  const createur = req.user;

  const rolesCreateur = (createur.role || '').split(',');
  if (!rolesCreateur.includes('super_admin')) {
    return res.status(403).json({ message: 'Seul le super admin peut créer un compte admin' });
  }

  if (!nom || !email || !telephone || !mot_de_passe) {
    return res.status(400).json({ message: 'Champs obligatoires manquants' });
  }

  try {
    const existant = await pool.query('SELECT id FROM users WHERE email = $1 OR telephone = $2', [email, telephone]);
    if (existant.rows.length > 0) {
      return res.status(409).json({ message: 'Un compte existe déjà avec cet email ou ce téléphone' });
    }

    const hash = await bcrypt.hash(mot_de_passe, SALT_ROUNDS);

    const resultat = await pool.query(
      `INSERT INTO users (nom, email, telephone, mot_de_passe_hash, role, ville, compte_active)
       VALUES ($1, $2, $3, $4, 'admin', $5, true)
       RETURNING id, nom, email, telephone, role, ville, created_at`,
      [nom, email, telephone, hash, ville || null]
    );

    await enregistrerActionAgent({
      agent_id: createur.id,
      proprietaire_id: resultat.rows[0].id,
      type_action: 'creation_compte_admin',
      description: `A créé le compte admin ${resultat.rows[0].nom}.`,
      reference_type: 'user',
      reference_id: resultat.rows[0].id,
    });

    return res.status(201).json({ message: 'Compte admin créé avec succès', admin: resultat.rows[0] });
  } catch (err) {
    console.error('Erreur création admin :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

// Inviter un locataire (créé par le propriétaire)
const DUREE_VALIDITE_TOKEN_JOURS = 7;

// Email d'invitation à activer un compte locataire — factorisé pour être appelé aussi bien à
// la création qu'au renvoi d'une invitation dont le lien a expiré sans avoir été utilisé.
async function envoyerEmailActivationLocataire({ nom, email, tokenActivation }) {
  const lienActivation = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/activer-compte?token=${tokenActivation}`;

  await envoyerEmail({
    destinataire_email: email,
    destinataire_nom: nom,
    sujet: '[RentEasy Bénin] Activez votre compte locataire',
    contenu_html: `
      <h2>Bienvenue sur RentEasy Bénin !</h2>
      <p>Bonjour ${echapperHtml(nom)},</p>
      <p>Votre propriétaire vous a enregistré sur RentEasy Bénin, la plateforme de gestion locative.</p>
      <p>Cliquez sur le bouton ci-dessous pour activer votre compte et définir votre mot de passe :</p>
      <a href="${lienActivation}" style="background:#e8a020;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin:16px 0;">
        Activer mon compte
      </a>
      <p style="color:#888;font-size:12px;">Ce lien est valable ${DUREE_VALIDITE_TOKEN_JOURS} jours. Si vous n'êtes pas concerné, ignorez cet email.</p>
    `,
  });
}

async function inviterLocataire(pool, { nom, email, telephone, numero_piece_identite }) {
  if (!email) return null;

  try {
    // Vérifier si un compte existe déjà
    const existant = await pool.query('SELECT id, compte_active FROM users WHERE email = $1', [email]);
    if (existant.rows.length > 0) {
      const user = existant.rows[0];

      // Ajouter le rôle locataire si pas déjà là
      await pool.query(
        `UPDATE users SET role = CASE
           WHEN role NOT LIKE '%locataire%' THEN role || ',locataire'
           ELSE role
         END WHERE id = $1`,
        [user.id]
      );

      // Le compte existe mais n'a jamais été activé : on renvoie une invitation fraîche
      // (nouveau token, nouvelle expiration) au lieu de laisser la personne sans recours si
      // son précédent lien a expiré — sans ça, une invitation expirée bloquait
      // définitivement l'accès, avec ce reinvite silencieux qui ne renvoyait jamais rien.
      if (!user.compte_active) {
        const tokenActivation = crypto.randomBytes(32).toString('hex');
        const expiration = new Date();
        expiration.setDate(expiration.getDate() + DUREE_VALIDITE_TOKEN_JOURS);

        await pool.query(
          'UPDATE users SET token_activation = $1, token_expiration = $2 WHERE id = $3',
          [tokenActivation, expiration, user.id]
        );
        await envoyerEmailActivationLocataire({ nom, email, tokenActivation });
      }

      return user.id;
    }

    // Générer un token d'activation, valable 7 jours (annoncé dans l'email ci-dessous)
    const tokenActivation = crypto.randomBytes(32).toString('hex');
    const expiration = new Date();
    expiration.setDate(expiration.getDate() + DUREE_VALIDITE_TOKEN_JOURS);

    const resultat = await pool.query(
      `INSERT INTO users (nom, email, telephone, mot_de_passe_hash, role, numero_piece_identite, token_activation, token_expiration, compte_active)
       VALUES ($1, $2, $3, '', 'locataire', $4, $5, $6, false)
       RETURNING id`,
      [nom, email, telephone, numero_piece_identite || null, tokenActivation, expiration]
    );

    await envoyerEmailActivationLocataire({ nom, email, tokenActivation });

    return resultat.rows[0].id;
  } catch (err) {
    console.error('Erreur invitation locataire :', err);
    return null;
  }
}

function genererToken(utilisateur) {
  return jwt.sign(
    { id: utilisateur.id, role: utilisateur.role, nom: utilisateur.nom },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// Ajouter un rôle supplémentaire à son propre compte
async function ajouterRole(req, res) {
  const { role } = req.body;
  const user_id = req.user.id;

  const rolesAutorises = ['proprietaire', 'locataire'];
  if (!rolesAutorises.includes(role)) {
    return res.status(400).json({ message: 'Rôle non autorisé. Seuls proprietaire et locataire sont disponibles.' });
  }

  try {
    const user = await pool.query('SELECT id, role FROM users WHERE id = $1', [user_id]);
    if (user.rows.length === 0) return res.status(404).json({ message: 'Utilisateur non trouvé' });

    const rolesActuels = user.rows[0].role.split(',').map(r => r.trim());

    if (rolesActuels.includes(role)) {
      return res.status(409).json({ message: `Vous avez déjà le rôle ${role}` });
    }

    // Assigner un agent si nouveau propriétaire
    let agentUpdate = '';
    let agentId = null;
    if (role === 'proprietaire' && !rolesActuels.includes('proprietaire')) {
      const agent = await pool.query(
        `SELECT u.id FROM users u WHERE u.role LIKE '%agent%' AND u.actif = true
         ORDER BY (SELECT COUNT(*) FROM users p WHERE p.agent_id = u.id) ASC LIMIT 1`
      );
      agentId = agent.rows.length > 0 ? agent.rows[0].id : null;
    }

    const nouveauxRoles = [...rolesActuels, role].join(',');

    if (agentId) {
      await pool.query('UPDATE users SET role = $1, agent_id = $2 WHERE id = $3', [nouveauxRoles, agentId, user_id]);
    } else {
      await pool.query('UPDATE users SET role = $1 WHERE id = $2', [nouveauxRoles, user_id]);
    }

    const updated = await pool.query('SELECT id, nom, email, telephone, role, ville FROM users WHERE id = $1', [user_id]);
    const token = genererToken(updated.rows[0]);

    return res.json({
      message: `Espace ${role} activé avec succès !`,
      utilisateur: updated.rows[0],
      token,
    });
  } catch (err) {
    console.error('Erreur ajout rôle :', err);
    return res.status(500).json({ message: 'Erreur serveur' });
  }
}

module.exports = { inscrire, connecter, activerCompte, creerAgent, creerAdmin, inviterLocataire, ajouterRole, demanderReinitialisationMotDePasse, reinitialiserMotDePasse };
