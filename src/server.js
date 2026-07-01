require('dotenv').config();
const express = require('express');
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

app.use(helmet());
app.use(express.json());
app.use(morgan('dev'));

// Limite anti-abus sur les routes sensibles (connexion/inscription)
const limiteurAuth = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { message: 'Trop de tentatives, réessayez plus tard' },
});

app.use('/api/auth', limiteurAuth, authRoutes);
app.use('/api/biens', bienRoutes);
app.use('/api/locataires', locataireRoutes);
app.use('/api/contrats', contratRoutes);
app.use('/api/paiements', paiementRoutes);
app.use('/api/mobilemoney', mobilemoneyRoutes);
app.use('/api/dashboard', dashboardRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'RentEasy Bénin API' });
});

app.use((req, res) => {
  res.status(404).json({ message: 'Route non trouvée' });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Erreur interne du serveur' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Serveur RentEasy démarré sur le port ${PORT}`);
});
