// server/routes/customers.js
//   GET    /api/customers                  page of the customer list (+ per-country counts)
//   POST   /api/customers                  add one by hand
//   PUT    /api/customers/:id              edit name / email
//   POST   /api/customers/:id/archive|restore
//   DELETE /api/customers/:id
//   POST   /api/customers/import[?apply=1] check (preview) or import a CSV/XLSX
//   GET    /api/customers/import/template  the CSV format to follow
//   GET    /api/customers/:id/history      every store this customer was linked to
//   GET    /api/customers/export           the filtered list as CSV
//   POST   /api/customers/batch            one action on many: move, archive, restore, block, unsubscribe, delete
//   POST   /api/customers/export           the selected customers as CSV
//   GET    /api/audience                   everyone a campaign could go to
//   GET    /api/sent   POST /api/sent/reset           sent ledger
//   GET    /api/opt-outs, POST/DELETE …/unsubscribes, …/blocks   do-not-email list
//   POST   /api/opt-outs/batch             remove several at once

const express = require('express');
const multer = require('multer');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { EMAIL_RE, cleanDomain } = require('../lib/merge');
const customers = require('../services/customers');
const customerImport = require('../services/customerImport');
const { getSuppressedEmails } = require('../services/optOuts');
const { wrap, httpError, idParam, str, intList } = require('./util');

const router = express.Router();
router.use(['/customers', '/audience', '/sent', '/opt-outs'], requireAuth);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function listFilters(q) {
  return {
    storeGroup: str(q.storeGroup),
    storeIds: intList(q.storeIds),
    country: str(q.country)?.toUpperCase(),
    search: str(q.search),
    sources: str(q.sources),
    status: ['active', 'archived', 'all', 'unverified', 'no_store'].includes(q.status) ? q.status : 'active',
  };
}

router.get('/customers', wrap(async (req, res) => {
  res.json(await customers.listCustomers({
    ...listFilters(req.query),
    limit: Math.min(parseInt(req.query.limit, 10) || 50, 500),
    offset: parseInt(req.query.offset, 10) || 0,
  }));
}));

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function sendCsv(res, rows) {
  const header = ['customer_name', 'email', 'store_name', 'store_url', 'phone', 'last_order_date', 'country', 'sources', 'status'];
  const lines = [header.join(',')].concat(rows.map((r) => [
    r.name, r.email, r.store_name, r.store_domain, r.phone,
    r.last_seen_at ? new Date(r.last_seen_at).toISOString().slice(0, 10) : '', r.country,
    [r.from_checkout && 'checkout', r.from_chat && 'chat', r.from_upload && 'upload', r.added_manually && 'manual'].filter(Boolean).join(' '),
    r.status || (r.email_check !== 'ok' ? 'unverified' : 'active'),
  ].map(csvCell).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
}

router.get('/customers/export', wrap(async (req, res) => {
  const { rows } = await customers.listCustomers({ ...listFilters(req.query), limit: 500000, offset: 0 });
  sendCsv(res, rows);
}));

// { ids } or { all: true, filters, exceptIds }: what the list's checkboxes picked.
function readSelection(body) {
  const sel = body?.selection || {};
  return {
    ids: intList(sel.ids) || [],
    all: sel.all === true,
    filters: listFilters(sel.filters || {}),
    exceptIds: intList(sel.exceptIds) || [],
  };
}

router.post('/customers/export', wrap(async (req, res) => {
  const ids = await customers.resolveSelection(readSelection(req.body));
  if (!ids.length) throw httpError(400, 'Pick the customers to export');
  sendCsv(res, await customers.customersByIds(ids));
}));

router.post('/customers/batch', wrap(async (req, res) => {
  const action = String(req.body?.action || '');
  const ids = await customers.resolveSelection(readSelection(req.body));
  if (!ids.length) throw httpError(400, 'Pick at least one customer');
  const result = await customers.batchCustomers(action, ids, { storeId: parseInt(req.body?.storeId, 10), user: req.user.email });
  console.log(`[customers] ${req.user.email}: ${action} on ${ids.length} selected, ${result.changed} changed`);
  res.json({ selected: ids.length, ...result });
}));

router.get('/customers/import/template', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="customer-connect-template.csv"');
  res.send(customerImport.TEMPLATE);
});

router.post('/customers', wrap(async (req, res) => {
  const { email, name, phone, storeId } = req.body || {};
  if (!EMAIL_RE.test(String(email || '').trim())) throw httpError(400, 'Enter a valid email');
  const sid = parseInt(storeId, 10);
  if (!Number.isFinite(sid)) throw httpError(400, 'Pick the store this customer belongs to');
  const { customer, report } = await customers.addCustomer({ email, name, phone, storeId: sid, createdBy: req.user.email });
  res.status(report.added ? 201 : 200).json({ ...customer, existed: !report.added, unverified: customer.email_check !== 'ok' });
}));

router.get('/customers/:id/history', wrap(async (req, res) => {
  res.json(await customers.storeHistory(idParam(req)));
}));

router.put('/customers/:id', wrap(async (req, res) => {
  const { name, email, phone, storeId } = req.body || {};
  const updated = await customers.updateCustomer(idParam(req), { name, email, phone, storeId });
  if (!updated) throw httpError(404, 'Customer not found');
  res.json(updated);
}));

router.post('/customers/:id/:action(archive|restore)', wrap(async (req, res) => {
  const updated = await customers.setStatus(idParam(req), req.params.action === 'archive' ? 'archived' : null);
  if (!updated) throw httpError(404, 'Customer not found');
  res.json(updated);
}));

router.delete('/customers/:id', wrap(async (req, res) => {
  if (!(await customers.deleteCustomer(idParam(req)))) throw httpError(404, 'Customer not found');
  res.json({ deleted: true });
}));

router.post('/customers/import', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw httpError(400, 'Choose a CSV or Excel file to import');
  const apply = req.query.apply === '1';
  const result = await customerImport.importFile(req.file.buffer, { apply, createdBy: req.user.email });
  if (result.error) throw httpError(400, result.error);
  if (apply) {
    console.log(`[customers] import by ${req.user.email}: ${result.added} added, ${result.updated} updated (${result.storeChanged} moved store), ${result.rejected.length} not saved`);
  }
  res.json(result);
}));

// ── Campaign audience ───────────────────────────────────────────────────────

router.get('/audience', wrap(async (req, res) => {
  const rows = await customers.listAudience({
    storeGroup: str(req.query.storeGroup),
    storeIds: intList(req.query.storeIds),
    country: str(req.query.country)?.toUpperCase(),
    sources: str(req.query.sources),
    skipAlreadyEmailed: req.query.skipAlreadyEmailed === '1',
  });
  const suppressed = await getSuppressedEmails();
  const kept = suppressed.size ? rows.filter((r) => !suppressed.has(r.email)) : rows;
  res.json({ rows: kept, suppressedCount: rows.length - kept.length });
}));

// ── Sent ledger ─────────────────────────────────────────────────────────────

router.get('/sent', wrap(async (req, res) => {
  const group = str(req.query.storeGroup);
  const search = str(req.query.search);
  const params = [];
  const where = [];
  if (group) { params.push(group); where.push(`s.store_group = $${params.length}`); }
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    where.push(`(LOWER(se.email) LIKE $${params.length} OR LOWER(COALESCE(se.store_name, '')) LIKE $${params.length} OR se.store_domain LIKE $${params.length})`);
  }
  const { rows } = await pool.query(`
    SELECT se.id, se.email, se.store_domain, se.store_name, se.sent_at, c.name AS campaign_name
      FROM sent_emails se
      LEFT JOIN stores s ON s.domain = se.store_domain
      LEFT JOIN campaigns c ON c.id = se.campaign_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY se.sent_at DESC LIMIT 5000`, params);
  res.json(rows);
}));

// Forgets that these (email, store) pairs were emailed, so "leave out people
// this store already emailed" includes them again.
router.post('/sent/reset', wrap(async (req, res) => {
  const ids = intList(req.body?.ids) || [];
  if (!ids.length) throw httpError(400, 'Pick the rows to reset');
  const { rowCount } = await pool.query('DELETE FROM sent_emails WHERE id = ANY($1)', [ids]);
  res.json({ reset: rowCount });
}));

// ── Do not email ────────────────────────────────────────────────────────────

router.get('/opt-outs', wrap(async (req, res) => {
  const search = str(req.query.search);
  const params = search ? [`%${search.toLowerCase()}%`] : [];
  const filter = search ? 'WHERE LOWER(email) LIKE $1' : '';
  const [unsub, blocks] = await Promise.all([
    pool.query(`SELECT id, email, source, created_at FROM unsubscribes ${filter} ORDER BY created_at DESC LIMIT 2000`, params),
    pool.query(`SELECT id, email, store_domain, reason, created_by, created_at FROM blocklist ${filter} ORDER BY created_at DESC LIMIT 2000`, params),
  ]);
  res.json({ unsubscribes: unsub.rows, blocks: blocks.rows });
}));

router.post('/opt-outs/unsubscribes', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email');
  await pool.query(`INSERT INTO unsubscribes (email, source) VALUES ($1, 'manual') ON CONFLICT (email) DO NOTHING`, [email]);
  res.status(201).json({ ok: true });
}));

router.delete('/opt-outs/unsubscribes/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM unsubscribes WHERE id = $1', [idParam(req)]);
  if (!rowCount) throw httpError(404, 'Not found');
  res.json({ deleted: true });
}));

router.post('/opt-outs/blocks', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email');
  // A block applies to every store (it follows the person if they move);
  // the store is only kept as a note of where it came from.
  const storeDomain = cleanDomain(req.body?.storeDomain) || null;
  await pool.query(`
    INSERT INTO blocklist (email, store_domain, reason, created_by) VALUES ($1, $2, $3, $4)
    ON CONFLICT ON CONSTRAINT blocklist_email_store_unique DO UPDATE SET reason = EXCLUDED.reason`,
  [email, storeDomain, str(req.body?.reason) || null, req.user.email]);
  res.status(201).json({ ok: true });
}));

router.post('/opt-outs/batch', wrap(async (req, res) => {
  if (req.body?.action !== 'remove') throw httpError(400, 'Unknown action');
  const unsubscribeIds = intList(req.body?.unsubscribeIds) || [];
  const blockIds = intList(req.body?.blockIds) || [];
  const a = unsubscribeIds.length ? (await pool.query('DELETE FROM unsubscribes WHERE id = ANY($1)', [unsubscribeIds])).rowCount : 0;
  const b = blockIds.length ? (await pool.query('DELETE FROM blocklist WHERE id = ANY($1)', [blockIds])).rowCount : 0;
  res.json({ changed: a + b });
}));

router.delete('/opt-outs/blocks/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM blocklist WHERE id = $1', [idParam(req)]);
  if (!rowCount) throw httpError(404, 'Not found');
  res.json({ deleted: true });
}));

module.exports = router;
