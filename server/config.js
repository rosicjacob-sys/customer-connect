// server/config.js
// Every setting the server reads from the environment, in one place.

require('dotenv').config();

const isProd = process.env.NODE_ENV === 'production';

const config = {
  isProd,
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  // Public address of this app. Unsubscribe links in every email point here.
  appUrl: (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, ''),

  jwtSecret: process.env.JWT_SECRET || (isProd ? null : 'dev-only-secret-change-me'),
  // Signs unsubscribe links. Keep it stable: changing it breaks links in emails already sent.
  unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || (isProd ? null : 'dev-only-secret-change-me'),

  resendApiKey: process.env.RESEND_API_KEY || '',
  // Dry run: emails are built exactly as for a real send but kept in an
  // outbox on the Settings page instead of going to Resend.
  dryRun: process.env.EMAIL_DRY_RUN === 'true' || (!isProd && !process.env.RESEND_API_KEY),
  defaultFromEmail: process.env.DEFAULT_FROM_EMAIL || 'info@pepscustomercare.com',
  defaultFromName: process.env.DEFAULT_FROM_NAME || 'Customer Support',
  defaultBrandColor: process.env.DEFAULT_BRAND_COLOR || '#1a5632',
  // Pause between two sends. Resend's default limit is 2 requests a second.
  sendDelayMs: Number(process.env.SEND_DELAY_MS || 550),
  workerPollMs: Number(process.env.WORKER_POLL_MS || 10000),

  // Optional: the Chat Support Pro database, read only, to copy stores,
  // customers and opt-outs across and to honour CSP opt-outs at send time.
  chatSupportDatabaseUrl: process.env.CHAT_SUPPORT_DATABASE_URL || '',
  // How often new Chat Support Pro customers are pulled in automatically (0 = only by hand).
  chatSupportSyncMinutes: Number(process.env.CHAT_SUPPORT_SYNC_MINUTES ?? 15),

  // Shared secret the checkout portal signs its customer updates with
  // (POST /api/ingest/checkout). Empty: the endpoint is off.
  checkoutPortalSecret: process.env.CHECKOUT_PORTAL_SECRET || '',

  // Check that every new email's domain receives mail (DNS MX lookup).
  emailDomainCheck: process.env.EMAIL_DOMAIN_CHECK !== 'off',

  // First start only: creates this admin when there are no users yet.
  bootstrapAdmin: {
    email: process.env.ADMIN_EMAIL || '',
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME || 'Admin',
  },
};

const missing = [];
if (!config.databaseUrl) missing.push('DATABASE_URL');
if (!config.jwtSecret) missing.push('JWT_SECRET');
if (!config.unsubscribeSecret) missing.push('UNSUBSCRIBE_SECRET (or JWT_SECRET)');
if (isProd && !config.resendApiKey && !config.dryRun) missing.push('RESEND_API_KEY (or EMAIL_DRY_RUN=true)');
if (isProd && !process.env.APP_URL) missing.push('APP_URL');
config.missing = missing;

module.exports = config;
