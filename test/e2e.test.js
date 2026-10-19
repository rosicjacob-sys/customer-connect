// End-to-end run of the API against real Postgres, in dry-run mode.
//
//   TEST_DATABASE_URL=postgres://…/cc_test \
//   TEST_CSP_DATABASE_URL=postgres://…/csp_test   (optional: fake Chat Support Pro)
//   npm test
//
// Both databases are WIPED. Their names must contain "test". Skipped when
// TEST_DATABASE_URL is not set.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const DB = process.env.TEST_DATABASE_URL;
const CSP = process.env.TEST_CSP_DATABASE_URL;
const skip = !DB ? 'set TEST_DATABASE_URL to run' : false;

test('Customer Connect end to end', { skip }, async (t) => {
  for (const url of [DB, CSP].filter(Boolean)) {
    if (!/test/i.test(new URL(url).pathname)) throw new Error(`Refusing to wipe ${url}: its name must contain "test"`);
  }
  Object.assign(process.env, {
    DATABASE_URL: DB, EMAIL_DRY_RUN: 'true', PGSSLMODE: 'disable', JWT_SECRET: 'test-secret',
    APP_URL: 'https://cc.example.com', CHAT_SUPPORT_DATABASE_URL: CSP || '', DEFAULT_FROM_EMAIL: 'promo@example.com',
    // The domain check has its own tests (ingest.test.js); this one must not depend on DNS.
    EMAIL_DOMAIN_CHECK: 'off',
  });

  const wipe = async (url) => {
    const p = new Pool({ connectionString: url });
    await p.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    return p;
  };
  const ccAdmin = await wipe(DB);
  await ccAdmin.end();

  const db = require('../server/db');
  const { hashPassword } = require('../server/auth');
  const { createApp } = require('../server/index');
  const campaigns = require('../server/services/campaigns');
  const { outbox } = require('../server/services/sender');
  await db.migrate();
  await db.pool.query(`INSERT INTO users (email, name, role, password_hash) VALUES ('admin@example.com', 'Admin', 'admin', $1)`,
    [await hashPassword('password123')]);

  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await db.pool.end(); });

  let token = null;
  const api = async (method, path, body, { raw = false, form } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
      body: form || (body ? JSON.stringify(body) : undefined),
      redirect: 'manual',
    });
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${data.error}`), { status: res.status });
    return data;
  };
  const runWorker = () => campaigns.runDueCampaigns();

  await t.test('sign in', async () => {
    await assert.rejects(api('POST', '/api/auth/login', { email: 'admin@example.com', password: 'nope' }), /401/);
    await assert.rejects(api('GET', '/api/stores'), /401/);
    ({ token } = await api('POST', '/api/auth/login', { email: 'ADMIN@example.com', password: 'password123' }));
    assert.equal((await api('GET', '/api/auth/me')).role, 'admin');
  });

  if (CSP) {
    await t.test('sync from Chat Support Pro (read only)', async () => {
      const csp = await wipe(CSP);
      await csp.query(`
        CREATE TABLE stores (id SERIAL PRIMARY KEY, shop_domain TEXT UNIQUE, brand_name TEXT, access_token TEXT,
          primary_color TEXT, email_brand_color TEXT, email_from_address TEXT, email_from_name TEXT,
          country TEXT, store_group TEXT, store_group_name TEXT, is_active BOOLEAN DEFAULT TRUE);
        CREATE TABLE conversations (id SERIAL PRIMARY KEY, shop_id INT, customer_email TEXT, customer_name TEXT, customer_phone TEXT,
          status TEXT DEFAULT 'open', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(), last_message_at TIMESTAMP);
        CREATE TABLE customers (id SERIAL PRIMARY KEY, email TEXT, store_domain TEXT, store_id INT, name TEXT, name_locked BOOLEAN DEFAULT FALSE,
          phone TEXT, country TEXT, moved_to_domain TEXT, from_chat BOOLEAN DEFAULT FALSE, from_upload BOOLEAN DEFAULT FALSE,
          added_manually BOOLEAN DEFAULT FALSE, status TEXT);
        CREATE TABLE blacklist (id SERIAL PRIMARY KEY, email TEXT, store_identifier TEXT, reason TEXT, removed_at TIMESTAMPTZ);
        CREATE TABLE promo_unsubscribes (id SERIAL PRIMARY KEY, email TEXT UNIQUE, unsubscribed_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TABLE promo_sent_emails (id SERIAL PRIMARY KEY, email TEXT, store_domain TEXT, store_name TEXT, sent_at TIMESTAMPTZ DEFAULT NOW());
        INSERT INTO stores (shop_domain, brand_name, access_token, primary_color, email_brand_color, email_from_address, country, store_group, store_group_name)
        VALUES ('torontopeptides.shop', 'Toronto Peptides', 'secret-token', '#667eea', '#D23025', 'hello@torontopeptides.shop', 'CA', 'peptides', 'Peptides Group'),
               ('https://Dallas-Peptides.com/', 'Dallas Peptides', 'secret-token', '#0924AF', NULL, NULL, 'US', 'peptides', 'Peptides Group');
        INSERT INTO customers (email, store_domain, name, from_chat, from_upload, status, moved_to_domain) VALUES
          ('ana@gmail.com', 'torontopeptides.shop', 'Ana', TRUE, FALSE, NULL, NULL),
          ('bob@gmail.com', 'torontopeptides.shop', 'Bob', FALSE, TRUE, NULL, NULL),
          ('cyd@gmail.com', 'dallas-peptides.com', 'Guest', FALSE, TRUE, NULL, NULL),
          ('dee@gmail.com', 'dallas-peptides.com', 'Dee', FALSE, TRUE, 'blacklisted', NULL),
          ('eve@gmail.com', 'dallas-peptides.com', 'Eve', FALSE, TRUE, NULL, NULL);
        INSERT INTO conversations (shop_id, customer_email, customer_name, customer_phone, last_message_at) VALUES
          (1, 'ana@gmail.com', 'Ana', '416-555-0100', '2026-10-01 10:00');
        INSERT INTO blacklist (email, store_identifier) VALUES ('old@gmail.com', NULL);
        INSERT INTO blacklist (email, store_identifier, removed_at) VALUES ('lifted@gmail.com', NULL, NOW());
        INSERT INTO promo_unsubscribes (email) VALUES ('eve@gmail.com');
        INSERT INTO promo_sent_emails (email, store_domain, store_name) VALUES ('bob@gmail.com', 'torontopeptides.shop', 'Toronto Peptides');`);
      t.after(() => csp.end());

      const r = await api('POST', '/api/chat-support/sync');
      assert.deepEqual(r.stores, { added: 2, updated: 0, conflicts: [] });
      assert.equal(r.customers.chats, 1, 'ana, from her conversation');
      assert.equal(r.customers.files, 4, "bob, cyd, dee, eve, from CSP's uploads");
      assert.equal(r.customers.added, 5);
      assert.equal(r.customers.blocked, 1, 'dee is blacklisted there');
      assert.equal(r.optOuts.unsubscribes, 1);
      assert.equal(r.optOuts.blocks, 1, 'lifted blacklist rows are not copied');
      const anaRow = (await api('GET', '/api/customers?search=ana')).rows[0];
      assert.equal(anaRow.last_seen_at, '2026-10-01T10:00:00.000Z', 'dated by her last chat');
      assert.equal(anaRow.phone, '+14165550100');
      const again = await api('POST', '/api/chat-support/sync');
      assert.equal(again.stores.updated, 2, 're-running updates rather than duplicating');
      assert.equal(again.full, false, 'the second sync only reads changes');
      assert.equal(again.customers.added, 0);

      const stores = await api('GET', '/api/stores');
      const toronto = stores.find((s) => s.domain === 'torontopeptides.shop');
      assert.equal(toronto.brandColor, '#D23025');
      assert.equal(toronto.fromEmail, 'hello@torontopeptides.shop');
      assert.equal(toronto.fromChatSupport, true);
      assert.ok(stores.some((s) => s.domain === 'dallas-peptides.com'), 'domain cleaned');
      assert.deepEqual((await api('GET', '/api/groups')).map((g) => g.name), ['Peptides Group']);

      // The connection really is read only.
      const bridgePool = new Pool({ connectionString: CSP, options: '-c default_transaction_read_only=on' });
      await assert.rejects(bridgePool.query(`DELETE FROM customers`), /read-only/);
      await bridgePool.end();
    });
  } else {
    await api('POST', '/api/stores', { domain: 'torontopeptides.shop', brandName: 'Toronto Peptides', brandColor: '#D23025', country: 'CA', storeGroup: 'peptides', storeGroupName: 'Peptides Group' });
    await api('POST', '/api/stores', { domain: 'dallas-peptides.com', brandName: 'Dallas Peptides', country: 'US', storeGroup: 'peptides', storeGroupName: 'Peptides Group' });
  }

  let toronto;
  await t.test('stores and import', async () => {
    toronto = (await api('GET', '/api/stores')).find((s) => s.domain === 'torontopeptides.shop');
    await assert.rejects(api('POST', '/api/stores', { domain: 'torontopeptides.shop', brandName: 'Dup' }), /409/);
    const template = await (await api('GET', '/api/customers/import/template', null, { raw: true })).text();
    assert.match(template, /^customer_name,email,store_name,store_url,phone,last_order_date\n/);
    const csv = [
      'customer_name,email,store_name,store_url,phone,last_order_date',
      'Fay,fay@gmail.con,,torontopeptides.shop,,', // typo fixed
      'Gus,gus@yahoo.com,,etobicokepeptides.ca,,', // old domain → main store
      'Tess,test123@gmail.com,,torontopeptides.shop,,', // test row, left out
      'Ana Again,ana@gmail.com,,https://dallas-peptides.com/shop,,2026-10-05', // newer than her chat: moves
      'Hal,hal@gmail.com,Unknown Store,unknownstore.com,613-555-0101,', // store not set up
      ',bad-email,,torontopeptides.shop,,',
    ].join('\n');
    const form = () => { const f = new FormData(); f.append('file', new Blob([csv], { type: 'text/csv' }), 'c.csv'); return f; };
    const preview = await api('POST', '/api/customers/import', null, { form: form() });
    assert.equal(preview.preview, true);
    assert.equal(preview.saved, 3);
    assert.equal(preview.added, CSP ? 2 : 3);
    assert.equal(preview.storeChanged, CSP ? 1 : 0);
    assert.equal(preview.fixes['email typo fixed (gmail.con → gmail.com)'], 1);
    assert.equal(preview.fixes['old store domain moved to its main store'], 1);
    assert.deepEqual(preview.dropped, { 'test or placeholder email': 1, 'not an email address': 1, 'store not set up yet': 1 });
    assert.deepEqual(preview.unknownStores, [{ domain: 'unknownstore.com', storeName: 'Unknown Store', count: 1 }]);
    assert.equal(await (await api('GET', '/api/customers?search=fay')).total, 0, 'the preview saved nothing');

    // "Add these stores", then the same file imports Hal too.
    const added = await api('POST', '/api/stores/bulk', { stores: preview.unknownStores.map((u) => ({ domain: u.domain, brandName: u.storeName })) });
    assert.equal(added.added.length, 1);
    const applied = await api('POST', '/api/customers/import?apply=1', null, { form: form() });
    assert.equal(applied.saved, 4);
    assert.equal(applied.added, CSP ? 3 : 4);
    const fay = (await api('GET', '/api/customers?search=fay')).rows[0];
    assert.equal(fay.email, 'fay@gmail.com');
    assert.equal(fay.from_upload, true);
    const hal = (await api('GET', '/api/customers?search=hal')).rows[0];
    assert.equal(hal.store_name, 'Unknown Store');
    assert.equal(hal.phone, '+16135550101');
    const ana = (await api('GET', '/api/customers?search=ana%40')).rows[0];
    assert.equal(ana.store_domain, 'dallas-peptides.com');
    assert.equal(ana.name, 'Ana Again');
    if (CSP) assert.equal((await api('GET', `/api/customers/${ana.id}/history`)).length, 2, 'Toronto stays in her history');

    const csvRes = await api('GET', '/api/customers/export', null, { raw: true });
    assert.match(await csvRes.text(), /^customer_name,email,store_name,store_url,phone,last_order_date/);
  });

  let templateId;
  const html = `<!--@map product_image_url from store_brand_color
Red #D23025 = https://cdn.example.com/red.png
default = https://cdn.example.com/blue.png
-->
<html><body style="background:{{store_brand_color_light}}">{{moved_banner}}
<p>Hi {{customer_name}}, from {{store_name}}</p>
<img src="{{product_image_url}}" alt="">
<a href="{{store_url}}/collections/all">Shop Now</a>
<a href="{{unsubscribe_url}}">Unsubscribe</a></body></html>`;

  await t.test('templates and test send', async () => {
    templateId = (await api('POST', '/api/templates', { name: 'October', subject: '{{customer_name}}, a thank-you from {{store_name}}', html, storeGroup: 'peptides' })).id;
    assert.equal((await api('GET', '/api/templates?storeGroup=peptides')).length, 1);
    await api('POST', '/api/test-send', { to: 'me@example.com', storeId: toronto.id, subject: 'Test {{store_name}}', html, campaignName: 'October' });
    const msg = outbox[0];
    assert.equal(msg.to[0], 'me@example.com');
    assert.equal(msg.subject, 'Test Toronto Peptides');
    assert.match(msg.html, /red\.png/);
    assert.match(msg.html, /utm_campaign=october&utm_content=shop-now/);
    assert.doesNotMatch(msg.html, /@map/);
  });

  let unsubscribeUrl;
  await t.test('send now: opt-outs are skipped, everyone else gets a personal email', async () => {
    const audience = await api('GET', '/api/audience');
    const emails = audience.rows.map((r) => r.email);
    assert.ok(!emails.includes('eve@gmail.com') || !CSP, 'unsubscribed people are left out of the audience');
    assert.ok(!emails.includes('dee@gmail.com'), 'archived/blacklisted are left out');

    // Someone unsubscribes in Chat Support Pro after the audience was picked.
    const ids = audience.rows.map((r) => r.id);
    if (CSP) {
      const csp = new Pool({ connectionString: CSP });
      await csp.query(`INSERT INTO promo_unsubscribes (email) VALUES ('fay@gmail.com')`);
      await csp.end();
    }
    outbox.length = 0;
    const c = await api('POST', '/api/campaigns', { mode: 'now', name: 'October Blast', customerIds: ids, templateId, subject: '{{customer_name}}, a thank-you from {{store_name}}', html, storeGroup: null });
    assert.equal(c.totalRecipients, ids.length);
    await runWorker();
    const detail = await api('GET', `/api/campaigns/${c.id}`);
    assert.equal(detail.status, 'completed');
    assert.equal(detail.statusBreakdown.pending, 0);
    if (CSP) assert.deepEqual(detail.skipReasons, [{ reason: 'chat_support', n: 1 }]);
    assert.equal(outbox.length, detail.sentCount);

    assert.equal(new Set(outbox.map((m) => m.to[0])).size, outbox.length, 'one email per person');
    const ana = outbox.find((m) => m.to[0] === 'ana@gmail.com');
    assert.equal(ana.subject, 'Ana Again, a thank-you from Dallas Peptides', 'sent as her latest store');
    assert.equal(ana.from, 'Dallas Peptides <promo@example.com>');
    const gus = outbox.find((m) => m.to[0] === 'gus@yahoo.com');
    assert.equal(gus.from, CSP ? 'Toronto Peptides <hello@torontopeptides.shop>' : 'Toronto Peptides <promo@example.com>');
    assert.match(ana.headers['List-Unsubscribe'], /^<https:\/\/cc\.example\.com\/u\?e=ana%40gmail\.com&t=[0-9a-f]{32}>$/);
    unsubscribeUrl = ana.headers['List-Unsubscribe'].slice(1, -1);
    if (CSP) {
      const cyd = outbox.find((m) => m.to[0] === 'cyd@gmail.com');
      assert.match(cyd.subject, /^cyd@gmail\.com, /, '"Guest" falls back to the email');
      assert.match(cyd.html, /https:\/\/dallas-peptides\.com\/collections\/all\?utm_source=dallas-peptides\.com/);
    }
    const sent = await api('GET', '/api/sent?search=ana');
    assert.equal(sent[0].campaign_name, 'October Blast');
  });

  await t.test('unsubscribe link: GET asks, POST one-click unsubscribes', async () => {
    const path = unsubscribeUrl.replace('https://cc.example.com', '');
    const get = await api('GET', path, null, { raw: true });
    assert.match(await get.text(), /<form method="post"/);
    assert.equal((await db.pool.query(`SELECT 1 FROM unsubscribes WHERE email = 'ana@gmail.com'`)).rowCount, 0);
    const post = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(post.status, 200);
    assert.equal((await db.pool.query(`SELECT source FROM unsubscribes WHERE email = 'ana@gmail.com'`)).rows[0].source, 'one_click');
    const bad = await api('GET', path.replace(/t=[0-9a-f]+/, 't=00000000000000000000000000000000'), null, { raw: true });
    assert.equal(bad.status, 400);
  });

  await t.test('schedule: batches, interval, daily limit, pause/resume, edit, stop', async () => {
    const { rows } = await db.pool.query(`SELECT id FROM customers WHERE status IS NULL ORDER BY id`);
    const ids = rows.map((r) => r.id);
    // 50 recipients: add some customers by hand.
    for (let i = 0; i < 50; i++) await api('POST', '/api/customers', { email: `bulk${i}@gmail.com`, name: `Bulk ${i}`, storeId: toronto.id });
    const all = (await db.pool.query(`SELECT id FROM customers WHERE email LIKE 'bulk%' ORDER BY id`)).rows.map((r) => r.id);

    await assert.rejects(api('POST', '/api/campaigns', { mode: 'scheduled', customerIds: all, subject: 's', html: 'h', batchSize: 5, intervalMinutes: 60, startAt: '2026-01-01T00:00', timezone: 'Mars/Base' }), /Unknown timezone/);
    await assert.rejects(api('POST', '/api/campaigns', { mode: 'scheduled', customerIds: all, subject: 's', html: 'h', batchSize: 5, intervalMinutes: 60, startAt: '2026-01-01T00:00', windowStart: '08:00', timezone: 'UTC' }), /both/);

    const c = await api('POST', '/api/campaigns', {
      mode: 'scheduled', name: 'Drip', customerIds: all, subject: 'Hi {{customer_name}}', html: '<p>{{store_name}}</p>',
      batchSize: 10, intervalMinutes: 60, startAt: '2020-01-01T00:00', timezone: 'America/New_York', sendLimit: 25,
    });
    assert.equal(c.totalRecipients, 50);
    await runWorker();
    let d = await api('GET', `/api/campaigns/${c.id}`);
    assert.equal(d.sentCount, 10);
    assert.equal(d.status, 'running');
    const gap = new Date(d.nextFireAt) - Date.now();
    assert.ok(gap > 59 * 60000 && gap <= 60 * 60000 + 5000, `next batch about an hour out (${gap}ms)`);

    // Not due yet: nothing happens.
    await runWorker();
    assert.equal((await api('GET', `/api/campaigns/${c.id}`)).sentCount, 10);

    // Make it due twice more; the daily limit of 25 caps the third batch at 5.
    for (let i = 0; i < 2; i++) {
      await db.pool.query(`UPDATE campaigns SET next_fire_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [c.id]);
      await runWorker();
    }
    d = await api('GET', `/api/campaigns/${c.id}`);
    assert.equal(d.sentCount, 25);
    const tomorrow = new Date(d.nextFireAt);
    assert.ok(tomorrow - Date.now() > 0 && tomorrow.toISOString() >= require('../server/lib/schedule').startOfTomorrowUtc('America/New_York').toISOString(),
      'waits for tomorrow once the daily limit is used');

    // Pause, edit (raise the limit, add sending hours), resume.
    await api('POST', `/api/campaigns/${c.id}/pause`);
    await assert.rejects(api('POST', `/api/campaigns/${c.id}/pause`), /409/);
    d = await api('PATCH', `/api/campaigns/${c.id}`, { sendLimit: '', windowStart: '00:00', windowEnd: '23:59', name: 'Drip v2' });
    assert.equal(d.status, 'paused');
    assert.equal(d.name, 'Drip v2');
    assert.equal(d.sendLimit, null);
    d = await api('POST', `/api/campaigns/${c.id}/resume`);
    assert.equal(d.status, 'scheduled');
    await db.pool.query(`UPDATE campaigns SET next_fire_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [c.id]);
    await runWorker();
    d = await api('GET', `/api/campaigns/${c.id}`);
    const S = require('../server/lib/schedule');
    if (S.inWindow({ window_start: '00:00', window_end: '23:59', timezone: 'America/New_York' }, new Date())) {
      assert.equal(d.sentCount, 35, 'the next batch goes out once the limit is lifted');
    }

    // A send cut off by a restart is marked failed, never sent twice.
    const { rows: [p] } = await db.pool.query(
      `UPDATE campaign_recipients SET status = 'sending' WHERE id = (SELECT MIN(id) FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending') RETURNING id`, [c.id]);
    await db.pool.query(`UPDATE campaigns SET next_fire_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [c.id]);
    await runWorker();
    const { rows: [after] } = await db.pool.query('SELECT status, error FROM campaign_recipients WHERE id = $1', [p.id]);
    assert.equal(after.status, 'failed');
    assert.match(after.error, /Interrupted/);

    await assert.rejects(api('DELETE', `/api/campaigns/${c.id}`), /409/);
    await api('POST', `/api/campaigns/${c.id}/cancel`);
    await db.pool.query(`UPDATE campaigns SET next_fire_at = NOW() WHERE id = $1`, [c.id]);
    const before = (await api('GET', `/api/campaigns/${c.id}`)).sentCount;
    await runWorker();
    assert.equal((await api('GET', `/api/campaigns/${c.id}`)).sentCount, before, 'a stopped campaign sends nothing');
    await api('DELETE', `/api/campaigns/${c.id}`);
    assert.ok(ids.length > 0);
  });

  await t.test('two workers never send the same batch', async () => {
    const all = (await db.pool.query(`SELECT id FROM customers WHERE email LIKE 'bulk%' ORDER BY id`)).rows.map((r) => r.id);
    outbox.length = 0;
    const c = await api('POST', '/api/campaigns', { mode: 'now', name: 'Race', customerIds: all, subject: 's', html: '<p>h</p>' });
    await Promise.all([runWorker(), runWorker(), runWorker()]);
    const d = await api('GET', `/api/campaigns/${c.id}`);
    assert.equal(d.sentCount, 50);
    const raceTo = outbox.filter((m) => m.label === 'Race').map((m) => m.to[0]);
    assert.equal(new Set(raceTo).size, raceTo.length, 'no duplicates');
  });

  await t.test('skip already emailed, reset, opt-out list', async () => {
    const withSkip = await api('GET', '/api/audience?skipAlreadyEmailed=1');
    assert.ok(!withSkip.rows.some((r) => r.email === 'bulk1@gmail.com'));
    const sent = await api('GET', '/api/sent?search=bulk1%40');
    await api('POST', '/api/sent/reset', { ids: sent.map((r) => r.id) });
    assert.ok((await api('GET', '/api/audience?skipAlreadyEmailed=1')).rows.some((r) => r.email === 'bulk1@gmail.com'));

    await api('POST', '/api/opt-outs/blocks', { email: 'bulk2@gmail.com', storeDomain: 'torontopeptides.shop', reason: 'asked by phone' });
    assert.ok(!(await api('GET', '/api/audience')).rows.some((r) => r.email === 'bulk2@gmail.com'));
    const optOuts = await api('GET', '/api/opt-outs');
    assert.ok(optOuts.unsubscribes.some((u) => u.email === 'ana@gmail.com'));
  });

  await t.test('users: editors cannot manage users', async () => {
    await api('POST', '/api/users', { email: 'ed@example.com', name: 'Ed', role: 'editor', password: 'password456' });
    const adminToken = token;
    ({ token } = await api('POST', '/api/auth/login', { email: 'ed@example.com', password: 'password456' }));
    await assert.rejects(api('GET', '/api/users'), /403/);
    assert.ok((await api('GET', '/api/campaigns')).length >= 1);
    token = adminToken;
    const ed = (await api('GET', '/api/users')).find((u) => u.email === 'ed@example.com');
    await api('PUT', `/api/users/${ed.id}`, { isActive: false });
    ({ token } = await api('POST', '/api/auth/login', { email: 'admin@example.com', password: 'password123' }));
  });
});
