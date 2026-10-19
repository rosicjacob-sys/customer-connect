// server/services/chatSupportBridge.js
// Optional link to the Chat Support Pro database (CHAT_SUPPORT_DATABASE_URL).
// Strictly read only: the connection runs every transaction read only, so
// nothing here can change Chat Support Pro.
//
//   syncFromChatSupport()  copies stores, customers, opt-outs and the sent
//                          ledger into Customer Connect (re-runnable).
//   optOutsFor(emails)     live check against CSP's unsubscribes and
//                          blacklist, used before every batch.

const { Pool } = require('pg');
const config = require('../config');
const db = require('../db');
const { cleanDomain } = require('../lib/merge');
const { ingest } = require('./ingest');

let cspPool = null;
function getPool() {
  if (!cspPool) {
    const url = config.chatSupportDatabaseUrl;
    const local = /localhost|127\.0\.0\.1|\.internal|host=\/|@\/|\?host=/.test(url);
    cspPool = new Pool({
      connectionString: url,
      ssl: local || process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
      application_name: 'customer-connect-readonly',
      options: '-c default_transaction_read_only=on',
    });
    cspPool.on('error', (err) => console.error('[chatSupport] idle client error:', err.message));
  }
  return cspPool;
}

const isConfigured = () => !!config.chatSupportDatabaseUrl;

async function tableColumns(table) {
  const { rows } = await getPool().query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table]);
  return new Set(rows.map((r) => r.column_name));
}

// Only the columns that exist (older CSP databases lack some), never "*",
// so secrets such as store access tokens are never read.
function pick(cols, wanted) {
  return wanted.map(([col, alias]) => (cols.has(col) ? `${col} AS ${alias || col}` : `NULL AS ${alias || col}`)).join(', ');
}

// ── Live opt-out check ──────────────────────────────────────────────────────

async function optOutsFor(emails) {
  const pool = getPool();
  const [unsubCols, blCols] = await Promise.all([tableColumns('promo_unsubscribes'), tableColumns('blacklist')]);
  const [unsub, bl] = await Promise.all([
    unsubCols.size
      ? pool.query('SELECT LOWER(email) AS email FROM promo_unsubscribes WHERE LOWER(email) = ANY($1)', [emails])
      : { rows: [] },
    blCols.size
      ? pool.query(
          `SELECT LOWER(email) AS email, store_identifier FROM blacklist
            WHERE ${blCols.has('removed_at') ? 'removed_at IS NULL AND' : ''} LOWER(email) = ANY($1)`, [emails])
      : { rows: [] },
  ]);
  // A blacklisting at any store counts everywhere: it follows the person.
  const out = new Set([...unsub.rows, ...bl.rows].map((r) => r.email));
  return (email) => out.has(email);
}

// ── Sync ────────────────────────────────────────────────────────────────────

async function syncStores() {
  const cols = await tableColumns('stores');
  if (!cols.size) throw new Error('No stores table found in the Chat Support Pro database');
  const { rows } = await getPool().query(`SELECT ${pick(cols, [
    ['id'], ['shop_domain'], ['brand_name'], ['store_group'], ['store_group_name'], ['country'],
    ['email_brand_color'], ['primary_color'], ['email_from_address'], ['email_from_name'], ['is_active'],
  ])} FROM stores`);

  let added = 0, updated = 0;
  const conflicts = [];
  for (const s of rows) {
    const domain = cleanDomain(s.shop_domain);
    if (!domain) continue;
    const values = [
      s.id, domain, s.brand_name || domain, s.store_group || null, s.store_group_name || s.store_group || null,
      s.country || null, s.email_brand_color || s.primary_color || null,
      s.email_from_address || null, s.email_from_name || null, s.is_active !== false,
    ];
    try {
      // Matched by CSP id first, then by domain (a store added here by hand
      // before the first sync is linked rather than duplicated).
      const { rowCount } = await db.pool.query(`
        UPDATE stores SET csp_store_id = $1, domain = $2, brand_name = $3, store_group = $4, store_group_name = $5,
               country = $6, brand_color = $7, from_email = $8, from_name = $9, is_active = $10, updated_at = NOW()
         WHERE id = (SELECT id FROM stores WHERE csp_store_id = $1 OR (csp_store_id IS NULL AND domain = $2)
                      ORDER BY (csp_store_id = $1) DESC NULLS LAST LIMIT 1)`, values);
      if (rowCount) { updated++; continue; }
      const ins = await db.pool.query(`
        INSERT INTO stores (csp_store_id, domain, brand_name, store_group, store_group_name, country,
                            brand_color, from_email, from_name, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (domain) DO NOTHING`, values);
      if (ins.rowCount) added++; else conflicts.push(domain);
    } catch (err) {
      conflicts.push(`${domain} (${err.message})`);
    }
  }
  return { added, updated, conflicts };
}

// Customers who chatted: one row per (email, store) with the time of their
// latest chat, so "latest store wins" uses when they actually chatted.
// Customers CSP has from uploads or manual adds carry no date: they can be
// added here, but never move an existing customer (see services/ingest.js).
// Only rows changed since the last sync are read (cursor = CSP's clock).
async function syncCustomers(cursor) {
  const pool = getPool();
  const convCols = await tableColumns('conversations');
  if (!convCols.size) throw new Error('No conversations table found in the Chat Support Pro database');
  const seenExpr = ['last_message_at', 'updated_at', 'created_at'].filter((c) => convCols.has(c)).map((c) => `c.${c}`).join(', ');
  const phoneExpr = convCols.has('customer_phone') ? `(ARRAY_AGG(c.customer_phone ORDER BY c.updated_at DESC) FILTER (WHERE c.customer_phone <> ''))[1]` : 'NULL';
  const since = cursor ? 'AND c.updated_at > $1' : '';
  const { rows: chats } = await pool.query(`
    SELECT LOWER(BTRIM(c.customer_email)) AS email, s.shop_domain, s.brand_name,
           MAX(COALESCE(${seenExpr})) AS seen_at,
           (ARRAY_AGG(c.customer_name ORDER BY c.updated_at DESC) FILTER (WHERE c.customer_name <> ''))[1] AS name,
           ${phoneExpr} AS phone,
           BOOL_OR(c.status = 'blacklisted') AS blacklisted
      FROM conversations c JOIN stores s ON s.id = c.shop_id
     WHERE BTRIM(COALESCE(c.customer_email, '')) <> '' ${since}
     GROUP BY 1, 2, 3`, cursor ? [cursor] : []);

  const out = { chats: chats.length, files: 0, saved: 0, added: 0, storeChanged: 0, notSaved: 0, blocked: 0 };
  const add = (r) => {
    out.saved += r.saved; out.added += r.added; out.storeChanged += r.storeChanged; out.notSaved += r.rejected.length;
  };
  add(await ingest(chats.map((r) => ({
    email: r.email, name: r.name, phone: r.phone, storeUrl: r.shop_domain, storeName: r.brand_name, seenAt: r.seen_at,
  })), { source: 'chat' }));
  for (const r of chats.filter((x) => x.blacklisted)) out.blocked += await block(r.email, r.shop_domain, 'Blacklisted in Chat Support Pro');

  const cols = await tableColumns('customers');
  if (cols.size) {
    const { rows } = await pool.query(`
      SELECT ${pick(cols, [['email'], ['store_domain'], ['name'], ['phone'], ['from_chat'], ['from_upload'], ['added_manually'], ['status']])}
        FROM customers
       WHERE (${cols.has('from_upload') ? 'from_upload' : 'FALSE'} OR ${cols.has('added_manually') ? 'added_manually' : 'FALSE'})
         ${cursor && cols.has('updated_at') ? 'AND updated_at > $1' : ''}`, cursor && cols.has('updated_at') ? [cursor] : []);
    out.files = rows.length;
    for (const source of ['manual', 'upload']) {
      const part = rows.filter((r) => (source === 'manual' ? r.added_manually : !r.added_manually && r.from_upload));
      if (part.length) {
        add(await ingest(part.map((r) => ({ email: r.email, name: r.name, phone: r.phone, storeUrl: r.store_domain, seenAt: null })), { source }));
      }
    }
    for (const r of rows.filter((x) => x.status === 'blacklisted')) out.blocked += await block(r.email, r.store_domain, 'Blacklisted in Chat Support Pro');
    // Archived in CSP: left out of campaigns here too (unless already decided here).
    const archived = rows.filter((x) => x.status === 'archived').map((x) => String(x.email).trim().toLowerCase());
    if (archived.length) await db.pool.query(`UPDATE customers SET status = 'archived' WHERE status IS NULL AND email = ANY($1)`, [archived]);
  }
  return out;
}

async function block(email, storeDomain, reason) {
  const r = await db.pool.query(
    `INSERT INTO blocklist (email, store_domain, reason, created_by) VALUES ($1, $2, $3, 'chat-support-sync')
     ON CONFLICT ON CONSTRAINT blocklist_email_store_unique DO NOTHING`,
    [String(email).trim().toLowerCase(), cleanDomain(storeDomain) || null, reason]);
  return r.rowCount;
}

async function syncOptOutsAndLedger(cursor) {
  const pool = getPool();
  const out = { unsubscribes: 0, blocks: 0, sentLedger: 0 };

  const unsubCols = await tableColumns('promo_unsubscribes');
  if (unsubCols.size) {
    const inc = cursor && unsubCols.has('unsubscribed_at');
    const { rows } = await pool.query(
      `SELECT DISTINCT LOWER(email) AS email FROM promo_unsubscribes ${inc ? 'WHERE unsubscribed_at > $1' : ''}`, inc ? [cursor] : []);
    for (let i = 0; i < rows.length; i += 1000) {
      const r = await db.pool.query(
        `INSERT INTO unsubscribes (email, source) SELECT UNNEST($1::text[]), 'chat_support' ON CONFLICT (email) DO NOTHING`,
        [rows.slice(i, i + 1000).map((x) => x.email)]);
      out.unsubscribes += r.rowCount;
    }
  }

  const blCols = await tableColumns('blacklist');
  if (blCols.size) {
    const { rows } = await pool.query(
      `SELECT LOWER(email) AS email, store_identifier, ${blCols.has('reason') ? 'reason' : 'NULL AS reason'}
         FROM blacklist ${blCols.has('removed_at') ? 'WHERE removed_at IS NULL' : ''}`);
    for (const r of rows) {
      const res = await db.pool.query(
        `INSERT INTO blocklist (email, store_domain, reason, created_by) VALUES ($1, $2, $3, 'chat-support-sync')
         ON CONFLICT ON CONSTRAINT blocklist_email_store_unique DO NOTHING`,
        [r.email, r.store_identifier ? cleanDomain(r.store_identifier) : null, r.reason || 'Blacklisted in Chat Support Pro']);
      out.blocks += res.rowCount;
    }
  }

  const ledgerCols = await tableColumns('promo_sent_emails');
  if (ledgerCols.size) {
    const inc = cursor && ledgerCols.has('sent_at');
    const { rows } = await pool.query(
      `SELECT email, store_domain, store_name, sent_at FROM promo_sent_emails ${inc ? 'WHERE sent_at > $1' : ''}`, inc ? [cursor] : []);
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      const r = await db.pool.query(
        `INSERT INTO sent_emails (email, store_domain, store_name, sent_at)
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::timestamptz[])
         ON CONFLICT (LOWER(email), store_domain) DO NOTHING`,
        [chunk.map((x) => String(x.email).toLowerCase()), chunk.map((x) => cleanDomain(x.store_domain)),
          chunk.map((x) => x.store_name || null), chunk.map((x) => x.sent_at || new Date())]);
      out.sentLedger += r.rowCount;
    }
  }
  return out;
}

// full: read everything again (Settings → Sync now); otherwise only what
// changed since the last sync, a few minutes' overlap to be safe.
async function syncFromChatSupport({ full = false } = {}) {
  if (!isConfigured()) throw new Error('CHAT_SUPPORT_DATABASE_URL is not set');
  const started = Date.now();
  const last = await db.getSetting('chat_support_last_sync');
  const cursor = !full && last?.cursor ? new Date(new Date(last.cursor).getTime() - 5 * 60000) : null;
  const { rows: [{ now }] } = await getPool().query('SELECT NOW() AS now');
  const stores = await syncStores();
  const customers = await syncCustomers(cursor);
  const optOuts = await syncOptOutsAndLedger(cursor);
  const result = {
    at: new Date().toISOString(), cursor: now, full: !cursor,
    seconds: Math.round((Date.now() - started) / 100) / 10, stores, customers, optOuts,
  };
  await db.setSetting('chat_support_last_sync', result);
  return result;
}

module.exports = { isConfigured, optOutsFor, syncFromChatSupport };
