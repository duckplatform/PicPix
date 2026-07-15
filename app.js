'use strict';

/**
 * Application principale
 *
 * Stack : Node.js + Express + MySQL + EJS
 * Déploiement : VPS cPanel (variables d'environnement définies dans cPanel)
 */

const express        = require('express');
const http           = require('http');
const path           = require('path');
const morgan         = require('morgan');
const helmet         = require('helmet');
const session        = require('express-session');
const flash          = require('connect-flash');
const methodOverride = require('method-override');
const { csrfSync }   = require('csrf-sync');
const { Server }     = require('socket.io');
const eventStore     = require('./services/eventStore');

const logger             = require('./config/logger');
const { testConnection } = require('./config/database');
const { globalLimiter }  = require('./middleware/rateLimiter');
const { injectLocals }   = require('./middleware/auth');

// ─── Initialisation de l'application Express ──────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3000;
const ENV  = process.env.NODE_ENV || 'development';
const DB_RETRY_DELAY_MS = parseInt(process.env.DB_RETRY_DELAY_MS || '10000', 10);

app.locals.databaseReady = ENV === 'test';
app.locals.databaseError = null;

let dbRetryTimer = null;

// ─── Moteur de templates EJS ───────────────────────────────────────────────

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Proxy inverse (Apache cPanel) ────────────────────────────────────────
// Nécessaire pour que express-session (cookie secure) et express-rate-limit
// lisent correctement l'IP et le protocole réels du client derrière Apache.

app.set('trust proxy', 1);

// ─── Sécurité : Helmet (headers HTTP) ─────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      imgSrc:      ["'self'", 'data:', 'https:'],
      connectSrc:  ["'self'", 'ws:', 'wss:'],
    },
  },
}));

// ─── Logging HTTP (Morgan → Winston) ──────────────────────────────────────

const morganStream = { write: (msg) => logger.http(msg.trim()) };
app.use(morgan(ENV === 'production' ? 'combined' : 'dev', { stream: morganStream }));

// ─── Parsing des requêtes ──────────────────────────────────────────────────

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(methodOverride('_method'));

// ─── Fichiers statiques ────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: ENV === 'production' ? '1d' : 0,
}));

app.use('/vendor/dropzone', express.static(path.join(__dirname, 'node_modules', 'dropzone', 'dist'), {
  maxAge: ENV === 'production' ? '1d' : 0,
}));

// ─── Sessions ─────────────────────────────────────────────────────────────

const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret-in-production';
app.use(session({
  name:   'sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   ENV === 'production',
    sameSite: 'lax',
    maxAge:   24 * 60 * 60 * 1000, // 24h
  },
}));

// ─── Flash messages ────────────────────────────────────────────────────────

app.use(flash());

// ─── Protection CSRF (csrf-sync - Synchroniser Token Pattern) ─────────────

const {
  generateToken: generateCsrfToken,
  csrfSynchronisedProtection,
} = csrfSync({
  // Lit le token depuis le corps de la requête ou les headers
  getTokenFromRequest: (req) => req.body._csrf || req.headers['x-csrf-token'],
});

// Rend csrfToken() disponible dans les routes via req.csrfToken()
app.use((req, res, next) => {
  req.csrfToken = () => generateCsrfToken(req);
  next();
});

// ─── Rate limiting global ──────────────────────────────────────────────────

app.use(globalLimiter);

// ─── Protection CSRF globale ───────────────────────────────────────────────
// csrf-sync valide uniquement les méthodes non-sûres (POST/PUT/PATCH/DELETE)
// Les requêtes GET/HEAD/OPTIONS sont automatiquement exemptées

app.use(csrfSynchronisedProtection);

// ─── Injection des variables locales dans les vues ────────────────────────

app.use(injectLocals);

// ─── Santé de l'application / disponibilité DB ────────────────────────────

app.get('/health', (req, res) => {
  const databaseReady = app.locals.databaseReady !== false;

  res.status(databaseReady ? 200 : 503).json({
    status:   databaseReady ? 'ok' : 'degraded',
    database: databaseReady ? 'up' : 'down',
  });
});

app.use((req, res, next) => {
  if (app.locals.databaseReady !== false) {
    return next();
  }

  // Permet d'afficher une page d'accueil simple même si MySQL n'est pas disponible.
  if (req.method === 'GET' && req.path === '/') {
    return next();
  }

  return res.status(503).render('errors/500', {
    title:      'Service temporairement indisponible',
    pageClass:  'page-error',
    statusCode: 503,
    message:    'L\'application est demarree, mais la base de donnees n\'est pas encore disponible. Reessayez dans quelques instants.',
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────

app.use('/', require('./routes/index'));



// ─── Page 404 ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).render('errors/404', {
    title:     'Page introuvable',
    pageClass: 'page-error',
  });
});

// ─── Gestionnaire d'erreurs global ────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Erreur CSRF
  if (err.code === 'EBADCSRFTOKEN' || err.code === 'INVALID_CSRF_TOKEN') {
    logger.warn(`[CSRF] Token invalide depuis ${req.ip} - ${req.method} ${req.originalUrl}`);
    req.flash('error', 'Requête invalide (token de sécurité expiré). Veuillez réessayer.');
    return res.redirect(req.get('Referrer') || '/');
  }

  logger.error(`[ERROR] ${err.status || 500} - ${err.message}`, { stack: err.stack });
  const status = err.status || 500;
  res.status(status).render('errors/500', {
    title:     'Erreur serveur',
    pageClass: 'page-error',
    statusCode: status,
    message:   ENV === 'development' ? err.message : 'Une erreur interne est survenue.',
  });
});

// ─── Démarrage du serveur ──────────────────────────────────────────────────

function scheduleDatabaseRetry() {
  if (dbRetryTimer || ENV === 'test') {
    return;
  }

  dbRetryTimer = setTimeout(() => {
    dbRetryTimer = null;
    void refreshDatabaseState();
  }, DB_RETRY_DELAY_MS);

  if (typeof dbRetryTimer.unref === 'function') {
    dbRetryTimer.unref();
  }
}

async function refreshDatabaseState() {
  try {
    await testConnection();

    if (!app.locals.databaseReady) {
      logger.info('[DB] Base de donnees disponible, reprise du trafic.');
    }

    app.locals.databaseReady = true;
    app.locals.databaseError = null;
  } catch (err) {
    app.locals.databaseReady = false;
    app.locals.databaseError = err;
    logger.error(`[DB] Base de donnees indisponible : ${err.message}`);
    scheduleDatabaseRetry();
  }
}

function listenAsync() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);

    const io = new Server(server, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      cors: {
        origin: false,
      },
    });

    app.locals.io = io;

    io.on('connection', (socket) => {
      socket.on('announce:join', (payload = {}) => {
        const eventId = Number.parseInt(payload.eventId, 10);
        if (!Number.isInteger(eventId) || eventId <= 0) {
          return;
        }

        socket.join(`event:${eventId}:announce`);
      });

      socket.on('ranking:join-event', (payload = {}) => {
        const eventId = Number.parseInt(payload.eventId, 10);
        if (!Number.isInteger(eventId) || eventId <= 0) {
          return;
        }

        socket.join(`event:${eventId}:ranking`);
      });

      socket.on('ranking:join-all', () => {
        socket.join('ranking:all');
      });

      socket.on('slideshow:join', (payload = {}) => {
        const eventId = Number.parseInt(payload.eventId, 10);
        if (!Number.isInteger(eventId) || eventId <= 0) {
          return;
        }

        socket.join(`event:${eventId}:slideshow`);
      });

      socket.on('moderation:join', (payload = {}) => {
        const eventId = Number.parseInt(payload.eventId, 10);
        if (!Number.isInteger(eventId) || eventId <= 0) {
          return;
        }

        socket.join(`event:${eventId}:moderation`);
      });
    });

    server.listen(PORT, () => {
      logger.info(`[SERVER] Application demarre sur le port ${PORT} (${ENV})`);
      resolve(server);
    });

    server.once('error', reject);
  });
}

async function startServer() {
  try {
    await listenAsync();
    void refreshDatabaseState();
    // Crée les dossiers de stockage manquants pour les événements pré-existants
    void eventStore.ensureAllStorageDirectories().catch((err) => {
      logger.warn('[SERVER] ensureAllStorageDirectories :', err.message);
    });
  } catch (err) {
    logger.error(`[SERVER] Impossible de demarrer : ${err.message}`);
    process.exit(1);
  }
}

// Démarre le serveur sauf pendant les tests automatisés.
// En production cPanel (Phusion Passenger), le fichier est chargé via require()
// et non exécuté directement, donc require.main !== module. On utilise
// NODE_ENV=test dans les tests pour éviter de démarrer le serveur.
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

module.exports = app;