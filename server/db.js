// server/db.js
// The Postgres pool and the schema. Customer Connect has its own database;
// Chat Support Pro's is only ever read (see services/chatSupportBridge.js).

const { Pool } = require('pg');
const config = require('./config');

// No SSL on local or private-network addresses. Render's internal database
// address (what render.yaml passes in) has a host without dots: dpg-…-a.
const dbHost = (() => { try { return new URL(config.databaseUrl).hostname; } catch { return ''; } })();
const local = /localhost|127\.0\.0\.1|\.internal|host=\/|@\/|\?host=/.test(config.databaseUrl || '') || (!!dbHost && !dbHost.includes('.'));
const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: local || process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_MAX || 10),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 20_000,
  application_name: 'customer-connect',
});
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

const SCHEMA_LOCK = 772001;

// Safe to run on every start: each statement only adds what is missing.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id            SERIAL PRIMARY KEY,
     email         TEXT NOT NULL,
     name          TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     role          TEXT NOT NULL DEFAULT 'editor',
     is_active     BOOLEAN NOT NULL DEFAULT TRUE,
     last_login_at TIMESTAMPTZ,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_uidx ON users (LOWER(email))`,

  // A store is a sender: the brand, domain, colour and from-address an
  // email goes out under. Customers belong to a store.
  `CREATE TABLE IF NOT EXISTS stores (
     id               SERIAL PRIMARY KEY,
     domain           TEXT NOT NULL UNIQUE,
     brand_name       TEXT NOT NULL,
     store_group      TEXT,
     store_group_name TEXT,
     country          TEXT,
     brand_color      TEXT,
     from_email       TEXT,
     from_name        TEXT,
     reply_to         TEXT,
     is_active        BOOLEAN NOT NULL DEFAULT TRUE,
     csp_store_id     INTEGER UNIQUE,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS stores_group_idx ON stores (store_group)`,

  // One row per email: a person is one customer, linked to the store they
  // were last seen at (the latest order or chat). Every store they were ever
  // linked to is kept in customer_stores. Saved through services/ingest.js.
  `CREATE TABLE IF NOT EXISTS customers (
     id              SERIAL PRIMARY KEY,
     email           TEXT NOT NULL UNIQUE,
     store_domain    TEXT NOT NULL DEFAULT '',
     store_id        INTEGER REFERENCES stores(id) ON DELETE SET NULL,
     name            TEXT,
     name_locked     BOOLEAN NOT NULL DEFAULT FALSE,
     phone           TEXT,
     country         TEXT,
     moved_to_domain TEXT,
     from_chat       BOOLEAN NOT NULL DEFAULT FALSE,
     from_upload     BOOLEAN NOT NULL DEFAULT FALSE,
     added_manually  BOOLEAN NOT NULL DEFAULT FALSE,
     from_checkout   BOOLEAN NOT NULL DEFAULT FALSE,
     status          TEXT,
     email_check     TEXT NOT NULL DEFAULT 'ok',
     last_seen_at    TIMESTAMPTZ,
     last_source     TEXT,
     created_by      TEXT,
     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // Installs from before one-row-per-email: add the new columns first.
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS from_checkout BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_check TEXT NOT NULL DEFAULT 'ok'`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_source TEXT`,

  // Every store a customer has been linked to. last_seen_at is when the
  // order or chat happened there (NULL when the source gave no date).
  `CREATE TABLE IF NOT EXISTS customer_stores (
     email         TEXT NOT NULL,
     store_domain  TEXT NOT NULL,
     store_id      INTEGER REFERENCES stores(id) ON DELETE SET NULL,
     store_name    TEXT,
     first_seen_at TIMESTAMPTZ,
     last_seen_at  TIMESTAMPTZ,
     sources       TEXT[] NOT NULL DEFAULT '{}',
     added_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     PRIMARY KEY (email, store_domain)
   )`,
  `CREATE INDEX IF NOT EXISTS customer_stores_domain_idx ON customer_stores (store_domain)`,

  // Does this email domain receive mail? (services/mailDomains.js)
  `CREATE TABLE IF NOT EXISTS email_domains (
     domain     TEXT PRIMARY KEY,
     status     TEXT NOT NULL,
     checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS customers_store_id_idx ON customers (store_id)`,

  `CREATE TABLE IF NOT EXISTS segments (
     id         SERIAL PRIMARY KEY,
     name       TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS segments_name_uidx ON segments (LOWER(name))`,
  `CREATE TABLE IF NOT EXISTS segment_stores (
     segment_id INTEGER NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
     store_id   INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
     PRIMARY KEY (segment_id, store_id)
   )`,

  `CREATE TABLE IF NOT EXISTS templates (
     id          SERIAL PRIMARY KEY,
     name        TEXT NOT NULL,
     subject     TEXT NOT NULL,
     html        TEXT NOT NULL,
     text        TEXT,
     store_group TEXT,
     created_by  TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // mode 'now' sends everything straight away; 'scheduled' sends
  // batch_size every interval_minutes. The worker picks up any campaign
  // whose next_fire_at has passed; locked_until keeps two workers (or two
  // server instances) from sending the same batch.
  `CREATE TABLE IF NOT EXISTS campaigns (
     id                  SERIAL PRIMARY KEY,
     name                TEXT NOT NULL,
     mode                TEXT NOT NULL DEFAULT 'scheduled',
     status              TEXT NOT NULL DEFAULT 'scheduled',
     template_id         INTEGER REFERENCES templates(id) ON DELETE SET NULL,
     store_group         TEXT,
     subject_template    TEXT NOT NULL,
     html_template       TEXT NOT NULL,
     text_template       TEXT,
     batch_size          INTEGER NOT NULL,
     interval_minutes    INTEGER NOT NULL,
     timezone            TEXT NOT NULL DEFAULT 'UTC',
     start_at            TIMESTAMPTZ,
     next_fire_at        TIMESTAMPTZ,
     end_at              TIMESTAMPTZ,
     send_limit          INTEGER,
     window_start        TEXT,
     window_end          TEXT,
     total_recipients    INTEGER NOT NULL DEFAULT 0,
     sent_count          INTEGER NOT NULL DEFAULT 0,
     failed_count        INTEGER NOT NULL DEFAULT 0,
     skipped_count       INTEGER NOT NULL DEFAULT 0,
     locked_until        TIMESTAMPTZ,
     last_error          TEXT,
     settings_changed_at TIMESTAMPTZ,
     created_by          TEXT,
     created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS campaigns_due_idx ON campaigns (next_fire_at) WHERE status IN ('scheduled', 'running')`,

  `CREATE TABLE IF NOT EXISTS campaign_recipients (
     id                SERIAL PRIMARY KEY,
     campaign_id       INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
     customer_id       INTEGER,
     email             TEXT NOT NULL,
     name              TEXT,
     store_id          INTEGER,
     store_name        TEXT,
     store_domain      TEXT,
     store_url         TEXT,
     moved_banner      TEXT,
     moved_banner_text TEXT,
     status            TEXT NOT NULL DEFAULT 'pending',
     error             TEXT,
     attempted_at      TIMESTAMPTZ,
     sent_at           TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS campaign_recipients_status_idx ON campaign_recipients (campaign_id, status)`,


  // Who has been emailed by which store. "Leave out people this store
  // already emailed" reads it; resetting a row makes them eligible again.
  `CREATE TABLE IF NOT EXISTS sent_emails (
     id           SERIAL PRIMARY KEY,
     email        TEXT NOT NULL,
     store_domain TEXT NOT NULL DEFAULT '',
     store_name   TEXT,
     campaign_id  INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
     sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sent_emails_email_store_uidx ON sent_emails (LOWER(email), store_domain)`,

  `CREATE TABLE IF NOT EXISTS unsubscribes (
     id         SERIAL PRIMARY KEY,
     email      TEXT NOT NULL UNIQUE,
     source     TEXT NOT NULL DEFAULT 'link',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // store_domain NULL blocks the address for every store.
  `CREATE TABLE IF NOT EXISTS blocklist (
     id           SERIAL PRIMARY KEY,
     email        TEXT NOT NULL,
     store_domain TEXT,
     reason       TEXT,
     created_by   TEXT,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT blocklist_email_store_unique UNIQUE NULLS NOT DISTINCT (email, store_domain)
   )`,

  `CREATE TABLE IF NOT EXISTS app_settings (
     key        TEXT PRIMARY KEY,
     value      JSONB,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
];

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
    for (const sql of SCHEMA) await client.query(sql);
    await collapseToOneRowPerEmail(client);
    await oneRecipientPerEmail(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]).catch(() => {});
    client.release();
  }
}

// Before one-row-per-email, a customer had a row per store. Collapses those
// into one row per email, once. Nothing is lost: every store row becomes a
// customer_stores link. Rows had no order/chat dates, so the most recently
// added store becomes the current one; the next sync with real dates
// re-decides it.
async function collapseToOneRowPerEmail(client) {
  const { rows } = await client.query(`
    SELECT 1 FROM pg_constraint WHERE conname = 'customers_store_domain_email_key'`);
  if (!rows.length) return;
  await client.query('BEGIN');
  try {
    await client.query(`
      INSERT INTO customer_stores (email, store_domain, store_id, sources, added_at)
      SELECT email, store_domain, store_id,
             ARRAY_REMOVE(ARRAY[CASE WHEN from_upload THEN 'upload' END, CASE WHEN added_manually THEN 'manual' END,
                                CASE WHEN from_chat THEN 'chat' END], NULL),
             created_at
        FROM customers
      ON CONFLICT DO NOTHING`);
    const { rows: [{ n }] } = await client.query(`
      WITH ranked AS (
        SELECT id, email, ROW_NUMBER() OVER (PARTITION BY email ORDER BY created_at DESC, id DESC) AS rn FROM customers
      ), merged AS (
        SELECT email,
               BOOL_OR(from_chat) AS from_chat, BOOL_OR(from_upload) AS from_upload, BOOL_OR(added_manually) AS added_manually,
               (ARRAY_AGG(name ORDER BY name_locked DESC, created_at DESC) FILTER (WHERE name IS NOT NULL))[1] AS name,
               BOOL_OR(name_locked) AS name_locked,
               (ARRAY_AGG(phone ORDER BY created_at DESC) FILTER (WHERE phone IS NOT NULL))[1] AS phone,
               CASE WHEN BOOL_AND(status = 'archived') THEN 'archived' END AS status
          FROM customers GROUP BY email HAVING COUNT(*) > 1
      ), kept AS (
        UPDATE customers c SET from_chat = m.from_chat, from_upload = m.from_upload, added_manually = m.added_manually,
               name = m.name, name_locked = m.name_locked, phone = m.phone, status = m.status, updated_at = NOW()
          FROM merged m, ranked r
         WHERE c.email = m.email AND r.id = c.id AND r.rn = 1
        RETURNING c.id
      )
      SELECT COUNT(*)::int AS n FROM kept`);
    const removed = await client.query(`
      DELETE FROM customers c USING (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY email ORDER BY created_at DESC, id DESC) AS rn FROM customers
      ) r WHERE r.id = c.id AND r.rn > 1`);
    await client.query('ALTER TABLE customers DROP CONSTRAINT customers_store_domain_email_key');
    await client.query('ALTER TABLE customers ADD CONSTRAINT customers_email_key UNIQUE (email)');
    await client.query('COMMIT');
    console.log(`[db] customers are now one row per email: ${n} people merged, ${removed.rowCount} extra store rows moved to their history`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// Nobody is in the same campaign twice. Campaigns from before
// one-row-per-email could hold an email once per store: the extra rows are
// removed (a sent one is kept) before the rule is added.
async function oneRecipientPerEmail(client) {
  const { rows } = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'campaign_recipients_email_uidx'`);
  if (rows.length) return;
  const { rows: dupes } = await client.query(`
    DELETE FROM campaign_recipients r USING (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY campaign_id, LOWER(email)
                                    ORDER BY (status = 'sent') DESC, id) AS rn
        FROM campaign_recipients
    ) d WHERE d.id = r.id AND d.rn > 1
    RETURNING r.campaign_id`);
  const touched = [...new Set(dupes.map((d) => d.campaign_id))];
  if (touched.length) {
    await client.query(`
      UPDATE campaigns c SET total_recipients = x.total, sent_count = x.sent, failed_count = x.failed, skipped_count = x.skipped
        FROM (SELECT campaign_id, COUNT(*)::int AS total,
                     COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
                     COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                     COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped
                FROM campaign_recipients WHERE campaign_id = ANY($1) GROUP BY campaign_id) x
       WHERE c.id = x.campaign_id`, [touched]);
    console.log(`[db] removed ${dupes.length} repeated recipients from ${touched.length} older campaign(s)`);
  }
  await client.query('CREATE UNIQUE INDEX campaign_recipients_email_uidx ON campaign_recipients (campaign_id, LOWER(email))');
}

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]);
}

// Runs fn(client) inside BEGIN/COMMIT, rolling back on any error.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, migrate, getSetting, setSetting, transaction };
