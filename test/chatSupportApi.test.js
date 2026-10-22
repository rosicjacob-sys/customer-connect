// Syncing from Chat Support Pro through its API (CHAT_SUPPORT_API_URL), with
// a stand-in API answering exactly like Chat Support Pro's
// /api/integrations/customer-connect. Needs TEST_DATABASE_URL (the database
// is WIPED; its name must contain "test"). Skipped otherwise.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Pool } = require('pg');

const DB = process.env.TEST_DATABASE_URL;
const KEY = 'test-key-123';

// What Chat Support Pro holds, already de-duplicated the way its API does.
const NOW = '2026-10-20T12:00:00.000Z';
const STORES = [
  { id: 1, shop_domain: 'montreal.com', brand_name: 'Montreal Peptides', store_group: 'east', store_group_name: 'East', country: 'CA', brand_color: '#D23025', from_email: 'hi@montreal.com', from_name: null, is_active: true },
  { id: 2, shop_domain: 'https://Ottawa.com/', brand_name: 'Ottawa Peptides', store_group: 'east', store_group_name: 'East', country: 'CA', brand_color: null, from_email: null, from_name: null, is_active: true },
];
const CUSTOMERS = [
  { email: 'ana@gmail.com', store_domain: 'ottawa.com', store_name: 'Ottawa Peptides', source: 'chat', last_seen_at: '2026-10-02T10:00:00.000Z', name: 'Ana', phone: '613-555-0101', blacklisted: false, archived: false, store_count: 2 },
  { email: 'bad@gmail.com', store_domain: 'montreal.com', store_name: 'Montreal Peptides', source: 'chat', last_seen_at: '2026-10-03T10:00:00.000Z', name: 'Bad', phone: null, blacklisted: true, archived: false, store_count: 1 },
  { email: 'cyd@gmail.com', store_domain: 'montreal.com', store_name: 'Montreal Peptides', source: 'upload', last_seen_at: null, name: 'Cyd', phone: null, blacklisted: false, archived: true, store_count: 1 },
  { email: 'test@gmail.com', store_domain: 'montreal.com', store_name: 'Montreal Peptides', source: 'manual', last_seen_at: null, name: 'Tester', phone: null, blacklisted: false, archived: false, store_count: 1 },
  { email: 'dee@gmail.com', store_domain: 'pepscheckoutportal.com', store_name: 'Portal', source: 'chat', last_seen_at: '2026-10-04T10:00:00.000Z', name: 'Dee', phone: null, blacklisted: false, archived: false, store_count: 1 },
];
const UNSUBS = ['gone@gmail.com'];
const BLACKLIST = [{ email: 'bad@gmail.com', store: 'montreal.com', reason: 'abuse' }];
const SENT = [1, 2, 3].map((i) => ({ id: i, email: `p${i}@gmail.com`, store_domain: 'ottawa.com', store_name: 'Ottawa Peptides', sent_at: NOW }));

function fakeChatSupport() {
  const calls = [];
  let failNext = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: 'Invalid API key' });
      if (failNext) { failNext = false; return send(500, { error: 'Request failed' }); }
      const since = url.searchParams.get('since');
      const route = url.pathname.replace('/api/integrations/customer-connect', '');
      if (route === '/stores') return send(200, { now: NOW, stores: STORES });
      if (route === '/customers') {
        // Two per page, by email, as the real API pages.
        const after = url.searchParams.get('after') || '';
        const list = CUSTOMERS.filter((c) => c.email > after && (!since || c.email === 'ana@gmail.com')).sort((a, b) => a.email.localeCompare(b.email));
        const page = list.slice(0, 2);
        return send(200, { now: NOW, customers: page, next: page.length === 2 ? page[1].email : null });
      }
      if (route === '/opt-outs') return send(200, { now: NOW, unsubscribes: since ? [] : UNSUBS, blacklist: BLACKLIST });
      if (route === '/sent') {
        const afterId = Number(url.searchParams.get('afterId') || 0);
        const page = (since ? [] : SENT).filter((s) => s.id > afterId).slice(0, 2);
        return send(200, { now: NOW, sent: page, next: page.length === 2 ? page[1].id : null });
      }
      if (route === '/opt-outs/check' && req.method === 'POST') {
        const { emails } = JSON.parse(body);
        return send(200, { optedOut: emails.filter((e) => UNSUBS.includes(e) || BLACKLIST.some((b) => b.email === e)) });
      }
      send(404, { error: 'not found' });
    });
  });
  return { server, calls, failOnce: () => { failNext = true; } };
}

test('sync from Chat Support Pro through its API', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async (t) => {
  if (!/test/i.test(new URL(DB).pathname)) throw new Error('TEST_DATABASE_URL must name a database containing "test"');
  const fake = fakeChatSupport();
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    DATABASE_URL: DB, EMAIL_DRY_RUN: 'true', PGSSLMODE: 'disable', JWT_SECRET: 'x',
    CHAT_SUPPORT_API_URL: `http://127.0.0.1:${fake.server.address().port}/`, CHAT_SUPPORT_API_KEY: KEY, CHAT_SUPPORT_DATABASE_URL: '',
  });
  const admin = new Pool({ connectionString: DB });
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  const db = require('../server/db');
  const mail = require('../server/services/mailDomains');
  const bridge = require('../server/services/chatSupportBridge');
  t.after(async () => { fake.server.close(); await admin.end(); await db.pool.end(); });
  mail.setResolver(async (d) => {
    if (d === 'gmail.com') return [{ exchange: 'mx.gmail.com', priority: 1 }];
    throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  });
  await db.migrate();
  const one = async (email) => (await db.pool.query('SELECT * FROM customers WHERE email = $1', [email])).rows[0];

  await t.test('uses the API when its address and key are set', () => {
    assert.equal(bridge.mode(), 'api');
    assert.equal(bridge.isConfigured(), true);
  });

  await t.test('first sync copies everything, paging through', async () => {
    const r = await bridge.syncFromChatSupport();
    assert.equal(r.via, 'api');
    assert.equal(r.full, true);
    assert.deepEqual(r.stores, { added: 2, updated: 0, conflicts: [] });
    assert.equal(r.customers.chats, 3);
    assert.equal(r.customers.files, 2);
    assert.equal(r.customers.added, 3, 'ana, bad, cyd; not test@ (a test address) or dee (checkout portal store)');
    assert.equal(r.customers.notSaved, 2);
    assert.equal(r.customers.blocked, 1);
    assert.deepEqual(r.optOuts, { unsubscribes: 1, blocks: 0, sentLedger: 3 }, 'bad@ is already blocked by the customer sync');
    assert.equal(new Date(r.cursor).toISOString(), NOW);

    const customerPages = fake.calls.filter((c) => c.path.endsWith('/customers'));
    assert.deepEqual(customerPages.map((c) => c.query.after || ''), ['', 'bad@gmail.com', 'dee@gmail.com']);
    assert.ok(fake.calls.every((c) => c.auth === `Bearer ${KEY}`));
    assert.ok(!fake.calls.some((c) => c.path.includes('//')), 'trailing slash on the address is dropped');

    const ana = await one('ana@gmail.com');
    assert.equal(ana.store_domain, 'ottawa.com', 'domain cleaned from https://Ottawa.com/');
    assert.equal(ana.phone, '+16135550101');
    assert.equal(ana.last_seen_at.toISOString(), '2026-10-02T10:00:00.000Z');
    assert.equal((await one('cyd@gmail.com')).status, 'archived');
    assert.equal((await one('cyd@gmail.com')).last_seen_at, null, 'uploads carry no date');
    const { rows: stores } = await db.pool.query('SELECT domain, brand_color, from_email, csp_store_id FROM stores ORDER BY domain');
    assert.deepEqual(stores, [
      { domain: 'montreal.com', brand_color: '#D23025', from_email: 'hi@montreal.com', csp_store_id: 1 },
      { domain: 'ottawa.com', brand_color: null, from_email: null, csp_store_id: 2 },
    ]);
  });

  await t.test('the next sync asks only for what changed since the last one', async () => {
    fake.calls.length = 0;
    const r = await bridge.syncFromChatSupport();
    assert.equal(r.full, false);
    assert.equal(r.stores.updated, 2);
    assert.equal(r.customers.added, 0);
    const since = fake.calls.find((c) => c.path.endsWith('/customers')).query.since;
    assert.equal(since, '2026-10-20T11:55:00.000Z', 'last cursor minus 5 minutes');
  });

  await t.test('the live opt-out check asks the API', async () => {
    const optedOut = await bridge.optOutsFor(['gone@gmail.com', 'bad@gmail.com', 'ana@gmail.com']);
    assert.equal(optedOut('gone@gmail.com'), true);
    assert.equal(optedOut('bad@gmail.com'), true);
    assert.equal(optedOut('ana@gmail.com'), false);
  });

  await t.test('an API error fails the sync, so it is retried next time', async () => {
    fake.failOnce();
    await assert.rejects(bridge.syncFromChatSupport(), /Chat Support Pro API \/stores: 500/);
    fake.failOnce();
    await assert.rejects(bridge.optOutsFor(['ana@gmail.com']), /500/);
  });
});
