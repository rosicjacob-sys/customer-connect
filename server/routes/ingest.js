// server/routes/ingest.js
//   POST /api/ingest/checkout   paid orders from the checkout portal
//
// Signed with CHECKOUT_PORTAL_SECRET, which both apps share:
//   X-CC-Timestamp: <unix seconds>
//   X-CC-Signature: hex HMAC-SHA256 of "<timestamp>.<raw body>"
// Requests older than 5 minutes are refused, so a captured one can't be
// replayed later. Sending the same order twice changes nothing.
//
// Body: { orders: [{ order_id, email, first_name, last_name, phone,
//                    store_domain, store_name, paid_at }] }  (at most 1000)

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../db');
const { ingest } = require('../services/ingest');
const { wrap, httpError } = require('./util');

const router = express.Router();
const MAX_SKEW_S = 300;

function verify(req) {
  if (!config.checkoutPortalSecret) throw httpError(503, 'Checkout portal link is off (CHECKOUT_PORTAL_SECRET is not set)');
  const ts = Number(req.get('X-CC-Timestamp'));
  const sig = String(req.get('X-CC-Signature') || '');
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_S) throw httpError(401, 'Missing or stale timestamp');
  const expected = crypto.createHmac('sha256', config.checkoutPortalSecret)
    .update(`${ts}.`).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw httpError(401, 'Bad signature');
  }
}

router.post('/ingest/checkout', wrap(async (req, res) => {
  verify(req);
  const orders = Array.isArray(req.body?.orders) ? req.body.orders : [];
  if (!orders.length) throw httpError(400, 'No orders');
  if (orders.length > 1000) throw httpError(413, 'At most 1000 orders per request');

  const report = await ingest(orders.map((o) => ({
    line: o.order_id ?? null,
    email: o.email,
    name: [o.first_name, o.last_name].map((x) => String(x ?? '').trim()).filter(Boolean).join(' '),
    phone: o.phone,
    storeUrl: o.store_domain,
    storeName: o.store_name,
    seenAt: o.paid_at,
  })), { source: 'checkout' });

  const summary = {
    received: orders.length, saved: report.saved, added: report.added, updated: report.updated,
    storeChanged: report.storeChanged, notSaved: report.rejected.length, dropped: report.dropped,
    waitingForStore: report.unknownStores.map((u) => u.domain),
  };
  // Running totals for the Settings page.
  const prev = (await db.getSetting('checkout_portal')) || { orders: 0, saved: 0, notSaved: 0 };
  await db.setSetting('checkout_portal', {
    lastAt: new Date().toISOString(), orders: prev.orders + orders.length,
    saved: prev.saved + report.saved, notSaved: prev.notSaved + report.rejected.length,
    lastNotSaved: report.rejected.slice(0, 20).map((r) => ({ order: r.line, reason: r.reason })),
  });
  res.json(summary);
}));

module.exports = router;
