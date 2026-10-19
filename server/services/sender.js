// server/services/sender.js
// Builds one email for one recipient and hands it to Resend. Both test
// sends and the campaign worker go through sendToRecipient(), so a test
// looks exactly like the real thing.

const crypto = require('crypto');
const config = require('../config');
const { pool } = require('../db');
const {
  EMAIL_RE, cleanDomain, applyMerge, hasUsableName,
  brandTint, brandTextColor, brandRgb, applyTemplateMaps, stripTemplateMaps, appendUtmToStoreLinks,
} = require('../lib/merge');

const OUTBOX_SIZE = 100;
const outbox = []; // dry-run messages, newest first

function unsubToken(email) {
  return crypto
    .createHmac('sha256', config.unsubscribeSecret)
    .update(String(email).toLowerCase().trim())
    .digest('hex')
    .slice(0, 32);
}

function verifyUnsubToken(email, token) {
  const expected = unsubToken(email);
  const given = String(token || '');
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function buildUnsubscribeUrl(email) {
  const e = encodeURIComponent(String(email).toLowerCase().trim());
  return `${config.appUrl}/u?e=${e}&t=${unsubToken(email)}`;
}

async function loadStore(storeId, storeDomain) {
  if (storeId) {
    const { rows } = await pool.query('SELECT * FROM stores WHERE id = $1', [storeId]);
    if (rows[0]) return rows[0];
  }
  if (storeDomain) {
    const { rows } = await pool.query('SELECT * FROM stores WHERE domain = $1', [cleanDomain(storeDomain)]);
    if (rows[0]) return rows[0];
  }
  return null;
}

/**
 * The finished message for one recipient, without sending it.
 *   recipient: { email, name, storeId, storeName, storeDomain, storeUrl, movedBanner, movedBannerText }
 *   content:   { subject, html, text, campaignName }
 *   store:     the stores row the email goes out under (or null)
 */
function buildMessage(recipient, content, store) {
  const email = String(recipient.email || '').trim().toLowerCase();
  const domain = cleanDomain(recipient.storeDomain || store?.domain || '');
  const brandColor = store?.brand_color || config.defaultBrandColor;
  const storeName = recipient.storeName || store?.brand_name || domain || 'our store';
  const fromEmail = store?.from_email || config.defaultFromEmail;
  const fromName = store?.from_name || store?.brand_name || recipient.storeName || config.defaultFromName;
  const unsubscribeUrl = buildUnsubscribeUrl(email);

  const fields = applyTemplateMaps(content.html, {
    customer_email: email,
    customer_name: hasUsableName(recipient.name) ? recipient.name.trim() : email,
    store_name: storeName,
    store_url: recipient.storeUrl || (domain ? `https://${domain}` : ''),
    store_domain: domain,
    store_brand_color: brandColor,
    store_brand_color_light: brandTint(brandColor),
    store_brand_text_color: brandTextColor(brandColor),
    store_brand_rgb: brandRgb(brandColor),
    moved_banner: recipient.movedBanner || '',
    moved_banner_text: recipient.movedBannerText || '',
    unsubscribe_url: unsubscribeUrl,
  });

  const msg = {
    from: `${fromName.replace(/[<>"]/g, '')} <${fromEmail}>`,
    to: [email],
    subject: applyMerge(content.subject, fields),
    html: appendUtmToStoreLinks(applyMerge(stripTemplateMaps(content.html), fields), {
      storeDomain: domain,
      campaignName: content.campaignName,
    }),
    // One-click unsubscribe (RFC 8058). Gmail and Yahoo require it for bulk
    // senders; the POST lands on /u, which handles it.
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
  if (content.text) msg.text = applyMerge(content.text, fields);
  if (store?.reply_to) msg.reply_to = store.reply_to;
  return msg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One POST to Resend. Rate limits (429) and server errors are retried with
// backoff; the idempotency key makes a retry after a lost response safe.
async function postToResend(msg, idempotencyKey) {
  let lastError = 'Request failed';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: JSON.stringify(msg),
      });
      const body = await resp.json().catch(() => ({}));
      if (resp.ok) return { ok: true, id: body.id };
      lastError = body?.message || `Resend error ${resp.status}`;
      if (resp.status !== 429 && resp.status < 500) return { ok: false, error: lastError };
      const retryAfter = Number(resp.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    } catch (err) {
      lastError = err.message || 'Request failed';
      await sleep(1000 * 2 ** attempt);
    }
  }
  return { ok: false, error: lastError };
}

async function deliver(msg, { idempotencyKey, label } = {}) {
  if (config.dryRun) {
    outbox.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), label: label || null, ...msg });
    outbox.length = Math.min(outbox.length, OUTBOX_SIZE);
    return { ok: true, id: 'dry-run' };
  }
  if (!config.resendApiKey) return { ok: false, error: 'Email is not set up (RESEND_API_KEY is missing)' };
  return postToResend(msg, idempotencyKey);
}

/**
 * Builds and sends one email. Opt-out checks are the caller's job.
 * storeCache: optional Map reused across a batch.
 */
async function sendToRecipient(recipient, content, { storeCache = new Map(), idempotencyKey, label } = {}) {
  const email = String(recipient.email || '').trim();
  if (!EMAIL_RE.test(email)) return { ok: false, error: `Invalid email: ${email || '(blank)'}` };
  const key = `${recipient.storeId || ''}::${cleanDomain(recipient.storeDomain)}`;
  if (!storeCache.has(key)) storeCache.set(key, await loadStore(recipient.storeId, recipient.storeDomain));
  const msg = buildMessage(recipient, content, storeCache.get(key));
  const result = await deliver(msg, { idempotencyKey, label });
  return result.ok ? result : { ...result, error: `${result.error} (${email})` };
}

module.exports = {
  outbox,
  unsubToken,
  verifyUnsubToken,
  buildUnsubscribeUrl,
  loadStore,
  buildMessage,
  sendToRecipient,
};
