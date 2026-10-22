// server/routes/system.js
//   GET  /api/status                 sending mode, defaults, Chat Support Pro link
//   GET  /api/outbox                 dry-run messages (newest first)
//   POST /api/chat-support/sync      (admin) copy stores, customers and opt-outs from CSP now
//                                    ({ full: true } reads everything again, not just changes)
//   GET|POST /u?e=&t=                unsubscribe page and one-click unsubscribe (public)

const express = require('express');
const config = require('../config');
const { pool, getSetting } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { outbox, verifyUnsubToken } = require('../services/sender');
const chatSupport = require('../services/chatSupportBridge');
const jobs = require('../services/jobs');
const { escapeHtml } = require('../lib/merge');
const { wrap } = require('./util');

const router = express.Router();

router.get('/api/status', requireAuth, wrap(async (req, res) => {
  res.json({
    emailMode: config.dryRun ? 'dry-run' : 'live',
    resendConfigured: !!config.resendApiKey,
    appUrl: config.appUrl,
    defaultFromEmail: config.defaultFromEmail,
    defaultFromName: config.defaultFromName,
    sendDelayMs: config.sendDelayMs,
    chatSupport: {
      configured: chatSupport.isConfigured(),
      via: chatSupport.mode(),
      syncMinutes: config.chatSupportSyncMinutes,
      lastSync: await getSetting('chat_support_last_sync'),
    },
    checkoutPortal: {
      configured: !!config.checkoutPortalSecret,
      endpoint: `${config.appUrl}/api/ingest/checkout`,
      stats: await getSetting('checkout_portal'),
    },
    emailDomainCheck: config.emailDomainCheck,
  });
}));

router.get('/api/outbox', requireAuth, (req, res) => res.json({ dryRun: config.dryRun, messages: outbox }));

router.post('/api/chat-support/sync', requireAuth, requireAdmin, wrap(async (req, res) => {
  if (!chatSupport.isConfigured()) return res.status(400).json({ error: 'Set CHAT_SUPPORT_API_URL and CHAT_SUPPORT_API_KEY to link Chat Support Pro' });
  try {
    const result = await jobs.syncChatSupport({ full: req.body?.full === true });
    if (!result) return res.status(409).json({ error: 'A sync is already running. Try again in a minute.' });
    console.log(`[chatSupport] sync by ${req.user.email}:`, JSON.stringify(result));
    res.json(result);
  } catch (err) {
    console.error('[chatSupport] sync failed:', err);
    res.status(502).json({ error: `Sync failed: ${err.message}` });
  }
}));

// ── Unsubscribe ─────────────────────────────────────────────────────────────
// Opening the link shows a confirm button rather than unsubscribing at once,
// because mail scanners open links in emails. Mail clients' one-click
// unsubscribe (RFC 8058) POSTs to the same URL and takes effect directly.

function page(title, body, ok = true) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f3f4f6;color:#111827;">
<div style="max-width:440px;margin:80px auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:32px;text-align:center;">
<div style="font-size:40px;margin-bottom:12px;">${ok ? '✉️' : '⚠️'}</div>
<h1 style="margin:0 0 10px;font-size:20px;">${escapeHtml(title)}</h1>${body}</div></body></html>`;
}

const p = (text) => `<p style="margin:0;color:#4b5563;font-size:14px;line-height:1.6;">${text}</p>`;

function readLink(req) {
  const email = String(req.query.e || '').toLowerCase().trim();
  const token = String(req.query.t || '');
  return email && token && verifyUnsubToken(email, token) ? email : null;
}

router.get('/u', wrap(async (req, res) => {
  const email = readLink(req);
  if (!email) return res.status(400).send(page('Invalid link', p('This unsubscribe link could not be verified.'), false));
  const { rows } = await pool.query('SELECT 1 FROM unsubscribes WHERE email = $1', [email]);
  if (rows.length) return res.send(page("You're unsubscribed", p(`${escapeHtml(email)} won't get promotional emails from us.`)));
  res.send(page('Unsubscribe?', `${p(`Stop promotional emails to <strong>${escapeHtml(email)}</strong>?`)}
<form method="post" style="margin-top:20px;"><button type="submit" style="background:#111827;color:#fff;border:0;border-radius:9px;padding:11px 22px;font-size:14px;font-weight:600;cursor:pointer;">Unsubscribe</button></form>`));
}));

router.post('/u', express.urlencoded({ extended: false }), wrap(async (req, res) => {
  const email = readLink(req);
  if (!email) return res.status(400).send(page('Invalid link', p('This unsubscribe link could not be verified.'), false));
  const oneClick = String(req.body?.['List-Unsubscribe'] || '') === 'One-Click';
  await pool.query(`INSERT INTO unsubscribes (email, source) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`,
    [email, oneClick ? 'one_click' : 'link']);
  if (oneClick) return res.status(200).send('Unsubscribed');
  res.send(page("You're unsubscribed", p(`${escapeHtml(email)} won't get promotional emails from us anymore.`)));
}));

module.exports = router;
