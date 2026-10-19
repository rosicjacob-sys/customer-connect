// server/services/customers.js
// Reading and editing the customer list. One row per email, linked to the
// store of their latest order or chat; group, country and colour come from
// that store. New customers are saved through services/ingest.js.

const { pool, transaction } = require('../db');
const { cleanDomain } = require('../lib/merge');
const { ingest } = require('./ingest');
const { cleanEmail, cleanPhone, cleanName } = require('../lib/clean');

const SOURCE_SQL = { chat: 'cu.from_chat', upload: 'cu.from_upload', manual: 'cu.added_manually', checkout: 'cu.from_checkout' };

function sourceClause(sources) {
  const picked = (Array.isArray(sources) ? sources : String(sources || '').split(','))
    .map((s) => s.trim()).filter((s) => SOURCE_SQL[s]);
  return picked.length ? `(${picked.map((s) => SOURCE_SQL[s]).join(' OR ')})` : null;
}

const SELECT_ROW = `
  cu.id, cu.email, COALESCE(cu.name, '') AS name, cu.store_id, cu.store_domain,
  COALESCE(s.brand_name, cu.store_domain) AS store_name, cu.moved_to_domain, cu.phone, s.country,
  cu.from_chat, cu.from_upload, cu.added_manually, cu.from_checkout, cu.status, cu.email_check,
  cu.last_seen_at, cu.last_source, cu.created_at,
  CASE WHEN EXISTS (SELECT 1 FROM unsubscribes u WHERE LOWER(u.email) = cu.email) THEN 'unsubscribed'
       WHEN EXISTS (SELECT 1 FROM blocklist b WHERE LOWER(b.email) = cu.email) THEN 'blocked' END AS opted_out,
  (SELECT COUNT(*)::int FROM customer_stores cs WHERE cs.email = cu.email) AS store_count`;

// Shared WHERE builder. `country` is kept apart so the per-country counts
// always show the full split whichever country is selected.
function filters({ storeGroup, storeIds, search, sources, status }) {
  const params = [];
  const where = [];
  if (storeGroup) { params.push(storeGroup); where.push(`s.store_group = $${params.length}`); }
  if (Array.isArray(storeIds)) { params.push(storeIds); where.push(`cu.store_id = ANY($${params.length})`); }
  if (search) {
    params.push(`%${String(search).toLowerCase()}%`);
    const p = params.length;
    where.push(`(cu.email LIKE $${p} OR LOWER(COALESCE(cu.name, '')) LIKE $${p} OR LOWER(COALESCE(s.brand_name, '')) LIKE $${p} OR cu.store_domain LIKE $${p} OR COALESCE(cu.phone, '') LIKE $${p})`);
  }
  const src = sourceClause(sources);
  if (src) where.push(src);
  if (status === 'active') where.push('cu.status IS NULL');
  else if (status === 'archived') where.push(`cu.status = 'archived'`);
  else if (status === 'unverified') where.push(`cu.email_check <> 'ok'`);
  else if (status === 'no_store') where.push('cu.store_id IS NULL');
  return { params, where };
}

async function listCustomers({ country, limit = 50, offset = 0, ...rest } = {}) {
  const base = filters(rest);
  const params = [...base.params];
  const where = [...base.where];
  if (country) { params.push(country); where.push(`s.country = $${params.length}`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const bw = base.where.length ? `WHERE ${base.where.join(' AND ')}` : '';
  const from = 'FROM customers cu LEFT JOIN stores s ON s.id = cu.store_id';

  const { rows } = await pool.query(
    `SELECT ${SELECT_ROW} ${from} ${w} ORDER BY cu.last_seen_at DESC NULLS LAST, cu.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
  const { rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::int AS n ${from} ${w}`, params);
  const { rows: byCountry } = await pool.query(
    `SELECT COALESCE(s.country, 'unset') AS country, COUNT(*)::int AS n ${from} ${bw} GROUP BY 1`, base.params);
  const countsByCountry = { CA: 0, US: 0, unset: 0 };
  for (const r of byCountry) countsByCountry[r.country] = (countsByCountry[r.country] || 0) + r.n;
  return { rows, total: n, countsByCountry };
}

/**
 * Everyone a campaign could go to: active, verified customers with a store,
 * minus anyone unsubscribed or blocked. With skipAlreadyEmailed, also minus
 * anyone their store has emailed before.
 */
async function listAudience({ storeGroup, storeIds, country, sources, skipAlreadyEmailed = false } = {}) {
  const { params, where } = filters({ storeGroup, storeIds, sources, status: 'active' });
  if (country) { params.push(country); where.push(`s.country = $${params.length}`); }
  where.push(`cu.email_check = 'ok'`, 'cu.store_id IS NOT NULL');
  where.push('NOT EXISTS (SELECT 1 FROM unsubscribes u WHERE LOWER(u.email) = cu.email)');
  where.push('NOT EXISTS (SELECT 1 FROM blocklist b WHERE LOWER(b.email) = cu.email)');
  if (skipAlreadyEmailed) {
    where.push('NOT EXISTS (SELECT 1 FROM sent_emails se WHERE LOWER(se.email) = cu.email AND se.store_domain = cu.store_domain)');
  }
  const { rows } = await pool.query(
    `SELECT ${SELECT_ROW} FROM customers cu JOIN stores s ON s.id = cu.store_id
      WHERE ${where.join(' AND ')}
      ORDER BY cu.last_seen_at DESC NULLS LAST, cu.id DESC LIMIT 200000`, params);
  return rows;
}

async function getCustomer(id) {
  const { rows } = await pool.query(`SELECT ${SELECT_ROW} FROM customers cu LEFT JOIN stores s ON s.id = cu.store_id WHERE cu.id = $1`, [id]);
  return rows[0] || null;
}

// Every store this customer was linked to, newest first.
async function storeHistory(id) {
  const { rows } = await pool.query(`
    SELECT cs.store_domain, COALESCE(s.brand_name, cs.store_name, cs.store_domain) AS store_name, cs.store_id,
           cs.first_seen_at, cs.last_seen_at, cs.sources, cs.added_at, cs.store_domain = cu.store_domain AS current
      FROM customers cu JOIN customer_stores cs ON cs.email = cu.email
      LEFT JOIN stores s ON s.id = cs.store_id
     WHERE cu.id = $1
     ORDER BY cs.last_seen_at DESC NULLS LAST, cs.added_at DESC`, [id]);
  return rows;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Adding someone by hand counts as seeing them at that store now: an
// existing customer moves to it.
async function addCustomer({ email, name, phone, storeId, createdBy }) {
  const { rows: [store] } = await pool.query('SELECT id, domain, brand_name FROM stores WHERE id = $1', [storeId]);
  if (!store) throw httpError(400, 'Store not found');
  const report = await ingest([{ email, name, phone, storeUrl: store.domain, storeName: store.brand_name, seenAt: new Date() }],
    { source: 'manual', lockName: !!String(name || '').trim(), createdBy });
  if (!report.saved) throw httpError(400, `Not saved: ${report.rejected[0]?.reason || 'invalid'}`);
  return { customer: await getCustomer(report.customerIds[0]), report };
}

// Name and phone edits. A typed name is kept from then on (a later import
// or sync won't replace it); a store change moves the customer there.
async function updateCustomer(id, { name, email, phone, storeId }) {
  const before = await getCustomer(id);
  if (!before) return null;
  let newEmail = null;
  if (email != null && String(email).trim().toLowerCase() !== before.email) {
    const c = cleanEmail(email);
    if (c.drop) throw httpError(400, `That email can't be used: ${c.drop}`);
    newEmail = c.email;
  }
  let newPhone;
  if (phone !== undefined) {
    newPhone = phone === '' || phone == null ? null : cleanPhone(phone);
    if (phone && !newPhone) throw httpError(400, 'That phone number is not recognised');
  }
  try {
    await transaction(async (client) => {
      if (newEmail) await client.query('UPDATE customer_stores SET email = $2 WHERE email = $1', [before.email, newEmail]);
      await client.query(`
        UPDATE customers SET
          name        = CASE WHEN $2::boolean THEN $3 ELSE name END,
          name_locked = name_locked OR $2::boolean,
          email       = COALESCE($4, email),
          phone       = CASE WHEN $5::boolean THEN $6 ELSE phone END,
          updated_at  = NOW()
        WHERE id = $1`,
      [id, name != null, name != null ? cleanName(name) : null, newEmail, newPhone !== undefined, newPhone ?? null]);
    });
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'Another customer already has that email');
    throw err;
  }
  if (storeId && Number(storeId) !== before.store_id) {
    const { rows: [store] } = await pool.query('SELECT domain, brand_name FROM stores WHERE id = $1', [storeId]);
    if (!store) throw httpError(400, 'Store not found');
    await ingest([{ email: newEmail || before.email, storeUrl: store.domain, storeName: store.brand_name, seenAt: new Date() }], { source: 'manual' });
  }
  return getCustomer(id);
}

async function setStatus(id, status) {
  const { rowCount } = await pool.query('UPDATE customers SET status = $2, updated_at = NOW() WHERE id = $1', [id, status]);
  return rowCount ? getCustomer(id) : null;
}

async function deleteCustomer(id) {
  const { rows } = await pool.query('DELETE FROM customers WHERE id = $1 RETURNING email', [id]);
  if (!rows[0]) return false;
  await pool.query('DELETE FROM customer_stores WHERE email = $1', [rows[0].email]);
  return true;
}

// A store's domain changed: its customers and their history follow.
async function moveStoreDomain(client, storeId, newDomain) {
  const domain = cleanDomain(newDomain);
  await client.query(`
    DELETE FROM customer_stores o WHERE o.store_id = $1 AND o.store_domain <> $2
       AND EXISTS (SELECT 1 FROM customer_stores t WHERE t.email = o.email AND t.store_domain = $2)`, [storeId, domain]);
  await client.query('UPDATE customer_stores SET store_domain = $2 WHERE store_id = $1 AND store_domain <> $2', [storeId, domain]);
  await client.query('UPDATE customers SET store_domain = $2, updated_at = NOW() WHERE store_id = $1 AND store_domain <> $2', [storeId, domain]);
}

// Customers saved for a store that wasn't set up yet get linked to it once
// it is added.
async function linkUnmatched(client = pool) {
  const match = (a, b) => `REGEXP_REPLACE(${a}, '^www[.]', '') = REGEXP_REPLACE(${b}, '^www[.]', '')`;
  await client.query(`UPDATE customer_stores c SET store_id = s.id FROM stores s WHERE c.store_id IS NULL AND ${match('s.domain', 'c.store_domain')}`);
  const r = await client.query(`
    UPDATE customers c SET store_id = s.id, updated_at = NOW()
      FROM stores s WHERE c.store_id IS NULL AND ${match('s.domain', 'c.store_domain')}`);
  return r.rowCount;
}

// Store domains customers were saved under that no store has yet.
async function waitingForStore() {
  const { rows } = await pool.query(`
    SELECT cu.store_domain AS domain, COUNT(*)::int AS customers,
           (SELECT cs.store_name FROM customer_stores cs WHERE cs.store_domain = cu.store_domain AND cs.store_name IS NOT NULL LIMIT 1) AS store_name
      FROM customers cu WHERE cu.store_id IS NULL AND cu.store_domain <> ''
     GROUP BY cu.store_domain ORDER BY 2 DESC LIMIT 200`);
  return rows;
}

module.exports = {
  listCustomers, listAudience, getCustomer, storeHistory, addCustomer, updateCustomer, setStatus, deleteCustomer,
  moveStoreDomain, linkUnmatched, waitingForStore,
};
