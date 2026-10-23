// server/routes/stores.js
//   GET    /api/groups                   store groups with store counts
//   GET    /api/stores?storeGroup=       stores (senders)
//   POST   /api/stores  PUT /api/stores/:id  DELETE /api/stores/:id
//   POST   /api/stores/bulk              add several stores (e.g. the ones a CSV named)
//   GET    /api/stores/waiting           store domains customers were saved under, not set up yet
//   POST   /api/stores/assign            give those domains (and their customers) to an existing store
//   DELETE /api/stores/aliases/:domain   stop sending that domain's new customers to the store
//   POST   /api/stores/batch             one action on several stores (segment, group, country, active, merge, delete)
//   GET    /api/segments?storeGroup=     saved store sets + "Others"
//   PUT    /api/segments                 create (no id) or replace one
//   DELETE /api/segments/:id

const express = require('express');
const { pool, transaction } = require('../db');
const { requireAuth } = require('../auth');
const { EMAIL_RE, cleanDomain } = require('../lib/merge');
const customers = require('../services/customers');
const storeMoves = require('../services/storeMoves');
const { wrap, httpError, idParam, str, intList } = require('./util');

const router = express.Router();
router.use(['/groups', '/stores', '/segments'], requireAuth);

const serializeStore = (s) => ({
  id: s.id,
  domain: s.domain,
  brandName: s.brand_name,
  storeGroup: s.store_group,
  storeGroupName: s.store_group_name,
  country: s.country,
  brandColor: s.brand_color,
  fromEmail: s.from_email,
  fromName: s.from_name,
  replyTo: s.reply_to,
  isActive: s.is_active,
  fromChatSupport: s.csp_store_id != null,
  customerCount: s.customer_count != null ? Number(s.customer_count) : undefined,
  aliases: s.aliases || [],
});

router.get('/groups', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT store_group AS key, MAX(COALESCE(store_group_name, store_group)) AS name, COUNT(*)::int AS stores
      FROM stores WHERE store_group IS NOT NULL GROUP BY store_group ORDER BY 2`);
  res.json(rows);
}));

router.get('/stores', wrap(async (req, res) => {
  const group = str(req.query.storeGroup);
  const { rows } = await pool.query(`
    SELECT s.*, (SELECT COUNT(*) FROM customers c WHERE c.store_id = s.id) AS customer_count,
           ARRAY(SELECT a.domain FROM store_aliases a WHERE a.store_id = s.id ORDER BY a.domain) AS aliases
      FROM stores s ${group ? 'WHERE s.store_group = $1' : ''}
     ORDER BY s.store_group NULLS LAST, LOWER(s.brand_name)`, group ? [group] : []);
  res.json(rows.map(serializeStore));
}));

function readStoreBody(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has('domain')) {
    out.domain = cleanDomain(body.domain);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(out.domain.replace(/^www\./, ''))) throw httpError(400, 'Enter the store domain, e.g. mystore.com');
  }
  if (!partial || has('brandName')) {
    out.brand_name = String(body.brandName || '').trim();
    if (!out.brand_name) throw httpError(400, 'Enter the store name');
  }
  if (!partial || has('storeGroup')) {
    const key = String(body.storeGroup || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    out.store_group = key || null;
    out.store_group_name = key ? (String(body.storeGroupName || '').trim() || String(body.storeGroup).trim()) : null;
  }
  if (!partial || has('country')) {
    const c = String(body.country || '').trim().toUpperCase();
    if (c && !/^[A-Z]{2}$/.test(c)) throw httpError(400, 'Country is a two-letter code such as CA or US');
    out.country = c || null;
  }
  if (!partial || has('brandColor')) {
    const c = String(body.brandColor || '').trim();
    if (c && !/^#[0-9a-f]{6}$/i.test(c)) throw httpError(400, 'Brand colour is a hex colour such as #1A5632');
    out.brand_color = c || null;
  }
  for (const [k, col] of [['fromEmail', 'from_email'], ['replyTo', 'reply_to']]) {
    if (!partial || has(k)) {
      const v = String(body[k] || '').trim().toLowerCase();
      if (v && !EMAIL_RE.test(v)) throw httpError(400, `${k === 'fromEmail' ? 'From' : 'Reply-to'} address is not a valid email`);
      out[col] = v || null;
    }
  }
  if (!partial || has('fromName')) out.from_name = String(body.fromName || '').trim() || null;
  if (!partial || has('isActive')) out.is_active = body.isActive !== false;
  return out;
}

router.post('/stores', wrap(async (req, res) => {
  const s = readStoreBody(req.body || {});
  try {
    const cols = Object.keys(s);
    const { rows: [row] } = await pool.query(
      `INSERT INTO stores (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(s));
    await storeMoves.dropAliasesFor([row.domain]);
    await customers.linkUnmatched();
    res.status(201).json(serializeStore(row));
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'A store with that domain already exists');
    throw err;
  }
}));

router.post('/stores/bulk', wrap(async (req, res) => {
  const list = Array.isArray(req.body?.stores) ? req.body.stores : [];
  if (!list.length) throw httpError(400, 'No stores to add');
  if (list.length > 500) throw httpError(400, 'Add at most 500 stores at a time');
  const shared = { storeGroup: req.body.storeGroup, storeGroupName: req.body.storeGroupName, country: req.body.country };
  const added = [];
  const skipped = [];
  for (const item of list) {
    let s;
    try {
      s = readStoreBody({ ...shared, ...item, brandName: item.brandName || item.domain });
    } catch (err) {
      skipped.push({ domain: item.domain, reason: err.message });
      continue;
    }
    const cols = Object.keys(s);
    const { rows: [row] } = await pool.query(
      `INSERT INTO stores (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
       ON CONFLICT (domain) DO NOTHING RETURNING *`, Object.values(s));
    if (row) added.push(serializeStore(row)); else skipped.push({ domain: s.domain, reason: 'already exists' });
  }
  if (added.length) await storeMoves.dropAliasesFor(added.map((s) => s.domain));
  const linked = await customers.linkUnmatched();
  res.status(201).json({ added, skipped, customersLinked: linked });
}));

router.get('/stores/waiting', wrap(async (req, res) => {
  res.json(await customers.waitingForStore());
}));

router.post('/stores/assign', wrap(async (req, res) => {
  const storeId = parseInt(req.body?.storeId, 10);
  if (!Number.isFinite(storeId)) throw httpError(400, 'Pick the store to assign them to');
  const domains = Array.isArray(req.body?.domains) ? req.body.domains : [];
  const result = await storeMoves.assignDomains({ domains, storeId, createdBy: req.user.email });
  console.log(`[stores] ${req.user.email} assigned ${result.domains.join(', ')} to ${result.store} (${result.customersMoved} customers)`);
  res.json(result);
}));

router.delete('/stores/aliases/:domain', wrap(async (req, res) => {
  if (!(await storeMoves.removeAlias(req.params.domain))) throw httpError(404, 'No such rule');
  res.json({ deleted: true });
}));

// One action on several stores. Stores copied from Chat Support Pro get
// their group, country and active flag back from it on the next sync, and
// come back if deleted; merging them sticks (the sync skips merged domains).
router.post('/stores/batch', wrap(async (req, res) => {
  const ids = intList(req.body?.ids) || [];
  const action = String(req.body?.action || '');
  if (!ids.length) throw httpError(400, 'Pick at least one store');
  const b = req.body;
  let changed = 0;
  if (action === 'segment-add' || action === 'segment-remove') {
    let segmentId = parseInt(b.segmentId, 10);
    if (action === 'segment-add' && !Number.isFinite(segmentId)) {
      const name = String(b.segmentName || '').trim();
      if (!name) throw httpError(400, 'Pick a segment or name a new one');
      if (name.toLowerCase() === 'others') throw httpError(400, '"Others" is kept for stores that are in no segment');
      const { rows: [seg] } = await pool.query(
        `INSERT INTO segments (name) VALUES ($1) ON CONFLICT ((LOWER(name))) DO UPDATE SET updated_at = NOW() RETURNING id`, [name]);
      segmentId = seg.id;
    }
    if (!Number.isFinite(segmentId)) throw httpError(400, 'Pick a segment');
    changed = (action === 'segment-add'
      ? await pool.query(`INSERT INTO segment_stores (segment_id, store_id) SELECT $1, id FROM stores WHERE id = ANY($2) ON CONFLICT DO NOTHING`, [segmentId, ids])
      : await pool.query('DELETE FROM segment_stores WHERE segment_id = $1 AND store_id = ANY($2)', [segmentId, ids])).rowCount;
    return res.json({ changed, segmentId });
  }
  if (action === 'group' || action === 'country') {
    const s = readStoreBody(action === 'group' ? { storeGroup: b.storeGroup, storeGroupName: b.storeGroupName } : { country: b.country }, { partial: true });
    const cols = Object.keys(s);
    changed = (await pool.query(
      `UPDATE stores SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = ANY($1)`,
      [ids, ...Object.values(s)])).rowCount;
  } else if (action === 'activate' || action === 'deactivate') {
    changed = (await pool.query('UPDATE stores SET is_active = $2, updated_at = NOW() WHERE id = ANY($1)', [ids, action === 'activate'])).rowCount;
  } else if (action === 'merge') {
    const targetId = parseInt(b.targetId, 10);
    if (!Number.isFinite(targetId)) throw httpError(400, 'Pick the store to keep');
    const result = await storeMoves.mergeStores({ ids, targetId, createdBy: req.user.email });
    console.log(`[stores] ${req.user.email} merged ${result.merged.join(', ')} into ${result.into} (${result.customersMoved} customers)`);
    return res.json({ changed: result.merged.length, ...result });
  } else if (action === 'delete') {
    changed = (await pool.query('DELETE FROM stores WHERE id = ANY($1)', [ids])).rowCount;
  } else {
    throw httpError(400, 'Unknown action');
  }
  res.json({ changed });
}));

// Changing the domain moves the store's customers to it.
router.put('/stores/:id', wrap(async (req, res) => {
  const id = idParam(req);
  const s = readStoreBody(req.body || {}, { partial: true });
  const row = await transaction(async (client) => {
    const { rows: [before] } = await client.query('SELECT * FROM stores WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw httpError(404, 'Store not found');
    const cols = Object.keys(s);
    if (!cols.length) return before;
    const { rows: [after] } = await client.query(
      `UPDATE stores SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, ...Object.values(s)]);
    if (s.domain && s.domain !== before.domain) {
      await customers.moveStoreDomain(client, id, s.domain);
      await storeMoves.dropAliasesFor([s.domain], client);
    }
    return after;
  }).catch((err) => {
    if (err.code === '23505') throw httpError(409, 'Another store already uses that domain');
    throw err;
  });
  await customers.linkUnmatched();
  res.json(serializeStore(row));
}));

// Its customers stay on the list (without a store); campaigns already
// created keep the copy of the store's details they were made with.
router.delete('/stores/:id', wrap(async (req, res) => {
  const id = idParam(req);
  const { rowCount } = await pool.query('DELETE FROM stores WHERE id = $1', [id]);
  if (!rowCount) throw httpError(404, 'Store not found');
  res.json({ deleted: true });
}));

// ── Segments ────────────────────────────────────────────────────────────────

router.get('/segments', wrap(async (req, res) => {
  const group = str(req.query.storeGroup);
  const params = group ? [group] : [];
  const groupClause = group ? 'AND s.store_group = $1' : '';
  const { rows: segRows } = await pool.query(`
    SELECT g.id, g.name,
           COALESCE(ARRAY_AGG(s.id ORDER BY s.brand_name) FILTER (WHERE s.id IS NOT NULL), '{}') AS store_ids
      FROM segments g
      LEFT JOIN segment_stores gs ON gs.segment_id = g.id
      LEFT JOIN stores s ON s.id = gs.store_id ${groupClause}
     GROUP BY g.id, g.name ORDER BY LOWER(g.name)`, params);
  const { rows: other } = await pool.query(`
    SELECT s.id FROM stores s
     WHERE NOT EXISTS (SELECT 1 FROM segment_stores gs WHERE gs.store_id = s.id) ${groupClause}
     ORDER BY s.brand_name`, params);
  res.json({ segments: segRows.map((r) => ({ id: r.id, name: r.name, storeIds: r.store_ids })), otherStoreIds: other.map((r) => r.id) });
}));

// With a storeGroup, only that group's memberships are replaced, so editing
// a segment from one group's view never drops stores of another group.
router.put('/segments', wrap(async (req, res) => {
  const { id, name, storeIds, storeGroup } = req.body || {};
  const cleanName = String(name || '').trim();
  if (!cleanName) throw httpError(400, 'Give the segment a name');
  if (cleanName.toLowerCase() === 'others') throw httpError(400, '"Others" is kept for stores that are in no segment');
  const ids = intList(storeIds) || [];
  const group = str(storeGroup) || null;
  const segmentId = await transaction(async (client) => {
    let sid = id != null ? parseInt(id, 10) : null;
    if (sid) {
      const { rowCount } = await client.query('UPDATE segments SET name = $2, updated_at = NOW() WHERE id = $1', [sid, cleanName]);
      if (!rowCount) throw httpError(404, 'Segment not found');
      await client.query(
        `DELETE FROM segment_stores WHERE segment_id = $1
           AND ($2::text IS NULL OR store_id IN (SELECT id FROM stores WHERE store_group = $2))`, [sid, group]);
    } else {
      sid = (await client.query('INSERT INTO segments (name) VALUES ($1) RETURNING id', [cleanName])).rows[0].id;
    }
    if (ids.length) {
      await client.query(`
        INSERT INTO segment_stores (segment_id, store_id)
        SELECT $1, s.id FROM stores s WHERE s.id = ANY($2) AND ($3::text IS NULL OR s.store_group = $3)
        ON CONFLICT DO NOTHING`, [sid, ids, group]);
    }
    return sid;
  }).catch((err) => {
    if (err.code === '23505') throw httpError(409, 'A segment with that name already exists');
    throw err;
  });
  res.json({ id: segmentId, name: cleanName, storeIds: ids });
}));

router.delete('/segments/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM segments WHERE id = $1', [idParam(req)]);
  if (!rowCount) throw httpError(404, 'Segment not found');
  res.json({ deleted: true });
}));

module.exports = router;
