require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const bienRoutes = require('./routes/biens');
const locataireRoutes = require('./routes/locataires');
const contratRoutes = require('./routes/contrats');
const paiementRoutes = require('./routes/paiements');
const mobilemoneyRoutes = require('./routes/mobilemoney');
const dashboardRoutes = require('./routes/dashboard');
const demandeRoutes = require('./routes/demandes');
const notificationRoutes = require('./routes/notifications');
const locataireEspaceRoutes = require('./routes/locataireEspace');
const superAdminRoutes = require('./routes/superAdmin');
const recouvrementRoutes = require('./routes/recouvrements');
const messageRoutes = require('./routes/messages');
const profilRoutes = require('./routes/profil');
const soldeRoutes = require('./routes/solde');
const agentRoutes = require('./routes/agent');

const app = express();

// Important sur Railway : sans ça, express-rate-limit et req.ip
// se comportent mal derrière le proxy (problème déjà rencontré sur OJADA BANK)
app.set('trust proxy', 1);

// Liste des origines autorisées, séparées par une virgule dans .env
const origines = (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',');

app.use(cors({
  origin: origines,
  credentials: true,
}));

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// Sert les photos des biens (accessible publiquement pour affichage sur le marché)
app.use('/biens_photos', express.static(path.join(__dirname, '..', 'biens_photos')));

// Limite anti-abus sur les routes sensibles (connexion/inscription)
const limiteurAuth = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { message: 'Trop de tentatives, réessayez plus tard' },
});

const { limiteurGeneral } = require('./middleware/rateLimiters');
app.use('/api', limiteurGeneral);

app.use('/api/auth', limiteurAuth, authRoutes);
app.use('/api/biens', bienRoutes);
app.use('/api/locataires', locataireRoutes);
app.use('/api/contrats', contratRoutes);
app.use('/api/paiements', paiementRoutes);
app.use('/api/mobilemoney', mobilemoneyRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api', demandeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/locataire', locataireEspaceRoutes);
app.use('/api/superadmin', superAdminRoutes);
app.use('/api/recouvrements', recouvrementRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/profil', profilRoutes);
app.use('/api/solde', soldeRoutes);
app.use('/api/agent', agentRoutes);

// Route propriétaire - agent assigné
const { authentifier: auth, autoriser: autor } = require('./middleware/auth');
const { monAgent } = require('./controllers/superAdminController');
app.get('/api/proprietaire/mon-agent', auth, autor('proprietaire', 'super_admin'), monAgent);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'RentEasy Bénin API' });
});

app.use((req, res) => {
  res.status(404).json({ message: 'Route non trouvée' });
});

const { enregistrerErreur } = require('./utils/erreurs');

app.use(async (err, req, res, next) => {
  await enregistrerErreur({ erreur: err, req, statutHttp: 500 });
  res.status(500).json({ message: 'Erreur interne du serveur' });
});

// Un rejet de promesse non géré (oubli d'un .catch ou d'un await) ne fait normalement rien
// planter en Node — il finit juste par un warning invisible dans les logs. On le capture ici
// pour qu'il reste visible dans erreurs_serveur comme n'importe quelle autre erreur.
process.on('unhandledRejection', (raison) => {
  enregistrerErreur({ erreur: raison instanceof Error ? raison : new Error(String(raison)) });
});

// Une exception vraiment non attrapée laisse le process dans un état non garanti — on
// l'enregistre puis on arrête proprement plutôt que de continuer à tourner potentiellement
// corrompu. Railway (comme tout orchestrateur configuré en redémarrage automatique) relance le
// service immédiatement après.
process.on('uncaughtException', (err) => {
  enregistrerErreur({ erreur: err }).finally(() => process.exit(1));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Serveur RentEasy démarré sur le port ${PORT}`);
  require('./utils/cronBiens').demarrerCronBiens();
  require('./utils/cronSolde').demarrerCronSolde();
  require('./utils/cronPaiementsMobile').demarrerCronPaiementsMobile();
  require('./utils/cronRappelsEcheances').demarrerCronRappelsEcheances();
});
