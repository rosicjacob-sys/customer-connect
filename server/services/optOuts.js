// server/services/optOuts.js
// Everyone who must not get an email, checked right before every send:
//   unsubscribed      clicked an unsubscribe link (or was marked by hand)
//   blocked           on the blocklist (a block follows the person to any store)
//   resend_suppressed bounced or complained before (Resend's suppression list)
//   chat_support      unsubscribed or blacklisted in Chat Support Pro
// Checked per batch, not only when a campaign is created, so someone who
// opts out mid-campaign is skipped from the next batch on.

const config = require('../config');
const { pool } = require('../db');
const chatSupport = require('./chatSupportBridge');

// ── Resend suppression list ─────────────────────────────────────────────────
// Resend refuses suppressed addresses anyway, but every attempt still counts
// against sender reputation. Fails open: on any error, no extra filtering.
// (Same request as Chat Support Pro's resendSuppressions.js, which notes it
// was never checked against a live response; watch the logs.)

const SUPPRESSION_TTL_MS = 5 * 60 * 1000;
let suppressionCache = null;

async function fetchSuppressions() {
  const emails = new Set();
  let cursor = null;
  let guard = 0;
  do {
    const url = new URL('https://api.resend.com/emails/suppressions');
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('after', cursor);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${config.resendApiKey}` } });
    if (!resp.ok) throw new Error(`Resend suppressions request failed: ${resp.status}`);
    const body = await resp.json();
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
    for (const row of rows) {
      const email = row?.email || row?.address;
      if (email) emails.add(String(email).toLowerCase().trim());
    }
    const next = body?.has_more ? (body?.after ?? rows[rows.length - 1]?.id ?? null) : null;
    cursor = next && next !== cursor ? next : null;
    guard++;
  } while (cursor && guard < 50);
  return emails;
}

async function getSuppressedEmails() {
  if (config.dryRun || !config.resendApiKey) return new Set();
  if (suppressionCache && Date.now() - suppressionCache.at < SUPPRESSION_TTL_MS) return suppressionCache.set;
  try {
    const set = await fetchSuppressions();
    suppressionCache = { set, at: Date.now() };
    return set;
  } catch (err) {
    console.error('[optOuts] Could not read Resend suppressions (sending without that filter):', err.message);
    return suppressionCache?.set || new Set();
  }
}

// ── Combined check ──────────────────────────────────────────────────────────

/**
 * Loads every opt-out that applies to these emails and returns
 * reasonFor(email): null when sending is fine, else the reason.
 * Throws when Chat Support Pro is configured but cannot be read, so the
 * caller waits and retries instead of emailing someone who opted out there.
 */
async function loadOptOuts(emails) {
  const list = [...new Set(emails.map((e) => String(e || '').toLowerCase().trim()).filter(Boolean))];
  if (!list.length) return () => null;

  const [unsub, blocks, suppressed, csp] = await Promise.all([
    pool.query('SELECT LOWER(email) AS email FROM unsubscribes WHERE LOWER(email) = ANY($1)', [list]),
    pool.query('SELECT LOWER(email) AS email, store_domain FROM blocklist WHERE LOWER(email) = ANY($1)', [list]),
    getSuppressedEmails(),
    chatSupport.isConfigured() ? chatSupport.optOutsFor(list) : null,
  ]);

  const unsubscribed = new Set(unsub.rows.map((r) => r.email));
  const blocked = new Set(blocks.rows.map((r) => r.email));

  return (email) => {
    const e = String(email || '').toLowerCase().trim();
    if (unsubscribed.has(e)) return 'unsubscribed';
    if (blocked.has(e)) return 'blocked';
    if (suppressed.has(e)) return 'resend_suppressed';
    if (csp && csp(e)) return 'chat_support';
    return null;
  };
}

module.exports = { loadOptOuts, getSuppressedEmails };
