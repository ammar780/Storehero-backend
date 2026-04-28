require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./src/routes/auth');
const analyzeRoutes = require('./src/routes/analyze');
const historyRoutes = require('./src/routes/history');
const settingsRoutes = require('./src/routes/settings');
const groupsRoutes = require('./src/routes/groups');
const sendRoutes = require('./src/routes/send');
const scheduleRoutes = require('./src/routes/schedule');
const errorHandler = require('./src/middleware/errorHandler');
const { runMigrations } = require('./src/db/migrate');
const { resumePendingJobs } = require('./src/services/sender');
const { startScheduler } = require('./src/services/scheduler');

const VERSION = '2.0.0';
const BUILD_TIME = new Date().toISOString();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(helmet());

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({
  origin: corsOrigin === '*' ? true : corsOrigin.split(',').map(s => s.trim()),
  credentials: true,
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Health + version (public, no auth) — used to verify deployed version
app.get('/', (req, res) => {
  res.json({
    name: 'TVS Inbox Analyzer API',
    status: 'ok',
    version: VERSION,
    buildTime: BUILD_TIME,
    features: ['auth', 'analyze', 'history', 'settings', 'groups', 'send', 'schedule'],
    time: new Date().toISOString(),
  });
});
app.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION }));
app.get('/api/version', (req, res) => {
  res.json({
    version: VERSION,
    buildTime: BUILD_TIME,
    features: ['auth', 'analyze', 'history', 'settings', 'groups', 'send', 'schedule'],
    routes: [
      'POST /api/auth/register', 'POST /api/auth/login', 'GET /api/auth/me',
      'POST /api/analyze/template', 'POST /api/analyze/full',
      'GET /api/history', 'GET /api/history/:id', 'DELETE /api/history/:id',
      'GET /api/settings', 'PUT /api/settings', 'DELETE /api/settings/api-key', 'POST /api/settings/test',
      'GET /api/groups', 'POST /api/groups', 'GET /api/groups/:id',
      'PUT /api/groups/:id', 'DELETE /api/groups/:id',
      'POST /api/groups/:id/emails', 'DELETE /api/groups/:id/emails',
      'DELETE /api/groups/:id/emails/:emailId',
      'POST /api/send', 'GET /api/send/jobs', 'GET /api/send/jobs/:id',
      'GET /api/send/jobs/:id/recipients', 'POST /api/send/jobs/:id/cancel',
      'GET /api/schedule', 'POST /api/schedule', 'POST /api/schedule/bulk',
      'GET /api/schedule/:id', 'PUT /api/schedule/:id',
      'POST /api/schedule/:id/cancel', 'DELETE /api/schedule/:id',
    ],
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/analyze', analyzeRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/send', sendRoutes);
app.use('/api/schedule', scheduleRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    method: req.method,
    path: req.originalUrl,
    hint: 'Check /api/version to see available routes on this deployment.',
  });
});

app.use(errorHandler);

(async () => {
  try {
    const missing = [];
    if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!process.env.JWT_SECRET)   missing.push('JWT_SECRET');
    if (missing.length > 0) {
      console.error(`\n✗ Missing required environment variable(s): ${missing.join(', ')}`);
      console.error(`  Set these in Railway → service → Variables, then redeploy.\n`);
      console.error(`  Generate a JWT secret with:  openssl rand -hex 32\n`);
      process.exit(1);
    }
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
      console.warn('⚠ JWT_SECRET is shorter than 32 chars — generate a stronger one with: openssl rand -hex 32');
    }

    await runMigrations();
    app.listen(PORT, () => {
      console.log(`✓ TVS Inbox Analyzer API v${VERSION} running on port ${PORT}`);
      console.log(`  Env: ${process.env.NODE_ENV || 'development'}`);
      console.log(`  CORS origin: ${corsOrigin}`);
      console.log(`  Built: ${BUILD_TIME}`);
    });

    setImmediate(() => resumePendingJobs().catch(err => console.error('Resume failed:', err)));
    setImmediate(() => startScheduler());
  } catch (err) {
    console.error('Boot failed:', err);
    process.exit(1);
  }
})();
