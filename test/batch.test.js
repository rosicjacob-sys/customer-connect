// Store rules (assigning a store that isn't set up, merging stores) and
// batch actions, through the API against real Postgres. Needs
// TEST_DATABASE_URL (the database is WIPED; its name must contain "test").

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const DB = process.env.TEST_DATABASE_URL;

test('store rules and batch actions', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async (t) => {
  if (!/test/i.test(new URL(DB).pathname)) throw new Error('TEST_DATABASE_URL must name a database containing "test"');
  Object.assign(process.env, {
    DATABASE_URL: DB, EMAIL_DRY_RUN: 'true', PGSSLMODE: 'disable', JWT_SECRET: 'test-secret',
    APP_URL: 'https://cc.example.com', CHAT_SUPPORT_DATABASE_URL: '', CHAT_SUPPORT_API_URL: '', EMAIL_DOMAIN_CHECK: 'off',
  });
  const admin = new Pool({ connectionString: DB });
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();

  const db = require('../server/db');
  const { hashPassword } = require('../server/auth');
  const { createApp } = require('../server/index');
  const { ingest } = require('../server/services/ingest');
  await db.migrate();
  await db.pool.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('admin@example.com', 'Admin', 'admin', $1)`,
    [await hashPassword('password123')]);
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await db.pool.end(); });

  let token = null;
  const api = async (method, path, body, { raw = false } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${data.error}`), { status: res.status });
    return data;
  };
  ({ token } = await api('POST', '/api/auth/login', { email: 'admin@example.com', password: 'password123' }));
  const one = async (email) => (await db.pool.query('SELECT * FROM customers WHERE email = $1', [email])).rows[0];
  const links = async (email) => (await db.pool.query('SELECT store_domain, store_id, sources, first_seen_at, last_seen_at FROM customer_stores WHERE email = $1 ORDER BY store_domain', [email])).rows;
  const storeId = async (domain) => (await db.pool.query('SELECT id FROM stores WHERE domain = $1', [domain])).rows[0]?.id;

  await api('POST', '/api/stores', { domain: 'lexarcanada.ca', brandName: 'Lexar Canada', storeGroup: 'lexar', storeGroupName: 'LEXAR Peptides', country: 'CA' });
  await api('POST', '/api/stores', { domain: 'ottawa.com', brandName: 'Ottawa', country: 'CA' });
  await api('POST', '/api/stores', { domain: 'oldottawa.com', brandName: 'Old Ottawa', country: 'CA' });
  const canada = await storeId('lexarcanada.ca');

  // ann: only at Lexar Ajax (not set up). bea: Lexar Canada in Sept, Ajax in Oct.
  // cal: Ajax in Sept, then Ottawa in Oct (current store Ottawa).
  await ingest([
    { email: 'ann@gmail.com', storeUrl: 'lexarajax.com', storeName: 'Lexar Ajax', seenAt: '2026-10-05T10:00:00Z' },
    { email: 'bea@gmail.com', storeUrl: 'lexarcanada.ca', seenAt: '2026-09-01T10:00:00Z' },
    { email: 'bea@gmail.com', storeUrl: 'lexarajax.com', storeName: 'Lexar Ajax', seenAt: '2026-10-01T10:00:00Z' },
    { email: 'cal@gmail.com', storeUrl: 'lexarajax.com', storeName: 'Lexar Ajax', seenAt: '2026-09-01T10:00:00Z' },
    { email: 'cal@gmail.com', storeUrl: 'ottawa.com', seenAt: '2026-10-10T10:00:00Z' },
    { email: 'dan@gmail.com', storeUrl: 'www.lexarburnaby.com', storeName: 'Lexar Burnaby', seenAt: '2026-10-02T10:00:00Z' },
  ], { source: 'chat' });

  await t.test('waiting stores can be assigned to an existing store', async () => {
    assert.deepEqual((await api('GET', '/api/stores/waiting')).map((w) => w.domain).sort(), ['lexarajax.com', 'lexarburnaby.com']);
    const r = await api('POST', '/api/stores/assign', { domains: ['lexarajax.com', 'lexarburnaby.com'], storeId: canada });
    assert.equal(r.customersMoved, 3, 'ann, bea, dan; cal stays at Ottawa');
    assert.deepEqual(await api('GET', '/api/stores/waiting'), []);

    const ann = await one('ann@gmail.com');
    assert.equal(ann.store_id, canada);
    assert.equal(ann.store_domain, 'lexarcanada.ca');
    assert.equal(ann.last_seen_at.toISOString(), '2026-10-05T10:00:00.000Z', 'their real last order date is kept');

    const beaLinks = await links('bea@gmail.com');
    assert.equal(beaLinks.length, 1, 'two links to what is now one store become one');
    assert.equal(beaLinks[0].first_seen_at.toISOString(), '2026-09-01T10:00:00.000Z');
    assert.equal(beaLinks[0].last_seen_at.toISOString(), '2026-10-01T10:00:00.000Z');

    assert.equal((await one('cal@gmail.com')).store_domain, 'ottawa.com', 'a later store elsewhere is kept');
    assert.deepEqual((await links('cal@gmail.com')).map((l) => l.store_domain), ['lexarcanada.ca', 'ottawa.com']);

    const stores = await api('GET', '/api/stores');
    assert.deepEqual(stores.find((s) => s.id === canada).aliases, ['lexarajax.com', 'lexarburnaby.com']);
  });

  await t.test('the rule sends later customers from that domain to the store', async () => {
    const r = await ingest([{ email: 'eve@gmail.com', storeUrl: 'https://www.LexarAjax.com/', seenAt: '2026-10-12T10:00:00Z' }], { source: 'checkout' });
    assert.equal(r.unknownStores.length, 0);
    assert.equal((await one('eve@gmail.com')).store_id, canada);
  });

  await t.test("a store's own domain can't be assigned; removing a rule leaves customers", async () => {
    await assert.rejects(api('POST', '/api/stores/assign', { domains: ['ottawa.com'], storeId: canada }), /409.*merge the stores/);
    await api('DELETE', '/api/stores/aliases/lexarburnaby.com');
    assert.equal((await one('dan@gmail.com')).store_id, canada, 'dan stays');
    await ingest([{ email: 'fay@gmail.com', storeUrl: 'lexarburnaby.com', seenAt: '2026-10-12T10:00:00Z' }], { source: 'chat' });
    assert.equal((await one('fay@gmail.com')).store_id, null, 'new customers wait again');
    // Adding a store with an assigned domain drops the rule.
    await api('POST', '/api/stores', { domain: 'lexarajax.com', brandName: 'Lexar Ajax' });
    assert.deepEqual((await api('GET', '/api/stores')).find((s) => s.id === canada).aliases, []);
    await api('POST', '/api/stores/batch', { ids: [await storeId('lexarajax.com')], action: 'delete' });
    await api('POST', '/api/stores/assign', { domains: ['lexarajax.com'], storeId: canada });
  });

  await t.test('merging stores moves customers and keeps the domain as a rule', async () => {
    const ottawa = await storeId('ottawa.com');
    const old = await storeId('oldottawa.com');
    await ingest([{ email: 'gus@gmail.com', storeUrl: 'oldottawa.com', seenAt: '2026-10-03T10:00:00Z' }], { source: 'chat' });
    const r = await api('POST', '/api/stores/batch', { ids: [old, ottawa], action: 'merge', targetId: ottawa });
    assert.equal(r.changed, 1);
    assert.equal(await storeId('oldottawa.com'), undefined, 'merged store is deleted');
    assert.equal((await one('gus@gmail.com')).store_id, ottawa);
    await ingest([{ email: 'hal@gmail.com', storeUrl: 'oldottawa.com', seenAt: '2026-10-13T10:00:00Z' }], { source: 'chat' });
    assert.equal((await one('hal@gmail.com')).store_id, ottawa);
  });

  await t.test('store batch: segment, group, country, active', async () => {
    const ids = [canada, await storeId('ottawa.com')];
    const { segmentId } = await api('POST', '/api/stores/batch', { ids, action: 'segment-add', segmentName: 'East' });
    assert.equal((await api('POST', '/api/stores/batch', { ids, action: 'segment-add', segmentName: 'east' })).segmentId, segmentId, 'same name, same segment');
    assert.deepEqual((await api('GET', '/api/segments')).segments.find((s) => s.id === segmentId).storeIds.sort(), ids.sort());
    await api('POST', '/api/stores/batch', { ids: [canada], action: 'segment-remove', segmentId });
    assert.deepEqual((await api('GET', '/api/segments')).segments.find((s) => s.id === segmentId).storeIds, [ids.find((x) => x !== canada)]);
    await api('POST', '/api/stores/batch', { ids, action: 'group', storeGroup: 'East Coast' });
    await api('POST', '/api/stores/batch', { ids, action: 'country', country: 'us' });
    await api('POST', '/api/stores/batch', { ids, action: 'deactivate' });
    const after = (await api('GET', '/api/stores')).filter((s) => ids.includes(s.id));
    assert.ok(after.every((s) => s.storeGroup === 'east-coast' && s.storeGroupName === 'East Coast' && s.country === 'US' && !s.isActive));
    await assert.rejects(api('POST', '/api/stores/batch', { ids, action: 'country', country: 'Canada' }), /400/);
    await api('POST', '/api/stores/batch', { ids, action: 'activate' });
  });

  await t.test('customer batch: select all matching, except some', async () => {
    const all = await api('GET', '/api/customers?status=active&search=gmail');
    const sel = { all: true, filters: { status: 'active', search: 'gmail' }, exceptIds: [(await one('ann@gmail.com')).id] };
    const r = await api('POST', '/api/customers/batch', { action: 'archive', selection: sel });
    assert.equal(r.selected, all.total - 1);
    assert.equal((await one('ann@gmail.com')).status, null, 'unticked one is left alone');
    assert.equal((await one('bea@gmail.com')).status, 'archived');
    await api('POST', '/api/customers/batch', { action: 'restore', selection: { all: true, filters: { status: 'archived' } } });
    assert.equal((await api('GET', '/api/customers?status=archived')).total, 0);
  });

  await t.test('customer batch: move, block, unsubscribe, export, delete', async () => {
    const ottawa = await storeId('ottawa.com');
    const ids = [(await one('ann@gmail.com')).id, (await one('bea@gmail.com')).id];
    const moved = await api('POST', '/api/customers/batch', { action: 'move', storeId: ottawa, selection: { ids } });
    assert.equal(moved.changed, 2);
    assert.equal((await one('ann@gmail.com')).store_id, ottawa);
    assert.ok((await links('ann@gmail.com')).some((l) => l.store_domain === 'lexarcanada.ca'), 'old store stays in history');

    await api('POST', '/api/customers/batch', { action: 'block', selection: { ids: [ids[0]] } });
    await api('POST', '/api/customers/batch', { action: 'unsubscribe', selection: { ids: [ids[1]] } });
    const optOuts = await api('GET', '/api/opt-outs');
    assert.deepEqual(optOuts.blocks.map((b) => b.email), ['ann@gmail.com']);
    assert.deepEqual(optOuts.unsubscribes.map((u) => u.email), ['bea@gmail.com']);

    const csv = await (await api('POST', '/api/customers/export', { selection: { ids } }, { raw: true })).text();
    assert.equal(csv.split('\n').length, 3);
    assert.match(csv, /ann@gmail\.com/);

    await api('POST', '/api/customers/batch', { action: 'delete', selection: { ids: [ids[0]] } });
    assert.equal(await one('ann@gmail.com'), undefined);
    assert.deepEqual(await links('ann@gmail.com'), [], 'history goes too');
    // Back with a new order: a fresh customer with only the new details.
    await ingest([{ email: 'ann@gmail.com', name: 'Ann New', storeUrl: 'lexarcanada.ca', seenAt: '2026-10-20T10:00:00Z' }], { source: 'checkout' });
    assert.equal((await one('ann@gmail.com')).name, 'Ann New');
    assert.deepEqual((await links('ann@gmail.com')).map((l) => l.store_domain), ['lexarcanada.ca']);

    await api('POST', '/api/opt-outs/batch', { action: 'remove', unsubscribeIds: optOuts.unsubscribes.map((u) => u.id), blockIds: optOuts.blocks.map((b) => b.id) });
    const none = await api('GET', '/api/opt-outs');
    assert.equal(none.unsubscribes.length + none.blocks.length, 0);
    await assert.rejects(api('POST', '/api/customers/batch', { action: 'archive', selection: { ids: [] } }), /400/);
  });

  await t.test('campaign and template batch', async () => {
    const tpl = async (name) => (await api('POST', '/api/templates', { name, subject: 'Hi', html: '<p>Hi {{unsubscribe_url}}</p>' })).id;
    const tIds = [await tpl('A'), await tpl('B')];
    assert.equal((await api('POST', '/api/templates/batch', { action: 'delete', ids: tIds })).changed, 2);

    const make = async (name) => api('POST', '/api/campaigns', {
      name, subject: 'Hi', html: '<p>Hi {{unsubscribe_url}}</p>', mode: 'scheduled', batchSize: 1, intervalMinutes: 60,
      startAt: '2099-01-01T09:00', timezone: 'UTC', customerIds: [(await one('eve@gmail.com')).id],
    });
    const c1 = await make('One');
    const c2 = await make('Two');
    const paused = await api('POST', '/api/campaigns/batch', { action: 'pause', ids: [c1.id, c2.id] });
    assert.equal(paused.changed, 2);
    const again = await api('POST', '/api/campaigns/batch', { action: 'pause', ids: [c1.id] });
    assert.equal(again.changed, 0);
    assert.equal(again.skipped.length, 1, "can't pause a paused campaign: listed, not an error");
    const deleted = await api('POST', '/api/campaigns/batch', { action: 'delete', ids: [c1.id] });
    assert.equal(deleted.skipped.length, 1, 'stop it first');
    await api('POST', '/api/campaigns/batch', { action: 'cancel', ids: [c1.id, c2.id] });
    assert.equal((await api('POST', '/api/campaigns/batch', { action: 'delete', ids: [c1.id, c2.id] })).changed, 2);
  });
});
