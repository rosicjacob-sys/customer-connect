// server/services/mailDomains.js
// Does an email's domain really receive mail? Asks DNS for the domain's
// mail servers (MX records). Random text ("asdkjh.com") has none; Gmail,
// company and Proton addresses do.
//
//   ok       has mail servers (or is a provider we know)
//   none     the domain doesn't exist or takes no mail: the email is not saved
//   unknown  DNS didn't answer properly: saved as "unverified", left out of
//            campaigns, and checked again later (recheckUnverified)
//
// Before believing a "doesn't exist", DNS itself is checked on a domain that
// certainly exists. If that fails too, DNS is broken on this server, and
// every answer counts as unknown rather than throwing customers away.
// Results are cached in the email_domains table.

const dns = require('dns');
const config = require('../config');
const { pool } = require('../db');
const { KNOWN_MAIL_DOMAINS } = require('../lib/clean');

const OK_TTL_DAYS = 30;
const NONE_TTL_DAYS = 7;
const CONCURRENCY = 10;
const HEALTH_TTL_MS = 5 * 60 * 1000;
const HEALTH_DOMAIN = 'gmail.com';

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

let resolveMx = (() => {
  const r = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
  return (d) => r.resolveMx(d);
})();
let health = null; // { ok: boolean, at: number }

// Tests swap in a fake resolver.
function setResolver(fn) { resolveMx = fn; health = null; }

async function dnsHealthy() {
  if (health && Date.now() - health.at < HEALTH_TTL_MS) return health.ok;
  let ok = false;
  try { ok = (await resolveMx(HEALTH_DOMAIN)).length > 0; } catch { ok = false; }
  health = { ok, at: Date.now() };
  if (!ok) console.warn('[mailDomains] DNS is not answering; new email domains are saved as unverified and checked again later');
  return ok;
}

async function lookup(domain) {
  try {
    const records = await resolveMx(domain);
    // A "null MX" (a single record pointing at ".") means: takes no mail.
    const real = records.filter((r) => r.exchange && r.exchange !== '.');
    return real.length ? 'ok' : 'none';
  } catch (err) {
    return NOT_FOUND.has(err.code) ? 'none' : 'unknown';
  }
}

async function runLimited(items, fn) {
  const out = new Map();
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      out.set(item, await fn(item));
    }
  }));
  return out;
}

/** domains → Map(domain → 'ok' | 'none' | 'unknown') */
async function checkDomains(domains) {
  const list = [...new Set(domains)];
  const result = new Map();
  if (!config.emailDomainCheck) { list.forEach((d) => result.set(d, 'ok')); return result; }

  const toLook = [];
  for (const d of list) (KNOWN_MAIL_DOMAINS.has(d) ? result.set(d, 'ok') : toLook.push(d));
  if (!toLook.length) return result;

  const { rows } = await pool.query(
    `SELECT domain, status FROM email_domains
      WHERE domain = ANY($1)
        AND ((status = 'ok' AND checked_at > NOW() - INTERVAL '${OK_TTL_DAYS} days')
          OR (status = 'none' AND checked_at > NOW() - INTERVAL '${NONE_TTL_DAYS} days'))`, [toLook]);
  for (const r of rows) result.set(r.domain, r.status);
  const fresh = toLook.filter((d) => !result.has(d));
  if (!fresh.length) return result;

  const healthy = await dnsHealthy();
  const looked = healthy ? await runLimited(fresh, lookup) : new Map(fresh.map((d) => [d, 'unknown']));
  // "doesn't exist" is only believed while DNS answers for a domain that does.
  if (healthy && [...looked.values()].includes('none')) {
    health = null;
    if (!(await dnsHealthy())) for (const [d, s] of looked) if (s === 'none') looked.set(d, 'unknown');
  }
  const save = [...looked].filter(([, s]) => s !== 'unknown');
  if (save.length) {
    await pool.query(`
      INSERT INTO email_domains (domain, status, checked_at)
      SELECT * FROM UNNEST($1::text[], $2::text[], $3::timestamptz[])
      ON CONFLICT (domain) DO UPDATE SET status = EXCLUDED.status, checked_at = EXCLUDED.checked_at`,
    [save.map(([d]) => d), save.map(([, s]) => s), save.map(() => new Date())]);
  }
  for (const [d, s] of looked) result.set(d, s);
  return result;
}

// Background job: unverified customers whose domain now answers are let into
// campaigns; ones whose domain turns out not to exist are removed.
async function recheckUnverified() {
  const { rows } = await pool.query(
    `SELECT DISTINCT SPLIT_PART(email, '@', 2) AS domain FROM customers WHERE email_check = 'unverified' LIMIT 500`);
  if (!rows.length) return { verified: 0, removed: 0 };
  const status = await checkDomains(rows.map((r) => r.domain));
  const ok = [...status].filter(([, s]) => s === 'ok').map(([d]) => d);
  const none = [...status].filter(([, s]) => s === 'none').map(([d]) => d);
  const verified = ok.length ? (await pool.query(
    `UPDATE customers SET email_check = 'ok', updated_at = NOW()
      WHERE email_check = 'unverified' AND SPLIT_PART(email, '@', 2) = ANY($1)`, [ok])).rowCount : 0;
  const removed = none.length ? (await pool.query(
    `DELETE FROM customers WHERE email_check = 'unverified' AND SPLIT_PART(email, '@', 2) = ANY($1)`, [none])).rowCount : 0;
  if (verified || removed) console.log(`[mailDomains] recheck: ${verified} verified, ${removed} removed (domain takes no mail)`);
  return { verified, removed };
}

module.exports = { checkDomains, recheckUnverified, setResolver };
