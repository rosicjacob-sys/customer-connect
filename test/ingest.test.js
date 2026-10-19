// One customer per email, latest store wins: the save rules against real
// Postgres. Needs TEST_DATABASE_URL (the database is WIPED; its name must
// contain "test"). Skipped otherwise.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const DB = process.env.TEST_DATABASE_URL;

test('saving customers', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async (t) => {
  if (!/test/i.test(new URL(DB).pathname)) throw new Error('TEST_DATABASE_URL must name a database containing "test"');
  Object.assign(process.env, { DATABASE_URL: DB, EMAIL_DRY_RUN: 'true', PGSSLMODE: 'disable', JWT_SECRET: 'x', CHAT_SUPPORT_DATABASE_URL: '' });
  const admin = new Pool({ connectionString: DB });
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  // A database from before one-row-per-email: a row per store.
  await admin.query(`
    CREATE TABLE stores (id SERIAL PRIMARY KEY, domain TEXT NOT NULL UNIQUE, brand_name TEXT NOT NULL,
      store_group TEXT, store_group_name TEXT, country TEXT, brand_color TEXT, from_email TEXT, from_name TEXT,
      reply_to TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE, csp_store_id INTEGER UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE customers (id SERIAL PRIMARY KEY, email TEXT NOT NULL, store_domain TEXT NOT NULL DEFAULT '',
      store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL, name TEXT, name_locked BOOLEAN NOT NULL DEFAULT FALSE,
      phone TEXT, country TEXT, moved_to_domain TEXT, from_chat BOOLEAN NOT NULL DEFAULT FALSE,
      from_upload BOOLEAN NOT NULL DEFAULT FALSE, added_manually BOOLEAN NOT NULL DEFAULT FALSE, status TEXT,
      created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (store_domain, email));
    INSERT INTO stores (domain, brand_name, country, store_group) VALUES
      ('montreal.com', 'Montreal Shop', 'CA', 'east'), ('ottawa.com', 'Ottawa Shop', 'CA', 'east'), ('dallas.com', 'Dallas Shop', 'US', 'south');
    INSERT INTO customers (email, store_domain, store_id, name, phone, from_upload, from_chat, created_at) VALUES
      ('old@gmail.com', 'montreal.com', 1, 'Old Name', '+15145550000', TRUE, FALSE, NOW() - INTERVAL '2 days'),
      ('old@gmail.com', 'ottawa.com', 2, NULL, NULL, FALSE, TRUE, NOW() - INTERVAL '1 day'),
      ('solo@gmail.com', 'dallas.com', 3, 'Solo', NULL, TRUE, FALSE, NOW());`);

  const db = require('../server/db');
  const mail = require('../server/services/mailDomains');
  const { ingest } = require('../server/services/ingest');
  const customers = require('../server/services/customers');
  t.after(async () => { await admin.end(); await db.pool.end(); });

  // Fake DNS: these domains take mail, these don't, this one times out.
  let dnsDown = false;
  mail.setResolver(async (d) => {
    if (dnsDown) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    if (['gmail.com', 'acmecorp.com', 'later-ok.com'].includes(d)) return [{ exchange: `mx.${d}`, priority: 1 }];
    if (d === 'nullmx.com') return [{ exchange: '.', priority: 0 }];
    if (d === 'slowdns.com') throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
    throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  });

  await db.migrate();
  const one = async (email) => (await db.pool.query('SELECT * FROM customers WHERE email = $1', [email])).rows[0];
  const links = async (email) => (await db.pool.query('SELECT * FROM customer_stores WHERE email = $1 ORDER BY store_domain', [email])).rows;
  const row = (email, store, seenAt, extra = {}) => ({ email, storeUrl: store, seenAt, ...extra });

  await t.test('old per-store rows collapse into one customer, nothing lost', async () => {
    const { rows } = await db.pool.query(`SELECT email, store_domain, name, phone, from_upload, from_chat FROM customers ORDER BY email`);
    assert.equal(rows.length, 2);
    const old = rows.find((r) => r.email === 'old@gmail.com');
    assert.equal(old.store_domain, 'ottawa.com', 'most recently added store becomes current');
    assert.equal(old.name, 'Old Name');
    assert.equal(old.phone, '+15145550000');
    assert.ok(old.from_upload && old.from_chat);
    assert.deepEqual((await links('old@gmail.com')).map((l) => l.store_domain), ['montreal.com', 'ottawa.com']);
    await db.migrate(); // running again changes nothing
    assert.equal((await db.pool.query('SELECT COUNT(*)::int AS n FROM customers')).rows[0].n, 2);
  });

  await t.test('Montreal on Oct 1, Ottawa on Oct 2: Ottawa wins, Montreal stays in history', async () => {
    await ingest([row('email1@gmail.com', 'montreal.com', '2026-10-01', { name: 'Em One' })], { source: 'checkout' });
    assert.equal((await one('email1@gmail.com')).store_domain, 'montreal.com');
    const r = await ingest([row('email1@gmail.com', 'https://www.ottawa.com/cart', '2026-10-02', { phone: '613-555-0101' })], { source: 'checkout' });
    assert.equal(r.storeChanged, 1);
    const c = await one('email1@gmail.com');
    assert.equal(c.store_domain, 'ottawa.com');
    assert.equal(c.name, 'Em One', 'a missing name does not wipe the saved one');
    assert.equal(c.phone, '+16135550101');
    assert.equal(c.last_seen_at.toISOString(), '2026-10-02T12:00:00.000Z');
    assert.deepEqual((await links('email1@gmail.com')).map((l) => l.store_domain), ['montreal.com', 'ottawa.com']);
  });

  await t.test('re-sending the old Montreal row does not move them back', async () => {
    const r = await ingest([row('email1@gmail.com', 'montreal.com', '2026-10-01')], { source: 'checkout' });
    assert.equal(r.storeChanged, 0);
    assert.equal((await one('email1@gmail.com')).store_domain, 'ottawa.com');
  });

  await t.test('arrival order does not matter', async () => {
    await ingest([row('email2@gmail.com', 'ottawa.com', '2026-10-02')], { source: 'chat' });
    await ingest([row('email2@gmail.com', 'montreal.com', '2026-10-01')], { source: 'checkout' });
    assert.equal((await one('email2@gmail.com')).store_domain, 'ottawa.com');
    // Both in one batch, newest first or last.
    await ingest([row('email3@gmail.com', 'ottawa.com', '2026-10-02'), row('email3@gmail.com', 'montreal.com', '2026-10-01')], { source: 'upload' });
    assert.equal((await one('email3@gmail.com')).store_domain, 'ottawa.com');
    assert.equal((await db.pool.query(`SELECT COUNT(*)::int AS n FROM customers WHERE email = 'email3@gmail.com'`)).rows[0].n, 1);
  });

  await t.test('an undated row adds new customers but never moves existing ones', async () => {
    await ingest([row('email1@gmail.com', 'dallas.com', null)], { source: 'upload' });
    assert.equal((await one('email1@gmail.com')).store_domain, 'ottawa.com');
    await ingest([row('brandnew@gmail.com', 'dallas.com', null, { name: 'New' })], { source: 'upload' });
    assert.equal((await one('brandnew@gmail.com')).store_domain, 'dallas.com');
    await ingest([row('brandnew@gmail.com', 'montreal.com', '2025-01-01')], { source: 'chat' });
    assert.equal((await one('brandnew@gmail.com')).store_domain, 'montreal.com', 'any dated evidence beats none');
  });

  await t.test('same moment at two stores: checkout beats chat', async () => {
    await ingest([row('tie@gmail.com', 'montreal.com', '2026-10-05T10:00:00Z')], { source: 'chat' });
    await ingest([row('tie@gmail.com', 'ottawa.com', '2026-10-05T10:00:00Z')], { source: 'checkout' });
    assert.equal((await one('tie@gmail.com')).store_domain, 'ottawa.com');
  });

  await t.test('names: newer replaces, undated only fills blanks, typed names stay', async () => {
    await ingest([row('names@gmail.com', 'montreal.com', '2026-09-01', { name: 'Jo' })], { source: 'chat' });
    await ingest([row('names@gmail.com', 'montreal.com', null, { name: 'Undated' })], { source: 'upload' });
    assert.equal((await one('names@gmail.com')).name, 'Jo');
    await ingest([row('names@gmail.com', 'montreal.com', '2026-09-02', { name: 'Joanna Smith' })], { source: 'checkout' });
    assert.equal((await one('names@gmail.com')).name, 'Joanna Smith');
    await ingest([row('names@gmail.com', 'montreal.com', '2026-09-03', { name: 'Guest' })], { source: 'checkout' });
    assert.equal((await one('names@gmail.com')).name, 'Joanna Smith', '"Guest" is not a name');
    const c = await one('names@gmail.com');
    await customers.updateCustomer(c.id, { name: 'Jo Smith (VIP)' });
    await ingest([row('names@gmail.com', 'montreal.com', '2026-09-04', { name: 'Someone Else' })], { source: 'checkout' });
    assert.equal((await one('names@gmail.com')).name, 'Jo Smith (VIP)');
  });

  await t.test('cleaning: typos fixed, junk refused with reasons', async () => {
    const r = await ingest([
      row('Fix.Me@Gmail.con', 'ottawa.com', '2026-10-01'),
      row('test@gmail.com', 'ottawa.com', '2026-10-01'),
      row('ok@gmail.com', 'store-123.myshopify.com', '2026-10-01'),
      row('ok@gmail.com', 'pepscheckoutportal.com', '2026-10-01'),
      row('ceo@acmecorp.com', 'ottawa.com', '2026-10-01'),
      row('jo@randomxyzqq.com', 'ottawa.com', '2026-10-01'),
      row('jo@nullmx.com', 'ottawa.com', '2026-10-01'),
    ], { source: 'upload' });
    assert.equal(r.saved, 2);
    assert.ok(await one('fix.me@gmail.com'));
    assert.ok(await one('ceo@acmecorp.com'), 'company domains with mail servers are kept');
    assert.equal(r.dropped['test or placeholder email'], 1);
    assert.equal(r.dropped['checkout or Shopify admin address, not a store'], 2);
    assert.equal(r.dropped['email domain takes no mail'], 2);
    assert.equal(r.fixes['email typo fixed (gmail.con → gmail.com)'], 1);
  });

  await t.test('DNS trouble: saved as unverified, kept out of campaigns, verified later', async () => {
    await ingest([row('a@slowdns.com', 'ottawa.com', '2026-10-01')], { source: 'checkout' });
    assert.equal((await one('a@slowdns.com')).email_check, 'unverified');
    dnsDown = true;
    await ingest([row('b@later-ok.com', 'ottawa.com', '2026-10-01')], { source: 'checkout' });
    assert.equal((await one('b@later-ok.com')).email_check, 'unverified', 'DNS down: not thrown away');
    const audience = await customers.listAudience({});
    assert.ok(!audience.some((c) => ['a@slowdns.com', 'b@later-ok.com'].includes(c.email)));
    dnsDown = false;
    mail.setResolver(async (d) => {
      if (['gmail.com', 'later-ok.com'].includes(d)) return [{ exchange: `mx.${d}`, priority: 1 }];
      throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    });
    const r = await mail.recheckUnverified();
    assert.deepEqual(r, { verified: 1, removed: 1 });
    assert.equal((await one('b@later-ok.com')).email_check, 'ok');
    assert.equal(await one('a@slowdns.com'), undefined);
  });

  await t.test('unknown stores: kept waiting, or skipped and listed', async () => {
    const kept = await ingest([row('w@gmail.com', 'notyet.com', '2026-10-01', { storeName: 'Not Yet' })], { source: 'checkout' });
    assert.deepEqual(kept.unknownStores, [{ domain: 'notyet.com', storeName: 'Not Yet', count: 1 }]);
    assert.equal((await one('w@gmail.com')).store_id, null);
    assert.deepEqual((await customers.waitingForStore()).map((x) => x.domain), ['notyet.com']);
    const skipped = await ingest([row('s@gmail.com', 'alsonotyet.com', '2026-10-01')], { source: 'upload', unknownStores: 'skip' });
    assert.equal(skipped.saved, 0);
    assert.equal(skipped.dropped['store not set up yet'], 1);
    await db.pool.query(`INSERT INTO stores (domain, brand_name) VALUES ('notyet.com', 'Not Yet')`);
    assert.equal(await customers.linkUnmatched(), 1);
    assert.ok((await one('w@gmail.com')).store_id);
  });

  await t.test('preview writes nothing', async () => {
    const r = await ingest([row('preview@gmail.com', 'ottawa.com', '2026-10-01')], { source: 'upload', apply: false });
    assert.equal(r.added, 1);
    assert.equal(await one('preview@gmail.com'), undefined);
  });

  await t.test('a campaign sends as the store the customer moved to; blocks follow them', async () => {
    const campaigns = require('../server/services/campaigns');
    const { outbox } = require('../server/services/sender');
    await ingest([row('mover@gmail.com', 'montreal.com', '2026-10-01'), row('blocked@gmail.com', 'montreal.com', '2026-10-01')], { source: 'chat' });
    await db.pool.query(`INSERT INTO blocklist (email, store_domain) VALUES ('blocked@gmail.com', 'montreal.com')`);
    const ids = (await db.pool.query(`SELECT id FROM customers WHERE email IN ('mover@gmail.com', 'blocked@gmail.com')`)).rows.map((r) => r.id);
    const c = await campaigns.createCampaign({ mode: 'now', name: 'Move test', customerIds: [...ids, ...ids], subject: 'From {{store_name}}', html: '<p>{{store_name}}</p>' }, { email: 't' });
    assert.equal(c.totalRecipients, 1, 'blocked people are not even added, and nobody twice');
    await ingest([row('mover@gmail.com', 'ottawa.com', '2026-10-03'), row('blocked@gmail.com', 'ottawa.com', '2026-10-03')], { source: 'checkout' });
    outbox.length = 0;
    await campaigns.runDueCampaigns();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].subject, 'From Ottawa Shop');
    const { rows } = await db.pool.query(`SELECT store_domain FROM campaign_recipients WHERE email = 'mover@gmail.com'`);
    assert.equal(rows[0].store_domain, 'ottawa.com');
  });
});
