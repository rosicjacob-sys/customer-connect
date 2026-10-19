// server/index.js
// Customer Connect server: the JSON API under /api, the unsubscribe page at
// /u, the campaign worker, and (after `npm run build`) the web app from dist/.

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const config = require('./config');
const db = require('./db');
const { hashPassword } = require('./auth');
const worker = require('./services/worker');
const jobs = require('./services/jobs');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // Template previews render pasted HTML (remote images, inline styles) in a sandboxed iframe.
        'img-src': ["'self'", 'data:', 'https:', 'http:'],
        'frame-src': ["'self'", 'blob:', 'data:'],
        'style-src': ["'self'", "'unsafe-inline'"],
        // The unsubscribe page's form posts back to itself.
        'form-action': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(compression());
  // rawBody: the checkout portal's signature is over the exact bytes sent.
  app.use('/api', express.json({ limit: '25mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api', require('./routes/auth'));
  app.use('/api', require('./routes/stores'));
  app.use('/api', require('./routes/customers'));
  app.use('/api', require('./routes/campaigns'));
  app.use('/api', require('./routes/ingest'));
  app.use(require('./routes/system'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  const dist = path.join(__dirname, '..', 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    app.get('/', (req, res) => res.send('Customer Connect API is running. Run "npm run build" to serve the web app here, or "npm run dev" for development.'));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error(`[api] ${req.method} ${req.path}:`, err);
    res.status(status).json({ error: status >= 500 && config.isProd ? 'Something went wrong. Please try again.' : err.message });
  });
  return app;
}

// First start: create the admin from ADMIN_EMAIL / ADMIN_PASSWORD when no users exist.
async function bootstrapAdmin() {
  const { rows: [{ n }] } = await db.pool.query('SELECT COUNT(*)::int AS n FROM users');
  if (n > 0) return;
  const { email, password, name } = config.bootstrapAdmin;
  if (!email || !password) {
    console.warn('⚠️  No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD and restart, or run: npm run create-admin -- <email> <password> [name]');
    return;
  }
  await db.pool.query('INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4)',
    [email.trim().toLowerCase(), name, 'admin', await hashPassword(password)]);
  console.log(`✅ Created admin ${email}`);
}

async function main() {
  if (config.missing.length) {
    console.error(`❌ Missing settings: ${config.missing.join(', ')}. See .env.example.`);
    process.exit(1);
  }
  await db.migrate();
  await bootstrapAdmin();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`✅ Customer Connect on port ${config.port} (${config.appUrl})`);
    console.log(config.dryRun
      ? '✉️  Email: DRY RUN, nothing is sent. Messages appear under Settings → Outbox.'
      : '✉️  Email: live via Resend');
  });
  if (process.env.DISABLE_WORKER !== 'true') {
    worker.start();
    jobs.start();
  }

  const shutdown = () => {
    console.log('Shutting down…');
    worker.stop();
    jobs.stop();
    server.close(() => db.pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Failed to start:', err);
    process.exit(1);
  });
}

module.exports = { createApp };
