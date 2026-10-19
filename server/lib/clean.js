// server/lib/clean.js
// Cleans one customer row before it is saved, whatever it came from (Chat
// Support Pro, the checkout portal, a CSV upload, or a person typing it).
// Pure: no database, no network. Whether an email's domain really receives
// mail is checked afterwards, in services/mailDomains.js.
//
// cleanRow() returns { drop: reason } or the cleaned fields plus notes on
// what was fixed.

const rules = require('./customerRules');

// Spelling fixes for big providers, on top of the ones Chat Support Pro
// already had (customerRules.EMAIL_DOMAIN_FIXES).
const EXTRA_DOMAIN_FIXES = {
  'gmail.ca': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmail.cim': 'gmail.com', 'gmail.cpm': 'gmail.com',
  'gmail.vom': 'gmail.com', 'gmail.xom': 'gmail.com', 'gmail.coom': 'gmail.com', 'gmail.comn': 'gmail.com',
  'gmail.ocm': 'gmail.com', 'gmail.con.com': 'gmail.com', 'gmail.com.com': 'gmail.com', 'gmailcom.com': 'gmail.com',
  'googlemail.con': 'googlemail.com',
  'hotmail.co': 'hotmail.com', 'hotmail.cm': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmai.com': 'hotmail.com',
  'outlook.co': 'outlook.com', 'outlook.con': 'outlook.com', 'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com',
  'icloud.co': 'icloud.com', 'iclould.com': 'icloud.com', 'icoud.com': 'icloud.com',
  'yahoo.con': 'yahoo.com', 'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yhaoo.com': 'yahoo.com',
  'yahoo.cmo': 'yahoo.com', 'yahoo.cm': 'yahoo.com',
};
const DOMAIN_FIXES = new Map([...rules.EMAIL_DOMAIN_FIXES, ...Object.entries(EXTRA_DOMAIN_FIXES)]);

// "One letter off" from these is treated as a typo of them…
const TYPO_TARGETS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'];
// …unless it is itself a real provider that happens to look alike.
const REAL_LOOKALIKES = new Set([
  'mail.com', 'email.com', 'ymail.com', 'gmx.com', 'gmx.net', 'gmx.ca', 'live.com', 'live.ca', 'me.com', 'mac.com',
  'aol.com', 'msn.com', 'yahoo.ca', 'yahoo.co.uk', 'yahoo.fr', 'hotmail.ca', 'hotmail.co.uk', 'hotmail.fr',
  'outlook.ca', 'outlook.fr', 'icloud.ca', 'gmail.co.uk', 'googlemail.com', 'proton.me', 'protonmail.com', 'pm.me',
]);

// Domains we know receive mail, so the DNS check can skip them.
const KNOWN_MAIL_DOMAINS = new Set([...TYPO_TARGETS, ...REAL_LOOKALIKES,
  'protonmail.ch', 'tutanota.com', 'zoho.com', 'fastmail.com', 'shaw.ca', 'rogers.com', 'sympatico.ca',
  'videotron.ca', 'telus.net', 'bell.net', 'cogeco.ca', 'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net',
  'cox.net', 'charter.net', 'bellsouth.net', 'earthlink.net', 'ymail.com', 'rocketmail.com', 'live.ca']);

// Store addresses that are never a customer's real store.
const BLOCKED_STORE_HOSTS = ['myshopify.com', 'pepscheckoutportal.com'];

const TEST_EMAIL_RE = new RegExp(rules.TEST_EMAIL_PATTERN);
const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^[a-z]{2,24}$|^xn--[a-z0-9-]{2,59}$/;

// Optimal string alignment distance, capped: is `a` one edit from `b`
// (a letter missing, extra, wrong, or two letters swapped)?
function oneEditApart(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length] === 1;
}

function isValidDomain(domain) {
  if (!domain || domain.length > 253 || !domain.includes('.')) return false;
  const labels = domain.split('.');
  return labels.every((l) => LABEL_RE.test(l)) && TLD_RE.test(labels[labels.length - 1]);
}

/**
 * → { email, fixed: 'old → new' | null } or { drop: reason }.
 */
function cleanEmail(raw) {
  let e = String(raw ?? '').trim().toLowerCase()
    .replace(/^mailto:/, '').replace(/^["'<\s]+|["'>\s.,;]+$/g, '').trim();
  if (!e) return { drop: 'missing email' };
  if (/\s/.test(e) || (e.match(/@/g) || []).length !== 1) return { drop: 'not an email address' };
  let [local, domain] = e.split('@');
  if (!local || local.length > 64 || !LOCAL_RE.test(local)) return { drop: 'not an email address' };

  let fixed = null;
  const fix = DOMAIN_FIXES.get(domain)
    || (!REAL_LOOKALIKES.has(domain) && !TYPO_TARGETS.includes(domain)
      ? (() => { const hits = TYPO_TARGETS.filter((t) => oneEditApart(domain, t)); return hits.length === 1 ? hits[0] : null; })()
      : null);
  if (fix) { fixed = `${domain} → ${fix}`; domain = fix; }

  if (!isValidDomain(domain)) return { drop: 'email domain is not a real domain' };
  e = `${local}@${domain}`;
  if (TEST_EMAIL_RE.test(e)) return { drop: 'test or placeholder email' };
  if (rules.DROP_EMAIL_DOMAINS.has(domain)) return { drop: 'fake or unclear email domain' };
  return { email: e, domain, fixed };
}

/**
 * Store address → its domain. Accepts "https://www.shop.com/collections/x".
 * → { domain, moved: boolean } or { drop: reason }.
 */
function cleanStoreUrl(raw) {
  let d = String(raw ?? '').trim().toLowerCase().replace(/^["']+|["']+$/g, '');
  if (!d) return { drop: 'missing store' };
  d = d.replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  if (BLOCKED_STORE_HOSTS.some((h) => d === h || d.endsWith(`.${h}`))) return { drop: 'checkout or Shopify admin address, not a store' };
  if (rules.DROP_STORE_DOMAINS.has(d)) return { drop: 'test or non-customer store' };
  if (!isValidDomain(d)) return { drop: 'store address is not a domain' };
  const moved = rules.DOMAIN_MOVES.get(d);
  return { domain: moved || d, moved: !!moved };
}

// A name worth using: not blank, not "Guest", not an email standing in for a name.
function cleanName(raw) {
  const n = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!n || /^(guest|customer|n\/?a|none|null|undefined|-+)$/i.test(n) || n.includes('@')) return null;
  return n.slice(0, 200);
}

// Phone → "+16135550101". North American numbers (every store is CA or US)
// get +1; numbers already written with + keep their country code. Anything
// else is left blank rather than saved wrong.
function cleanPhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// "2026-10-02", "2026-10-02 14:03:00", an ISO string or a Date → Date, or null.
// A date without a time is taken as noon UTC, so it is the same calendar day
// everywhere from Hawaii to the Philippines (midnight UTC is the evening
// before in North America).
function cleanDate(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    // A spreadsheet date cell (no time) arrives as local midnight: keep its day.
    if (raw.getHours() === 0 && raw.getMinutes() === 0 && raw.getSeconds() === 0) {
      return new Date(Date.UTC(raw.getFullYear(), raw.getMonth(), raw.getDate(), 12));
    }
    return raw;
  }
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  const d = m
    ? (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? new Date(s)
      : new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], m[4] != null ? +m[4] : 12, +(m[5] || 0), +(m[6] || 0))))
    : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  if (d.getTime() > Date.now() + 86400000 || d.getUTCFullYear() < 2000) return null;
  return d;
}

/**
 * One incoming row: { email, name, phone, storeUrl, storeName, seenAt }.
 * → { drop, reason } or { email, domain, name, phone, storeDomain, storeName, seenAt, notes[] }.
 */
function cleanRow(row) {
  const email = cleanEmail(row.email);
  if (email.drop) return { drop: email.drop };
  const store = cleanStoreUrl(row.storeUrl);
  if (store.drop) return { drop: store.drop };
  const notes = [];
  if (email.fixed) notes.push(`email typo fixed (${email.fixed})`);
  if (store.moved) notes.push('old store domain moved to its main store');
  const phone = cleanPhone(row.phone);
  if (row.phone && String(row.phone).trim() && !phone) notes.push('phone not recognised, left blank');
  const seenAt = cleanDate(row.seenAt);
  if (row.seenAt && String(row.seenAt).trim() && !seenAt) notes.push('date not recognised, treated as undated');
  return {
    email: email.email,
    domain: email.domain,
    name: cleanName(row.name),
    phone,
    storeDomain: store.domain,
    storeName: String(row.storeName ?? '').trim().slice(0, 200) || null,
    seenAt,
    notes,
  };
}

module.exports = {
  cleanRow, cleanEmail, cleanStoreUrl, cleanName, cleanPhone, cleanDate,
  KNOWN_MAIL_DOMAINS, BLOCKED_STORE_HOSTS,
};
