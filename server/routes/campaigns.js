// server/routes/campaigns.js
//   /api/templates …              saved templates (CRUD), scoped per store group
//   POST /api/test-send           one email to one address, as a given store
//   /api/campaigns …              list, detail, create, edit, pause/resume/stop, delete

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { EMAIL_RE, movedBanner } = require('../lib/merge');
const { sendToRecipient } = require('../services/sender');
const campaigns = require('../services/campaigns');
const worker = require('../services/worker');
const { wrap, httpError, idParam, str } = require('./util');

const router = express.Router();
router.use(['/templates', '/test-send', '/campaigns'], requireAuth);

// ── Templates ───────────────────────────────────────────────────────────────

router.get('/templates', wrap(async (req, res) => {
  const group = str(req.query.storeGroup);
  const { rows } = await pool.query(`
    SELECT id, name, subject, store_group, created_by, created_at, updated_at FROM templates
     ${group ? 'WHERE store_group = $1 OR store_group IS NULL' : ''} ORDER BY updated_at DESC`, group ? [group] : []);
  res.json(rows);
}));

router.get('/templates/:id', wrap(async (req, res) => {
  const { rows: [t] } = await pool.query('SELECT * FROM templates WHERE id = $1', [idParam(req)]);
  if (!t) throw httpError(404, 'Template not found');
  res.json(t);
}));

function readTemplate(body) {
  const t = {
    name: String(body.name || '').trim(),
    subject: String(body.subject || '').trim(),
    html: String(body.html || ''),
    text: String(body.text || '').trim() || null,
  };
  if (!t.name) throw httpError(400, 'Give the template a name');
  if (!t.subject) throw httpError(400, 'Add a subject');
  if (!t.html.trim()) throw httpError(400, 'Add the HTML');
  return t;
}

router.post('/templates', wrap(async (req, res) => {
  const t = readTemplate(req.body || {});
  const { rows: [row] } = await pool.query(
    'INSERT INTO templates (name, subject, html, text, store_group, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [t.name, t.subject, t.html, t.text, str(req.body.storeGroup) || null, req.user.email]);
  res.status(201).json(row);
}));

router.put('/templates/:id', wrap(async (req, res) => {
  const t = readTemplate(req.body || {});
  const { rows: [row] } = await pool.query(
    'UPDATE templates SET name = $2, subject = $3, html = $4, text = $5, updated_at = NOW() WHERE id = $1 RETURNING *',
    [idParam(req), t.name, t.subject, t.html, t.text]);
  if (!row) throw httpError(404, 'Template not found');
  res.json(row);
}));

// Campaigns keep their own copy of the content, so deleting a template
// never changes what a running campaign sends.
router.delete('/templates/:id', wrap(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM templates WHERE id = $1', [idParam(req)]);
  if (!rowCount) throw httpError(404, 'Template not found');
  res.json({ deleted: true });
}));

// ── Test send ───────────────────────────────────────────────────────────────

// Sends the content to one address as if it came from the chosen store:
// its name, colours, links and from-address fill the email. Opt-out lists
// are not checked; the address is yours.
router.post('/test-send', wrap(async (req, res) => {
  const { to, storeId, subject, html, text, campaignName, customerId } = req.body || {};
  const email = String(to || '').trim();
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email to send the test to');
  if (!String(subject || '').trim() || !String(html || '').trim()) throw httpError(400, 'Add a subject and HTML first');

  let recipient = null;
  if (customerId) {
    // "Render as" a real recipient: their store, name and moved banner.
    const { rows: [c] } = await pool.query(
      `SELECT cu.*, s.brand_name, s.brand_color FROM customers cu LEFT JOIN stores s ON s.id = cu.store_id WHERE cu.id = $1`, [customerId]);
    if (!c) throw httpError(404, 'Customer not found');
    const domain = c.moved_to_domain || c.store_domain;
    const banner = c.moved_to_domain ? movedBanner(c.moved_to_domain, c.brand_color || undefined) : { html: '', text: '' };
    recipient = { name: c.name, storeId: c.store_id, storeName: c.brand_name || c.store_domain, storeDomain: domain,
      storeUrl: domain ? `https://${domain}` : '', movedBanner: banner.html, movedBannerText: banner.text };
  } else {
    const { rows: [s] } = await pool.query('SELECT * FROM stores WHERE id = $1', [parseInt(storeId, 10) || 0]);
    if (!s) throw httpError(400, 'Pick the store this email should come from');
    recipient = { name: '', storeId: s.id, storeName: s.brand_name, storeDomain: s.domain, storeUrl: `https://${s.domain}` };
  }

  const result = await sendToRecipient({ ...recipient, email }, {
    subject, html, text: text || null, campaignName: campaignName || 'Test',
  }, { label: 'Test send' });
  if (!result.ok) throw httpError(502, result.error);
  res.json({ ok: true, storeName: recipient.storeName });
}));

// ── Campaigns ───────────────────────────────────────────────────────────────

router.get('/campaigns', wrap(async (req, res) => {
  res.json(await campaigns.listCampaigns({ storeGroup: str(req.query.storeGroup) }));
}));

router.get('/campaigns/:id', wrap(async (req, res) => {
  const detail = await campaigns.getCampaignDetail(idParam(req));
  if (!detail) throw httpError(404, 'Campaign not found');
  res.json(detail);
}));

router.post('/campaigns', wrap(async (req, res) => {
  const created = await campaigns.createCampaign(req.body || {}, req.user);
  worker.kick();
  res.status(201).json(created);
}));

router.patch('/campaigns/:id', wrap(async (req, res) => {
  const updated = await campaigns.updateCampaign(idParam(req), req.body || {}, req.user);
  worker.kick();
  res.json(updated);
}));

router.post('/campaigns/:id/:action(pause|resume|cancel)', wrap(async (req, res) => {
  const updated = await campaigns.changeStatus(idParam(req), req.params.action);
  if (req.params.action === 'resume') worker.kick();
  res.json(updated);
}));

router.delete('/campaigns/:id', wrap(async (req, res) => {
  await campaigns.deleteCampaign(idParam(req));
  res.json({ deleted: true });
}));

module.exports = router;
