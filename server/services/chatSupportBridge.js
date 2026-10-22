// server/services/chatSupportBridge.js
// Optional link to Chat Support Pro, read only. Two ways to connect:
//
//   API (preferred): CHAT_SUPPORT_API_URL + CHAT_SUPPORT_API_KEY. Chat
//     Support Pro's /api/integrations/customer-connect hands out customers
//     already de-duplicated (one per email, the store of their latest chat),
//     stores and opt-outs. No database password leaves Chat Support Pro.
//   Database: CHAT_SUPPORT_DATABASE_URL. Every transaction runs read only,
//     so nothing here can change Chat Support Pro.
//
// Either way the rows go through the same saving code below (and through
// services/ingest.js: cleaning, one customer per email, latest store wins).
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

const mode = () => (config.chatSupportApiUrl && config.chatSupportApiKey ? 'api' : config.chatSupportDatabaseUrl ? 'database' : null);
const isConfigured = () => !!mode();

// ── API ─────────────────────────────────────────────────────────────────────

const API_TIMEOUT_MS = 60_000;

async function apiCall(method, path, { query, body } = {}) {
  const url = new URL(`${config.chatSupportApiUrl}/api/integrations/customer-connect${path}`);
  for (const [k, v] of Object.entries(query || {})) if (v != null && v !== '') url.searchParams.set(k, v instanceof Date ? v.toISOString() : String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${config.chatSupportApiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Chat Support Pro API unreachable (${err.name === 'TimeoutError' ? 'no answer in 60 s' : err.message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Chat Support Pro API ${path}: ${res.status} ${data.error || res.statusText}`);
  return data;
}

const api = {
  async stores() {
    const r = await apiCall('GET', '/stores');
    return { now: r.now, stores: r.stores };
  },
  // Pages through the de-duplicated customers, handing each page on.
  async eachCustomerPage(since, fn) {
    let after = null;
    do {
      const r = await apiCall('GET', '/customers', { query: { since, after } });
      await fn(r.customers.map((c) => ({
        email: c.email, name: c.name, phone: c.phone, storeUrl: c.store_domain, storeName: c.store_name,
        seenAt: c.last_seen_at, source: ['chat', 'upload', 'manual'].includes(c.source) ? c.source : 'chat',
        blacklisted: c.blacklisted, archived: c.archived,
      })));
      after = r.next;
    } while (after);
  },
  async optOuts(since) {
    const r = await apiCall('GET', '/opt-outs', { query: { since } });
    return { unsubscribes: r.unsubscribes, blacklist: r.blacklist };
  },
  async eachSentPage(since, fn) {
    let afterId = null;
    do {
      const r = await apiCall('GET', '/sent', { query: { since, afterId } });
      await fn(r.sent);
      afterId = r.next;
    } while (afterId);
  },
  async optedOut(emails) {
    const out = new Set();
    for (let i = 0; i < emails.length; i += 5000) {
      const r = await apiCall('POST', '/opt-outs/check', { body: { emails: emails.slice(i, i + 5000) } });
      r.optedOut.forEach((e) => out.add(e));
    }
    return out;
  },
};

// ── Database ────────────────────────────────────────────────────────────────

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

const database = {
  async stores() {
    const cols = await tableColumns('stores');
    if (!cols.size) throw new Error('No stores table found in the Chat Support Pro database');
    const [{ rows: [{ now }] }, { rows }] = await Promise.all([
      getPool().query('SELECT NOW() AS now'),
      getPool().query(`SELECT ${pick(cols, [
        ['id'], ['shop_domain'], ['brand_name'], ['store_group'], ['store_group_name'], ['country'],
        ['email_brand_color'], ['primary_color'], ['email_from_address'], ['email_from_name'], ['is_active'],
      ])} FROM stores`),
    ]);
    return {
      now,
      stores: rows.map((s) => ({
        ...s, brand_color: s.email_brand_color || s.primary_color, from_email: s.email_from_address, from_name: s.email_from_name,
      })),
    };
  },

  // Customers who chatted: one row per (email, store) with the time of their
  // latest chat. Customers from CSP's uploads and manual adds carry no date.
  // Only rows changed since the last sync are read (cursor = CSP's clock).
  async eachCustomerPage(since, fn) {
    const pool = getPool();
    const convCols = await tableColumns('conversations');
    if (!convCols.size) throw new Error('No conversations table found in the Chat Support Pro database');
    const seenExpr = ['last_message_at', 'updated_at', 'created_at'].filter((c) => convCols.has(c)).map((c) => `c.${c}`).join(', ');
    const phoneExpr = convCols.has('customer_phone') ? `(ARRAY_AGG(c.customer_phone ORDER BY c.updated_at DESC) FILTER (WHERE c.customer_phone <> ''))[1]` : 'NULL';
    const { rows: chats } = await pool.query(`
      SELECT LOWER(BTRIM(c.customer_email)) AS email, s.shop_domain, s.brand_name,
             MAX(COALESCE(${seenExpr})) AS seen_at,
             (ARRAY_AGG(c.customer_name ORDER BY c.updated_at DESC) FILTER (WHERE c.customer_name <> ''))[1] AS name,
             ${phoneExpr} AS phone,
             BOOL_OR(c.status = 'blacklisted') AS blacklisted
        FROM conversations c JOIN stores s ON s.id = c.shop_id
       WHERE BTRIM(COALESCE(c.customer_email, '')) <> '' ${since ? 'AND c.updated_at > $1' : ''}
       GROUP BY 1, 2, 3`, since ? [since] : []);
    await fn(chats.map((r) => ({
      email: r.email, name: r.name, phone: r.phone, storeUrl: r.shop_domain, storeName: r.brand_name,
      seenAt: r.seen_at, source: 'chat', blacklisted: r.blacklisted, archived: false,
    })));

    const cols = await tableColumns('customers');
    if (!cols.size) return;
    const inc = since && cols.has('updated_at');
    const { rows } = await pool.query(`
      SELECT ${pick(cols, [['email'], ['store_domain'], ['name'], ['phone'], ['from_upload'], ['added_manually'], ['status']])}
        FROM customers
       WHERE (${cols.has('from_upload') ? 'from_upload' : 'FALSE'} OR ${cols.has('added_manually') ? 'added_manually' : 'FALSE'})
         ${inc ? 'AND updated_at > $1' : ''}`, inc ? [since] : []);
    await fn(rows.map((r) => ({
      email: r.email, name: r.name, phone: r.phone, storeUrl: r.store_domain, seenAt: null,
      source: r.added_manually ? 'manual' : 'upload', blacklisted: r.status === 'blacklisted', archived: r.status === 'archived',
    })));
  },

  async optOuts(since) {
    const pool = getPool();
    const out = { unsubscribes: [], blacklist: [] };
    const unsubCols = await tableColumns('promo_unsubscribes');
    if (unsubCols.size) {
      const inc = since && unsubCols.has('unsubscribed_at');
      const { rows } = await pool.query(
        `SELECT DISTINCT LOWER(email) AS email FROM promo_unsubscribes ${inc ? 'WHERE unsubscribed_at > $1' : ''}`, inc ? [since] : []);
      out.unsubscribes = rows.map((r) => r.email);
    }
    const blCols = await tableColumns('blacklist');
    if (blCols.size) {
      const { rows } = await pool.query(
        `SELECT LOWER(email) AS email, store_identifier AS store, ${blCols.has('reason') ? 'reason' : 'NULL AS reason'}
           FROM blacklist ${blCols.has('removed_at') ? 'WHERE removed_at IS NULL' : ''}`);
      out.blacklist = rows;
    }
    return out;
  },

  async eachSentPage(since, fn) {
    const cols = await tableColumns('promo_sent_emails');
    if (!cols.size) return;
    const inc = since && cols.has('sent_at');
    const { rows } = await getPool().query(
      `SELECT email, store_domain, store_name, sent_at FROM promo_sent_emails ${inc ? 'WHERE sent_at > $1' : ''}`, inc ? [since] : []);
    await fn(rows);
  },

  async optedOut(emails) {
    const pool = getPool();
    const [unsubCols, blCols] = await Promise.all([tableColumns('promo_unsubscribes'), tableColumns('blacklist')]);
    const [unsub, bl] = await Promise.all([
      unsubCols.size
        ? pool.query('SELECT LOWER(email) AS email FROM promo_unsubscribes WHERE LOWER(email) = ANY($1)', [emails])
        : { rows: [] },
      blCols.size
        ? pool.query(
            `SELECT LOWER(email) AS email FROM blacklist
              WHERE ${blCols.has('removed_at') ? 'removed_at IS NULL AND' : ''} LOWER(email) = ANY($1)`, [emails])
        : { rows: [] },
    ]);
    return new Set([...unsub.rows, ...bl.rows].map((r) => r.email));
  },
};

const source = () => (mode() === 'api' ? api : database);

// ── Live opt-out check ──────────────────────────────────────────────────────

// A blacklisting at any store counts everywhere: it follows the person.
async function optOutsFor(emails) {
  const out = await source().optedOut(emails);
  return (email) => out.has(email);
}

// ── Saving ──────────────────────────────────────────────────────────────────

async function saveStores(rows) {
  let added = 0, updated = 0;
  const conflicts = [];
  for (const s of rows) {
    const domain = cleanDomain(s.shop_domain);
    if (!domain) continue;
    const values = [
      s.id, domain, s.brand_name || domain, s.store_group || null, s.store_group_name || s.store_group || null,
      s.country || null, s.brand_color || null, s.from_email || null, s.from_name || null, s.is_active !== false,
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

async function block(email, storeDomain, reason) {
  const r = await db.pool.query(
    `INSERT INTO blocklist (email, store_domain, reason, created_by) VALUES ($1, $2, $3, 'chat-support-sync')
     ON CONFLICT ON CONSTRAINT blocklist_email_store_unique DO NOTHING`,
    [String(email).trim().toLowerCase(), cleanDomain(storeDomain) || null, reason]);
  return r.rowCount;
}

// Dated rows (chats) can move a customer to their latest store; undated
// rows (CSP uploads and manual adds) only add new customers (ingest.js).
async function saveCustomers(rows, out) {
  out.chats += rows.filter((r) => r.source === 'chat').length;
  out.files += rows.filter((r) => r.source !== 'chat').length;
  for (const src of ['chat', 'manual', 'upload']) {
    const part = rows.filter((r) => r.source === src);
    if (!part.length) continue;
    const r = await ingest(part.map(({ email, name, phone, storeUrl, storeName, seenAt }) => ({ email, name, phone, storeUrl, storeName, seenAt })), { source: src });
    out.saved += r.saved; out.added += r.added; out.storeChanged += r.storeChanged; out.notSaved += r.rejected.length;
  }
  for (const r of rows.filter((x) => x.blacklisted)) out.blocked += await block(r.email, r.storeUrl, 'Blacklisted in Chat Support Pro');
  // Archived in CSP: left out of campaigns here too (unless already decided here).
  const archived = rows.filter((x) => x.archived).map((x) => String(x.email).trim().toLowerCase());
  if (archived.length) await db.pool.query(`UPDATE customers SET status = 'archived' WHERE status IS NULL AND email = ANY($1)`, [archived]);
}

async function saveOptOuts({ unsubscribes, blacklist }, out) {
  for (let i = 0; i < unsubscribes.length; i += 1000) {
    const r = await db.pool.query(
      `INSERT INTO unsubscribes (email, source) SELECT UNNEST($1::text[]), 'chat_support' ON CONFLICT (email) DO NOTHING`,
      [unsubscribes.slice(i, i + 1000)]);
    out.unsubscribes += r.rowCount;
  }
  for (const r of blacklist) out.blocks += await block(r.email, r.store, r.reason || 'Blacklisted in Chat Support Pro');
}

async function saveSent(rows, out) {
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

// ── Sync ────────────────────────────────────────────────────────────────────

// full: read everything again (Settings → Sync now); otherwise only what
// changed since the last sync, a few minutes' overlap to be safe.
async function syncFromChatSupport({ full = false } = {}) {
  if (!isConfigured()) throw new Error('Chat Support Pro is not linked (set CHAT_SUPPORT_API_URL and CHAT_SUPPORT_API_KEY)');
  const src = source();
  const started = Date.now();
  const last = await db.getSetting('chat_support_last_sync');
  const since = !full && last?.cursor ? new Date(new Date(last.cursor).getTime() - 5 * 60000) : null;

  const { now, stores: storeRows } = await src.stores();
  const stores = await saveStores(storeRows);
  const customers = { chats: 0, files: 0, saved: 0, added: 0, storeChanged: 0, notSaved: 0, blocked: 0 };
  await src.eachCustomerPage(since, (rows) => saveCustomers(rows, customers));
  const optOuts = { unsubscribes: 0, blocks: 0, sentLedger: 0 };
  await saveOptOuts(await src.optOuts(since), optOuts);
  await src.eachSentPage(since, (rows) => saveSent(rows, optOuts));

  const result = {
    at: new Date().toISOString(), via: mode(), cursor: now, full: !since,
    seconds: Math.round((Date.now() - started) / 100) / 10, stores, customers, optOuts,
  };
  await db.setSetting('chat_support_last_sync', result);
  return result;
}

module.exports = { isConfigured, mode, optOutsFor, syncFromChatSupport };
