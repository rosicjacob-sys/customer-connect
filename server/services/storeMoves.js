// server/services/storeMoves.js
// Moving customers from one store domain to another store, for good:
//
//   assignDomains()  a domain no store has (customers "waiting for a store")
//                    now belongs to an existing store
//   mergeStores()    stores that are really one: their customers move to
//                    the store kept, and the others are deleted
//
// Both save a rule in store_aliases, so later orders, chats and syncs from
// that domain go to the same store (services/ingest.js reads it). Removing
// a rule leaves customers where they are; only later ones stop following it.

const { transaction, pool } = require('../db');
const rules = require('../lib/customerRules');
const { INGEST_LOCK } = require('./ingest');

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Relinks every customer and history row under `domains` to `store`. A person
// already linked to that store keeps one link: earliest first-seen, latest
// last-seen, all sources. Their current store changes only if it was one of
// `domains`, so nobody is moved off a store they ordered from later.
async function relinkDomains(client, domains, store) {
  const from = [...new Set(domains.flatMap((d) => [rules.appDomain(d), rules.matchDomain(d)]))]
    .filter((d) => d && d !== store.domain);
  if (!from.length) return 0;
  await client.query(`
    WITH src AS (
      SELECT c.email, MIN(c.first_seen_at) AS first_seen_at, MAX(c.last_seen_at) AS last_seen_at, MIN(c.added_at) AS added_at,
             ARRAY(SELECT DISTINCT u FROM customer_stores c2, UNNEST(c2.sources) u
                    WHERE c2.email = c.email AND c2.store_domain = ANY($1)) AS sources
        FROM customer_stores c WHERE c.store_domain = ANY($1) GROUP BY c.email
    )
    INSERT INTO customer_stores (email, store_domain, store_id, store_name, first_seen_at, last_seen_at, sources, added_at)
    SELECT email, $3, $2, $4, first_seen_at, last_seen_at, sources, added_at FROM src
    ON CONFLICT (email, store_domain) DO UPDATE SET
      store_id      = EXCLUDED.store_id,
      first_seen_at = LEAST(customer_stores.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at  = GREATEST(customer_stores.last_seen_at, EXCLUDED.last_seen_at),
      sources       = ARRAY(SELECT DISTINCT u FROM UNNEST(customer_stores.sources || EXCLUDED.sources) u)`,
  [from, store.id, store.domain, store.brand_name]);
  await client.query('DELETE FROM customer_stores WHERE store_domain = ANY($1)', [from]);
  const { rowCount } = await client.query(
    'UPDATE customers SET store_domain = $2, store_id = $3, updated_at = NOW() WHERE store_domain = ANY($1)',
    [from, store.domain, store.id]);
  return rowCount;
}

async function lockedStore(client, id) {
  // Same lock as ingest(), so a sync can't save under the old domain meanwhile.
  await client.query('SELECT pg_advisory_xact_lock($1)', [INGEST_LOCK]);
  const { rows: [store] } = await client.query('SELECT id, domain, brand_name FROM stores WHERE id = $1', [id]);
  if (!store) throw httpError(404, 'Store not found');
  return store;
}

async function saveAlias(client, domains, storeId, createdBy) {
  await client.query(`
    INSERT INTO store_aliases (domain, store_id, created_by) SELECT UNNEST($1::text[]), $2, $3
    ON CONFLICT (domain) DO UPDATE SET store_id = EXCLUDED.store_id, created_by = EXCLUDED.created_by, created_at = NOW()`,
  [[...new Set(domains.map(rules.matchDomain))], storeId, createdBy]);
}

async function assignDomains({ domains, storeId, createdBy }) {
  const list = [...new Set((domains || []).map(rules.appDomain).filter(Boolean))];
  if (!list.length) throw httpError(400, 'Pick the stores to assign');
  return transaction(async (client) => {
    const store = await lockedStore(client, storeId);
    const { rows: taken } = await client.query(
      `SELECT brand_name FROM stores WHERE REGEXP_REPLACE(domain, '^www[.]', '') = ANY($1)`, [list.map(rules.matchDomain)]);
    if (taken.length) throw httpError(409, `${taken.map((t) => t.brand_name).join(', ')} is set up as a store: merge the stores instead`);
    await saveAlias(client, list, store.id, createdBy);
    const customersMoved = await relinkDomains(client, list, store);
    return { store: store.brand_name, domains: list, customersMoved };
  });
}

async function mergeStores({ ids, targetId, createdBy }) {
  return transaction(async (client) => {
    const target = await lockedStore(client, targetId);
    const { rows: merged } = await client.query('SELECT id, domain, brand_name FROM stores WHERE id = ANY($1) AND id <> $2', [ids, target.id]);
    if (!merged.length) throw httpError(400, 'Pick at least one store other than the one to keep');
    let customersMoved = 0;
    for (const s of merged) {
      await client.query('UPDATE store_aliases SET store_id = $2 WHERE store_id = $1', [s.id, target.id]);
      await saveAlias(client, [s.domain], target.id, createdBy);
      customersMoved += await relinkDomains(client, [s.domain], target);
      // Anyone still linked by id (shouldn't happen, but never leave them pointing at a deleted store).
      customersMoved += (await client.query(
        'UPDATE customers SET store_id = $2, store_domain = $3, updated_at = NOW() WHERE store_id = $1', [s.id, target.id, target.domain])).rowCount;
      await client.query('DELETE FROM stores WHERE id = $1', [s.id]);
    }
    return { into: target.brand_name, merged: merged.map((s) => s.brand_name), customersMoved };
  });
}

async function removeAlias(domain) {
  const { rowCount } = await pool.query('DELETE FROM store_aliases WHERE domain = $1', [rules.matchDomain(domain)]);
  return rowCount > 0;
}

// A store now has this domain of its own: an older rule for it would only confuse.
async function dropAliasesFor(domains, client = pool) {
  await client.query('DELETE FROM store_aliases WHERE domain = ANY($1)', [domains.map(rules.matchDomain)]);
}

module.exports = { assignDomains, mergeStores, removeAlias, dropAliasesFor, relinkDomains };
