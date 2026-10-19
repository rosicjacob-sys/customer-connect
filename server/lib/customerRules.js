// server/lib/customerRules.js (copied from Chat Support Pro)
//
// Cleanup rules for customer lists: which old or local store domains now
// belong to which main store, obvious email typos, and rows that are not
// real customers. Used by the customer import on the Customers page.
// Holds no customer data. Edit DOMAIN_MOVES_BY_STORE when a store moves.

// Main store domain -> older domains, renamed domains, product subdomains
// and local sites whose customers belong to it.
const DOMAIN_MOVES_BY_STORE = {
  'barriepeptides.store': [
    'innisfilpeptides.ca',
    'midlandpeptides.ca',
  ],
  'birminghampeptides.com': [
    'birminghampeptides.shop',
  ],
  'bramptonpeptides.store': [
    'caledonpeptides.ca',
  ],
  'burnabypeptides.shop': [
    'portmoodypeptides.ca',
  ],
  'calgarypeptides.shop': [
    'airdriepeptides.ca',
    'beltlinepeptides.ca',
    'canmorepeptides.ca',
    'evergreenpeptides.ca',
    'legacypeptides.ca',
    'okotokspeptides.ca',
  ],
  'clevelandpeptides.com': [
    'ghkcu.clevelandpeptides.com',
  ],
  'columbuspeptides.com': [
    'columbuspeptides.shop',
  ],
  'edmontonpeptides.com': [
    'fortsaskatchewanpeptides.ca',
    'leducpeptides.ca',
    'stalbertpeptides.ca',
  ],
  'floridapeptideslab.com': [
    'orlandopeptides.store',
  ],
  'halifaxpeptides.shop': [
    'dartmouthpeptides.ca',
    'northendhalifaxpeptides.ca',
  ],
  'hamiltonpeptides.shop': [
    'ancasterpeptides.ca',
    'beamsvillepeptides.ca',
    'niagaraonthelakepeptides.ca',
    'pelhampeptides.ca',
  ],
  'houstonpeps.com': [
    'houstonpeptides.shop',
  ],
  'kingstonpeptides.shop': [
    'amherstviewpeptides.ca',
    'gananoquepeptides.ca',
  ],
  'kitchenerpeps.com': [
    'cambridgepeptides.ca',
    'downtownkitchenerpeptides.ca',
    'ghk.kitchenerpeps.com',
    'woodstockpeptides.ca',
  ],
  'lavalpeptides.shop': [
    'lachutepeptides.ca',
    'saint-jeromepeptides.ca',
    'terrebonnepeptides.ca',
  ],
  'losangelespeptides.com': [
    'oxnardpeptides.shop',
    'santaanapeptides.store',
  ],
  'mississaugapeps.ca': [
    'erinmillspeptides.ca',
  ],
  'montrealpeptides.com': [
    'albuquerquepeptides.shop',
    'capdelamadeleinepeptides.ca',
    'charlesbourgpeptides.ca',
    'charnypeptides.ca',
    'cotedesneigespeptides.ca',
    'grandmerepeptides.ca',
    'hochelagapeptides.ca',
    'hudsonpeptides.ca',
    'lacbeauportpeptides.ca',
    'lachinepeptides.ca',
    'lasallepeptides.ca',
    'lasvegaspeptides.store',
    'levispeptides.ca',
    'longueuilpeptides.ca',
    'montrealpeptides.ca',
    'montrealwestpeptides.ca',
    'northshorepeptides.ca',
    'overlandparkpeptides.shop',
    'pointeclairepeptides.ca',
    'riverheightspeptides.ca',
    'rochdalepeptides.ca',
    'sainteannepeptides.ca',
    'saintraymondpeptides.ca',
    'shawiniganpeptides.ca',
    'stthomaspeptides.ca',
    'thepointepeptides.ca',
    'westmountpeptides.ca',
  ],
  'neworleanspeps.com': [
    'neworleanspeptides.shop',
  ],
  'ottawapeptides.com': [
    'gatineaupeptides.ca',
  ],
  'peptidesacramento.com': [
    'sacramentopeptides.shop',
  ],
  'peptidesdallas.com': [
    'dallaspeptides.store',
  ],
  'peptidesdenver.com': [
    'denverpeptides.shop',
  ],
  'peptidesportland.com': [
    'portlandpeptides.shop',
  ],
  'philadelphiapeptides.com': [
    'philadelphiapeptides.store',
  ],
  'richmondhillpeptides.shop': [
    'newmarketpeptides.ca',
  ],
  'saskatoonpeptides.store': [
    'nutanapeptides.ca',
  ],
  'surreypeptides.com': [
    'fraserheightspeptides.ca',
    'mapleridgepeptides.ca',
    'southsurreypeptides.ca',
  ],
  'torontopeptides.shop': [
    'etobicokepeptides.ca',
    'libertyvillagepeptides.ca',
    'scarboroughpeptides.ca',
    'theannexpeptides.ca',
    'thebeachespeptides.ca',
  ],
  'vancouverpeptides.shop': [
    'northvancouverpeptides.ca',
    'westvancouverpeptides.ca',
  ],
  'vaughanpeps.ca': [
    'kingpeptides.ca',
    'maplepeptides.ca',
    'maplepeptides.shop',
  ],
  'windsorpeptides.store': [
    'pt141.windsorpeptides.store',
  ],
  'winnipegpeptides.shop': [
    'eaststpaulpeptides.ca',
    'selkirkpeptides.ca',
    'stvitalpeptides.ca',
  ],
};

const DOMAIN_MOVES = new Map(
  Object.entries(DOMAIN_MOVES_BY_STORE).flatMap(([store, olds]) => olds.map((old) => [old, store])),
);

// Email domain typos with an obvious fix.
const EMAIL_DOMAIN_FIXES = new Map(Object.entries({
  'gmail.con': 'gmail.com', 'gmail.co': 'gmail.com', 'gmai.com': 'gmail.com', 'gmsil.com': 'gmail.com',
  'gmail.om': 'gmail.com', 'gmail.c': 'gmail.com', 'gmail.comm': 'gmail.com', 'gmail.comk': 'gmail.com',
  'gmail.comlol': 'gmail.com',
  'hotmsil.com': 'hotmail.com', 'hotnail.com': 'hotmail.com', 'hotmail.comb': 'hotmail.com', 'hotmail.con': 'hotmail.com',
  'yahoo.cat': 'yahoo.ca', 'yaoo.ca': 'yahoo.ca',
  'icloud.con': 'icloud.com', 'icloud.cin': 'icloud.com',
  'msn.con': 'msn.com', 'oitlook.com': 'outlook.com',
}));

// Store domains that are not customer-facing stores.
const DROP_STORE_DOMAINS = new Set([
  'test.com', 'test.local', 'recon.local', 'pepscheckoutportal.com',
  'bedford-peptides-pc.myshopify.com', 'v1fcry-0f.myshopify.com', 'lumencompounds.shop', 'quantalab.shop',
]);

// Email domains that are typos with no clear fix, fake, or unverifiable.
const DROP_EMAIL_DOMAINS = new Set([
  'yahoo.co', 'titanota.com', 'e.com', 'x.com', 'b.com', 't.com', 'evil.com', 'evil.example',
  'yyc.com', 'ds.com', 'hj3.com', 'cloud.com',
]);

// Test or throwaway addresses. Kept in a form both JavaScript and Postgres read the same way.
const TEST_EMAIL_PATTERN = '(^|[._+-])(test|testing|tester|fake|asdf|qwerty|example|noreply|no-reply|dummy|sample)[0-9]*([._+-]|@)|@(example|test|mailinator|tempmail|10minutemail|guerrillamail|yopmail|sharklasers)[.]';
const TEST_EMAIL_RE = new RegExp(TEST_EMAIL_PATTERN);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Domain as written in the app (lowercase, no scheme, no trailing slash).
function appDomain(d) {
  return String(d || '').trim().replace(/^["']+|["']+$/g, '').trim()
    .replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

// Domain for matching: also ignores a leading "www.".
function matchDomain(d) {
  return appDomain(d).replace(/^www\./, '');
}

/**
 * Applies the rules to one row. Returns { drop: reason } or
 * { email, domain, emailFixed, domainMoved } with the cleaned values.
 */
function cleanCustomer({ email, domain }) {
  let e = String(email || '').trim().toLowerCase();
  const d = matchDomain(domain);
  if (!EMAIL_RE.test(e)) return { drop: 'missing or invalid email' };
  if (!d) return { drop: 'missing store domain' };
  if (DROP_STORE_DOMAINS.has(d)) return { drop: 'test, checkout or other-brand store' };
  let emailDomain = e.split('@')[1];
  if (TEST_EMAIL_RE.test(e)) return { drop: 'test email' };
  if (DROP_EMAIL_DOMAINS.has(emailDomain)) return { drop: 'fake, unclear or misspelled email domain' };
  let emailFixed = false;
  if (EMAIL_DOMAIN_FIXES.has(emailDomain)) {
    emailDomain = EMAIL_DOMAIN_FIXES.get(emailDomain);
    e = `${e.split('@')[0]}@${emailDomain}`;
    emailFixed = true;
  }
  const moved = DOMAIN_MOVES.get(d);
  return { email: e, domain: moved || d, emailFixed, domainMoved: !!moved };
}

module.exports = {
  DOMAIN_MOVES,
  EMAIL_DOMAIN_FIXES,
  DROP_STORE_DOMAINS,
  DROP_EMAIL_DOMAINS,
  TEST_EMAIL_PATTERN,
  appDomain,
  matchDomain,
  cleanCustomer,
};
