// server/services/ingest.js
// The one way customers get saved. Chat Support Pro sync, the checkout
// portal, CSV uploads and adding by hand all call ingest(), so they all get
// the same cleaning and the same merge rules:
//
//   * One customer per email.
//   * The customer belongs to the store of their LATEST order or chat, by
//     when it happened (seenAt), not when we received it. Re-sending old
//     data can't move anyone back.
//   * A row without a date can add a new customer or fill in blanks, but
//     never moves an existing customer to another store.
//   * Same moment at two stores: checkout beats manual beats chat beats upload.
//   * Name and phone come from the latest row that has one; a blank never
//     wipes a value, and a name someone typed by hand is never replaced.
//   * Every store a customer was linked to stays in customer_stores.

const { pool } = require('../db');
const { cleanRow } = require('../lib/clean');
const rules = require('../lib/customerRules');
const { checkDomains } = require('./mailDomains');

const SOURCE_RANK = { checkout: 4, manual: 3, chat: 2, upload: 1 };
const SOURCE_FLAG = { checkout: 'from_checkout', manual: 'added_manually', chat: 'from_chat', upload: 'from_upload' };
const INGEST_LOCK = 772002;
const CHUNK = 1000;

const time = (d) => (d ? new Date(d).getTime() : null);

// Is `a` (a link or row: { seenAt, source }) later evidence than `b`?
function later(aTime, aSource, bTime, bSource) {
  if (aTime == null) return false;
  if (bTime == null) return true;
  if (aTime !== bTime) return aTime > bTime;
  return (SOURCE_RANK[aSource] || 0) > (SOURCE_RANK[bSource] || 0);
}

function bestSource(sources) {
  return [...sources].sort((x, y) => (SOURCE_RANK[y] || 0) - (SOURCE_RANK[x] || 0))[0] || null;
}

/**
 * Pure merge of one email's incoming rows into what is saved for it.
 *   existing: the customers row or null
 *   links:    its customer_stores rows (array, may be empty)
 *   rows:     cleaned incoming rows for this email, each with { source, storeId }
 * → { customer, links, isNew, storeChanged }
 */
function mergeCustomer(existing, links, rows, now = new Date()) {
  const byDomain = new Map(links.map((l) => [l.store_domain, {
    ...l, sources: new Set(l.sources || []), first_seen_at: l.first_seen_at, last_seen_at: l.last_seen_at,
  }]));
  // The current store always counts, even if its history row is missing.
  if (existing?.store_domain && !byDomain.has(existing.store_domain)) {
    byDomain.set(existing.store_domain, {
      store_domain: existing.store_domain, store_id: existing.store_id, store_name: null,
      first_seen_at: existing.last_seen_at, last_seen_at: existing.last_seen_at,
      sources: new Set(existing.last_source ? [existing.last_source] : []), added_at: existing.created_at || now,
    });
  }
  for (const r of rows) {
    let l = byDomain.get(r.storeDomain);
    if (!l) {
      l = { store_domain: r.storeDomain, store_id: r.storeId ?? null, store_name: r.storeName, first_seen_at: null, last_seen_at: null, sources: new Set(), added_at: now, _new: true };
      byDomain.set(r.storeDomain, l);
    }
    l._touched = true;
    l.sources.add(r.source);
    if (r.storeId != null) l.store_id = r.storeId;
    if (!l.store_name && r.storeName) l.store_name = r.storeName;
    const t = time(r.seenAt);
    if (t != null) {
      if (l.last_seen_at == null || t > time(l.last_seen_at)) l.last_seen_at = new Date(t);
      if (l.first_seen_at == null || t < time(l.first_seen_at)) l.first_seen_at = new Date(t);
    }
  }
  const all = [...byDomain.values()];

  // Current store: the latest dated link. With no dated link at all, an
  // existing customer keeps their store and a new one takes the first row's.
  let current = null;
  for (const l of all) {
    if (later(time(l.last_seen_at), bestSource(l.sources), time(current?.last_seen_at), bestSource(current?.sources || []))) current = l;
  }
  if (!current) current = (existing && byDomain.get(existing.store_domain)) || byDomain.get(rows[0].storeDomain);

  const c = existing ? { ...existing } : {
    email: rows[0].email, name: null, name_locked: false, phone: null, status: null, email_check: 'ok',
    from_chat: false, from_upload: false, added_manually: false, from_checkout: false, last_seen_at: null, last_source: null,
  };
  const storeChanged = !!existing && existing.store_domain !== current.store_domain;
  c.store_domain = current.store_domain;
  c.store_id = current.store_id ?? null;

  // Name and phone: newest row that has one wins; undated rows only fill blanks.
  const sorted = [...rows].sort((a, b) => (later(time(a.seenAt), a.source, time(b.seenAt), b.source) ? -1 : 1));
  const baseline = time(existing?.last_seen_at);
  for (const field of ['name', 'phone']) {
    if (field === 'name' && c.name_locked) continue;
    const newest = sorted.find((r) => r[field] && time(r.seenAt) != null && (baseline == null || time(r.seenAt) >= baseline));
    if (newest) c[field] = newest[field];
    else if (!c[field]) c[field] = sorted.find((r) => r[field])?.[field] ?? null;
  }

  for (const r of rows) c[SOURCE_FLAG[r.source]] = true;
  for (const l of all) {
    if (later(time(l.last_seen_at), bestSource(l.sources), time(c.last_seen_at), c.last_source)) {
      c.last_seen_at = l.last_seen_at;
      c.last_source = bestSource(l.sources);
    }
  }
  // Verified stays verified; a new customer takes the result of its check.
  const incomingCheck = rows.some((r) => r.emailCheck === 'ok') ? 'ok' : 'unverified';
  c.email_check = existing ? (existing.email_check === 'ok' ? 'ok' : incomingCheck) : incomingCheck;
  if (existing && storeChanged) c.moved_to_domain = null;

  return { customer: c, links: all.filter((l) => l._touched), isNew: !existing, storeChanged };
}

async function loadStores(client = pool) {
  const { rows } = await client.query('SELECT id, domain, brand_name FROM stores');
  const map = new Map();
  for (const s of rows) map.set(rules.matchDomain(s.domain), s);
  return map;
}

/**
 * rows: [{ email, name, phone, storeUrl, storeName, seenAt, line? }]
 * options:
 *   source           'checkout' | 'chat' | 'upload' | 'manual'
 *   apply            false = preview only (nothing is written)
 *   unknownStores    'keep' (saved without a store until one is added) or
 *                    'skip' (left out and listed, e.g. for CSV uploads)
 *   lockName         a name typed by a person (manual edits)
 *   createdBy
 * → report { rows, saved, added, updated, storeChanged, unverified, fixes,
 *            dropped: { reason: n }, rejected: [{ line, email, store, reason }],
 *            unknownStores: [{ domain, storeName, count }] }
 */
async function ingest(rawRows, { source, apply = true, unknownStores = 'keep', lockName = false, createdBy = null } = {}) {
  if (!SOURCE_RANK[source]) throw new Error(`Unknown source ${source}`);
  const report = {
    rows: rawRows.length, saved: 0, added: 0, updated: 0, storeChanged: 0, unverified: 0,
    fixes: {}, dropped: {}, rejected: [], unknownStores: [], customerIds: [],
  };
  const reject = (raw, reason) => {
    report.dropped[reason] = (report.dropped[reason] || 0) + 1;
    report.rejected.push({ line: raw.line ?? null, email: raw.email ?? '', store: raw.storeUrl ?? '', reason });
  };

  const cleaned = [];
  for (const raw of rawRows) {
    const c = cleanRow(raw);
    if (c.drop) { reject(raw, c.drop); continue; }
    for (const n of c.notes) report.fixes[n] = (report.fixes[n] || 0) + 1;
    cleaned.push({ ...c, source, raw });
  }

  const domainStatus = await checkDomains(cleaned.map((r) => r.domain));
  const stores = await loadStores();
  const unknown = new Map();
  const keep = [];
  for (const r of cleaned) {
    const status = domainStatus.get(r.domain);
    if (status === 'none') { reject(r.raw, 'email domain takes no mail'); continue; }
    r.emailCheck = status === 'ok' ? 'ok' : 'unverified';
    const store = stores.get(rules.matchDomain(r.storeDomain));
    if (store) {
      r.storeId = store.id;
      r.storeDomain = store.domain;
      r.storeName = store.brand_name;
    } else {
      const u = unknown.get(r.storeDomain) || { domain: r.storeDomain, storeName: r.storeName, count: 0 };
      u.count++;
      u.storeName = u.storeName || r.storeName;
      unknown.set(r.storeDomain, u);
      if (unknownStores === 'skip') { reject(r.raw, 'store not set up yet'); continue; }
    }
    keep.push(r);
  }
  report.unknownStores = [...unknown.values()].sort((a, b) => b.count - a.count);

  const byEmail = new Map();
  for (const r of keep) (byEmail.get(r.email) || byEmail.set(r.email, []).get(r.email)).push(r);
  const emails = [...byEmail.keys()];

  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK);
    const run = async (client) => {
      if (apply) await client.query('SELECT pg_advisory_xact_lock($1)', [INGEST_LOCK]);
      const { rows: existingRows } = await client.query('SELECT * FROM customers WHERE email = ANY($1)', [chunk]);
      const { rows: linkRows } = await client.query('SELECT * FROM customer_stores WHERE email = ANY($1)', [chunk]);
      const existing = new Map(existingRows.map((r) => [r.email, r]));
      const linksOf = new Map();
      for (const l of linkRows) (linksOf.get(l.email) || linksOf.set(l.email, []).get(l.email)).push(l);

      const merged = chunk.map((email) => {
        const rows = byEmail.get(email);
        const m = mergeCustomer(existing.get(email) || null, linksOf.get(email) || [], rows);
        if (lockName && rows[0].name) { m.customer.name = rows[0].name; m.customer.name_locked = true; }
        return m;
      });
      for (const m of merged) {
        if (m.isNew) report.added++; else report.updated++;
        if (m.storeChanged) report.storeChanged++;
        if (m.customer.email_check !== 'ok') report.unverified++;
      }
      report.saved += merged.length;
      if (!apply) return;

      const linkList = merged.flatMap((m) => m.links.map((l) => ({ ...l, email: m.customer.email })));
      await client.query(`
        INSERT INTO customer_stores (email, store_domain, store_id, store_name, first_seen_at, last_seen_at, sources, added_at)
        SELECT x.email, x.store_domain, x.store_id, x.store_name, x.first_seen_at, x.last_seen_at,
               ARRAY(SELECT jsonb_array_elements_text(x.sources)), x.added_at
          FROM jsonb_to_recordset($1::jsonb) AS x(email text, store_domain text, store_id int, store_name text,
               first_seen_at timestamptz, last_seen_at timestamptz, sources jsonb, added_at timestamptz)
        ON CONFLICT (email, store_domain) DO UPDATE SET
          store_id = EXCLUDED.store_id, store_name = COALESCE(customer_stores.store_name, EXCLUDED.store_name),
          first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at, sources = EXCLUDED.sources`,
      [JSON.stringify(linkList.map((l) => ({ ...l, sources: [...l.sources] })))]);

      const { rows: saved } = await client.query(`
        INSERT INTO customers (email, store_domain, store_id, name, name_locked, phone, moved_to_domain, status, email_check,
                               from_chat, from_upload, added_manually, from_checkout, last_seen_at, last_source, created_by)
        SELECT x.email, x.store_domain, x.store_id, x.name, x.name_locked, x.phone, x.moved_to_domain, x.status, x.email_check,
               x.from_chat, x.from_upload, x.added_manually, x.from_checkout, x.last_seen_at, x.last_source, $2
          FROM jsonb_to_recordset($1::jsonb) AS x(email text, store_domain text, store_id int, name text, name_locked boolean,
               phone text, moved_to_domain text, status text, email_check text, from_chat boolean, from_upload boolean,
               added_manually boolean, from_checkout boolean, last_seen_at timestamptz, last_source text)
        ON CONFLICT (email) DO UPDATE SET
          store_domain = EXCLUDED.store_domain, store_id = EXCLUDED.store_id, name = EXCLUDED.name,
          name_locked = EXCLUDED.name_locked, phone = EXCLUDED.phone, moved_to_domain = EXCLUDED.moved_to_domain,
          email_check = EXCLUDED.email_check, from_chat = EXCLUDED.from_chat, from_upload = EXCLUDED.from_upload,
          added_manually = EXCLUDED.added_manually, from_checkout = EXCLUDED.from_checkout,
          last_seen_at = EXCLUDED.last_seen_at, last_source = EXCLUDED.last_source, updated_at = NOW()
        RETURNING id`,
      [JSON.stringify(merged.map((m) => m.customer)), createdBy]);
      report.customerIds.push(...saved.map((r) => r.id));
    };
    if (apply) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await run(client);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else {
      await run(pool);
    }
  }
  return report;
}

module.exports = { ingest, mergeCustomer, SOURCE_RANK };
