// server/services/campaigns.js
// Campaigns: creating, editing, pausing, and sending them.
//
// Every campaign is sent by the backend worker (services/worker.js), so
// nobody has to keep a browser tab open. "Send now" is a campaign whose
// single batch is everyone, starting immediately; "Schedule" sends
// batch_size every interval_minutes, inside the daily sending hours, up to
// the daily limit, until everyone is sent or the end time passes.
//
// Scheduling state lives in the campaigns row (next_fire_at), not in a
// queue, so a restart loses nothing: the worker picks up whatever is due.

const config = require('../config');
const { pool, transaction } = require('../db');
const S = require('../lib/schedule');
const { movedBanner } = require('../lib/merge');
const { sendToRecipient } = require('./sender');
const { loadOptOuts } = require('./optOuts');

const LOCK_MINUTES = 3;
const ACTIVE = ['scheduled', 'running', 'paused'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpError = (status, message) => Object.assign(new Error(message), { status });

// ── Reading ────────────────────────────────────────────────────────────────

// First and last email actually sent, so the list can say when a campaign
// really started and finished.
const WITH_SEND_TIMES = `
  SELECT c.*, t.first_sent_at, t.last_sent_at
    FROM campaigns c
    LEFT JOIN LATERAL (
      SELECT MIN(r.sent_at) AS first_sent_at, MAX(r.sent_at) AS last_sent_at
        FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.sent_at IS NOT NULL
    ) t ON true`;

function serialize(row) {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    status: row.status,
    templateId: row.template_id,
    storeGroup: row.store_group,
    subject: row.subject_template,
    batchSize: row.batch_size,
    intervalMinutes: row.interval_minutes,
    timezone: row.timezone,
    startAt: row.start_at,
    nextFireAt: row.next_fire_at,
    endAt: row.end_at,
    sendLimit: row.send_limit,
    windowStart: row.window_start || null,
    windowEnd: row.window_end || null,
    nextFireAtLocal: S.toLocalInput(row.next_fire_at, row.timezone),
    endAtLocal: S.toLocalInput(row.end_at, row.timezone),
    totalRecipients: row.total_recipients,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    lastError: row.last_error || null,
    sending: !!(row.locked_until && new Date(row.locked_until) > new Date()),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    firstSentAt: row.first_sent_at || null,
    lastSentAt: row.last_sent_at || null,
  };
}

async function getRow(id, client = pool) {
  const { rows } = await client.query(`${WITH_SEND_TIMES} WHERE c.id = $1`, [id]);
  return rows[0] || null;
}

async function listCampaigns({ storeGroup } = {}) {
  const { rows } = storeGroup
    ? await pool.query(`${WITH_SEND_TIMES} WHERE c.store_group = $1 ORDER BY c.created_at DESC LIMIT 200`, [storeGroup])
    : await pool.query(`${WITH_SEND_TIMES} ORDER BY c.created_at DESC LIMIT 200`);
  return rows.map(serialize);
}

async function getCampaignDetail(id) {
  const row = await getRow(id);
  if (!row) return null;
  const { rows: statusRows } = await pool.query(
    'SELECT status, COUNT(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1 GROUP BY status', [id]);
  const statusBreakdown = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of statusRows) statusBreakdown[r.status] = r.n;
  const { rows: skipReasons } = await pool.query(
    `SELECT error AS reason, COUNT(*)::int AS n FROM campaign_recipients
      WHERE campaign_id = $1 AND status = 'skipped' GROUP BY error ORDER BY n DESC`, [id]);
  const { rows: failures } = await pool.query(
    `SELECT email, store_name, error, attempted_at FROM campaign_recipients
      WHERE campaign_id = $1 AND status = 'failed' ORDER BY attempted_at DESC NULLS LAST LIMIT 100`, [id]);
  return { ...serialize(row), html: row.html_template, text: row.text_template, statusBreakdown, skipReasons, failures };
}

// ── Next send ──────────────────────────────────────────────────────────────

async function sentTodayCount(c) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1 AND status = 'sent' AND sent_at >= $2`,
    [c.id, S.startOfTodayUtc(c.timezone)]);
  return rows[0]?.n ?? 0;
}

// When this campaign may send its next batch: not before `earliest`
// (default: the last send plus the interval), not before tomorrow once
// today's limit is used up, and inside the daily sending hours.
async function computeNextFire(c, earliest) {
  let at = earliest ? new Date(earliest) : null;
  if (!at) {
    const { rows } = await pool.query('SELECT MAX(sent_at) AS last FROM campaign_recipients WHERE campaign_id = $1', [c.id]);
    at = rows[0]?.last ? new Date(new Date(rows[0].last).getTime() + c.interval_minutes * 60000) : new Date();
  }
  if (at.getTime() < Date.now()) at = new Date();
  if (c.send_limit != null && (await sentTodayCount(c)) >= Number(c.send_limit)) {
    const tomorrow = S.startOfTomorrowUtc(c.timezone);
    if (tomorrow > at) at = tomorrow;
  }
  return S.nextAllowedFire(c, at);
}

// Saves the next send, or finishes the campaign when it would land after the end time.
async function applyNextFire(c, nextFireAt) {
  if (c.end_at && nextFireAt.getTime() >= new Date(c.end_at).getTime()) {
    await pool.query(`UPDATE campaigns SET status = 'completed', next_fire_at = NULL, updated_at = NOW() WHERE id = $1`, [c.id]);
    return;
  }
  await pool.query('UPDATE campaigns SET next_fire_at = $2, updated_at = NOW() WHERE id = $1', [c.id, nextFireAt]);
}

// ── Creating ───────────────────────────────────────────────────────────────

function parseLimit(value, label) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) throw httpError(400, `${label} must be 1 or more, or empty for no limit`);
  return Math.floor(n);
}

/**
 * body: { name, mode: 'now'|'scheduled', customerIds, subject, html, text,
 *         templateId, storeGroup, batchSize, intervalMinutes, startAt,
 *         endAt, timezone, sendLimit, windowStart, windowEnd }
 * customerIds are in send order. "Send now" with a limit sends only the
 * first N of them.
 */
async function createCampaign(body, user) {
  const mode = body.mode === 'now' ? 'now' : 'scheduled';
  const subject = String(body.subject || '').trim();
  const html = String(body.html || '');
  if (!subject || !html.trim()) throw httpError(400, 'A subject and HTML are required');
  let ids = Array.isArray(body.customerIds) ? [...new Set(body.customerIds.map(Number).filter(Number.isInteger))] : [];
  if (!ids.length) throw httpError(400, 'Pick at least one recipient');

  const timezone = body.timezone || 'UTC';
  if (!S.isValidTimezone(timezone)) throw httpError(400, 'Unknown timezone');
  const sendLimit = parseLimit(body.sendLimit, 'The daily send limit');

  let batchSize, intervalMinutes, startAt, endAt = null, window = { start: null, end: null }, limit = null;
  if (mode === 'now') {
    if (sendLimit) ids = ids.slice(0, sendLimit);
    batchSize = ids.length;
    intervalMinutes = 1;
    startAt = new Date();
  } else {
    batchSize = Number(body.batchSize);
    if (!Number.isFinite(batchSize) || batchSize < 1) throw httpError(400, 'Batch size must be 1 or more');
    batchSize = Math.floor(batchSize);
    intervalMinutes = Number(body.intervalMinutes);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) throw httpError(400, 'The interval must be at least 1 minute');
    intervalMinutes = Math.round(intervalMinutes);
    try { startAt = S.localToUtc(body.startAt, timezone); } catch (err) { throw httpError(400, `Start time: ${err.message}`); }
    if (startAt.getTime() < Date.now()) startAt = new Date();
    try { window = S.parseWindow(body.windowStart, body.windowEnd); } catch (err) { throw httpError(400, err.message); }
    if (body.endAt) {
      try { endAt = S.localToUtc(body.endAt, timezone); } catch (err) { throw httpError(400, `End time: ${err.message}`); }
    }
    limit = sendLimit;
  }
  const nextFireAt = S.nextAllowedFire({ window_start: window.start, window_end: window.end, timezone }, startAt);
  if (endAt && endAt.getTime() <= nextFireAt.getTime()) throw httpError(400, 'The end time must be after the first send');

  const name = String(body.name || '').trim().slice(0, 200) || `Campaign ${new Date().toISOString().slice(0, 10)}`;

  const id = await transaction(async (client) => {
    const { rows: [c] } = await client.query(`
      INSERT INTO campaigns (name, mode, status, template_id, store_group, subject_template, html_template, text_template,
                             batch_size, interval_minutes, timezone, start_at, next_fire_at, end_at, send_limit,
                             window_start, window_end, created_by)
      VALUES ($1, $2, 'scheduled', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING id`,
    [name, mode, body.templateId || null, body.storeGroup || null, subject, html, body.text || null,
      batchSize, intervalMinutes, timezone, startAt, nextFireAt, endAt, limit, window.start, window.end, user?.email || null]);

    // Built straight from the customer list, in the order given. A customer
    // whose store moved is sent for the new domain (links, UTM tags) under
    // the original store's sender details, with the moved banner.
    const { rowCount } = await client.query(`
      INSERT INTO campaign_recipients (campaign_id, customer_id, email, name, store_id, store_name, store_domain, store_url)
      SELECT $1, cu.id, cu.email, cu.name, cu.store_id, COALESCE(s.brand_name, cu.store_domain),
             COALESCE(NULLIF(cu.moved_to_domain, ''), cu.store_domain),
             CASE WHEN COALESCE(NULLIF(cu.moved_to_domain, ''), cu.store_domain) = '' THEN ''
                  ELSE 'https://' || COALESCE(NULLIF(cu.moved_to_domain, ''), cu.store_domain) END
        FROM UNNEST($2::int[]) WITH ORDINALITY AS x(id, ord)
        JOIN customers cu ON cu.id = x.id
        LEFT JOIN stores s ON s.id = cu.store_id
       WHERE cu.status IS NULL AND cu.email_check = 'ok' AND cu.store_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM unsubscribes u WHERE LOWER(u.email) = cu.email)
         AND NOT EXISTS (SELECT 1 FROM blocklist b WHERE LOWER(b.email) = cu.email)
       ORDER BY x.ord`, [c.id, ids]);
    if (!rowCount) throw httpError(400, 'None of the picked customers can be emailed (archived or removed)');

    const { rows: moved } = await client.query(`
      SELECT r.id, r.store_domain, s.brand_color FROM campaign_recipients r
        JOIN customers cu ON cu.id = r.customer_id LEFT JOIN stores s ON s.id = r.store_id
       WHERE r.campaign_id = $1 AND NULLIF(cu.moved_to_domain, '') IS NOT NULL AND cu.moved_to_domain <> cu.store_domain`, [c.id]);
    for (const m of moved) {
      const b = movedBanner(m.store_domain, m.brand_color || config.defaultBrandColor);
      await client.query('UPDATE campaign_recipients SET moved_banner = $2, moved_banner_text = $3 WHERE id = $1', [m.id, b.html, b.text]);
    }
    await client.query('UPDATE campaigns SET total_recipients = $2, batch_size = GREATEST(1, CASE WHEN mode = $3 THEN $2 ELSE batch_size END) WHERE id = $1',
      [c.id, rowCount, 'now']);
    return c.id;
  });

  console.log(`[campaigns] #${id} "${name}" (${mode}) created by ${user?.email}`);
  return serialize(await getRow(id));
}

// ── Editing and status ─────────────────────────────────────────────────────

// Changes a campaign's schedule while it runs. Only the fields sent change;
// the next send is then re-planned from the saved settings.
async function updateCampaign(id, body, user) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const saved = await transaction(async (client) => {
    const { rows: [c] } = await client.query('SELECT * FROM campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (!c) throw httpError(404, 'Campaign not found');
    if (c.status === 'cancelled') throw httpError(409, 'A stopped campaign can no longer be edited');
    const next = { ...c };

    if (has('name')) {
      next.name = String(body.name || '').trim().slice(0, 200);
      if (!next.name) throw httpError(400, 'The campaign name cannot be empty');
    }
    if (has('timezone')) {
      if (!S.isValidTimezone(body.timezone)) throw httpError(400, 'Unknown timezone');
      next.timezone = body.timezone;
    }
    if (has('batchSize')) {
      const b = Number(body.batchSize);
      if (!Number.isFinite(b) || b < 1) throw httpError(400, 'Batch size must be 1 or more');
      next.batch_size = Math.floor(b);
    }
    if (has('intervalMinutes')) {
      const m = Number(body.intervalMinutes);
      if (!Number.isFinite(m) || m < 1) throw httpError(400, 'The interval must be at least 1 minute');
      next.interval_minutes = Math.round(m);
    }
    if (has('sendLimit')) next.send_limit = parseLimit(body.sendLimit, 'The daily send limit');
    if (has('windowStart') || has('windowEnd')) {
      try {
        const w = S.parseWindow(has('windowStart') ? body.windowStart : c.window_start, has('windowEnd') ? body.windowEnd : c.window_end);
        next.window_start = w.start; next.window_end = w.end;
      } catch (err) { throw httpError(400, err.message); }
    }
    if (has('endAt')) {
      if (!body.endAt) next.end_at = null;
      else {
        try { next.end_at = S.localToUtc(body.endAt, next.timezone); } catch (err) { throw httpError(400, `End time: ${err.message}`); }
        if (next.end_at.getTime() <= Date.now()) throw httpError(400, 'The end time must be in the future');
      }
    }
    let startAt = null;
    if (has('startAt') && body.startAt) {
      try { startAt = S.localToUtc(body.startAt, next.timezone); } catch (err) { throw httpError(400, `Start time: ${err.message}`); }
      if (next.end_at && startAt.getTime() >= new Date(next.end_at).getTime()) throw httpError(400, 'The end time must be after the start time');
    }

    // A campaign that finished because its end time passed picks up again
    // when the end moves later or is removed, as long as recipients remain.
    if (c.status === 'completed') {
      const { rows: [{ n }] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`, [id]);
      if (n > 0 && (!next.end_at || new Date(next.end_at) > new Date())) next.status = 'scheduled';
    }

    const { rows: [row] } = await client.query(`
      UPDATE campaigns SET name = $2, timezone = $3, batch_size = $4, interval_minutes = $5, send_limit = $6,
             window_start = $7, window_end = $8, end_at = $9, status = $10, start_at = COALESCE($11, start_at),
             settings_changed_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
    [id, next.name, next.timezone, next.batch_size, next.interval_minutes, next.send_limit,
      next.window_start, next.window_end, next.end_at, next.status, startAt]);
    return { row, startAt };
  });

  const c = saved.row;
  // Paused campaigns keep the new settings and pick them up on resume.
  if (c.status === 'scheduled' || c.status === 'running') {
    let earliest = saved.startAt;
    if (!earliest && c.sent_count + c.failed_count + c.skipped_count === 0 && c.start_at) earliest = new Date(c.start_at);
    await applyNextFire(c, await computeNextFire(c, earliest));
  }
  console.log(`[campaigns] #${id} edited by ${user?.email}`);
  return serialize(await getRow(id));
}

const TRANSITIONS = {
  pause:  { from: ['scheduled', 'running'], to: 'paused' },
  resume: { from: ['paused'], to: 'scheduled' },
  cancel: { from: ['scheduled', 'running', 'paused'], to: 'cancelled' },
};

async function changeStatus(id, action) {
  const t = TRANSITIONS[action];
  const { rows: [c] } = await pool.query(
    `UPDATE campaigns SET status = $2, updated_at = NOW(),
            next_fire_at = CASE WHEN $2 = 'cancelled' THEN NULL ELSE next_fire_at END
      WHERE id = $1 AND status = ANY($3) RETURNING *`, [id, t.to, t.from]);
  if (!c) throw httpError(409, `This campaign can't be ${action === 'cancel' ? 'stopped' : `${action}d`} right now`);
  // Resume as soon as the interval, today's limit and the sending hours allow.
  if (action === 'resume') await applyNextFire(c, await computeNextFire(c));
  return serialize(await getRow(id));
}

// Only a finished or stopped campaign can be deleted.
async function deleteCampaign(id) {
  const { rowCount } = await pool.query(`DELETE FROM campaigns WHERE id = $1 AND status IN ('completed', 'cancelled')`, [id]);
  if (rowCount) return;
  const { rows } = await pool.query('SELECT status FROM campaigns WHERE id = $1', [id]);
  if (!rows[0]) throw httpError(404, 'Campaign not found');
  throw httpError(409, `Stop the campaign first (it is ${rows[0].status})`);
}

// ── Sending (called by the worker) ─────────────────────────────────────────

// Takes the next due campaign and locks it for this worker. SKIP LOCKED
// lets several server instances share the work without double sends.
async function claimDueCampaign() {
  const { rows } = await pool.query(`
    UPDATE campaigns SET locked_until = NOW() + INTERVAL '${LOCK_MINUTES} minutes'
     WHERE id = (
       SELECT id FROM campaigns
        WHERE status IN ('scheduled', 'running') AND next_fire_at <= NOW()
          AND (locked_until IS NULL OR locked_until < NOW())
        ORDER BY next_fire_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
    RETURNING *`);
  return rows[0] || null;
}

async function recount(id) {
  await pool.query(`
    UPDATE campaigns c SET
      sent_count = x.sent, failed_count = x.failed, skipped_count = x.skipped, updated_at = NOW()
      FROM (SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
                   COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
                   COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped
              FROM campaign_recipients WHERE campaign_id = $1) x
     WHERE c.id = $1`, [id]);
}

const finish = (id) =>
  pool.query(`UPDATE campaigns SET status = 'completed', next_fire_at = NULL, updated_at = NOW() WHERE id = $1`, [id]);
const release = (id) => pool.query('UPDATE campaigns SET locked_until = NULL WHERE id = $1', [id]);

async function pendingCount(id) {
  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`, [id]);
  return n;
}

// Who to send to and as which store, decided at send time: a customer who
// moved to another store since the campaign was made gets that store's
// email. Customers deleted since then keep the details saved with the campaign.
function currentRecipient(r) {
  const saved = {
    email: r.email, name: r.name, storeId: r.store_id, storeName: r.store_name, storeDomain: r.store_domain,
    storeUrl: r.store_url, movedBanner: r.moved_banner, movedBannerText: r.moved_banner_text,
  };
  if (!r.cu_id || !r.cu_store_id || r.cu_store_id === r.store_id) return saved;
  const domain = r.cu_moved && r.cu_moved !== r.cu_store_domain ? r.cu_moved : r.cu_store_domain;
  const banner = domain !== r.cu_store_domain ? movedBanner(domain, r.cu_color || config.defaultBrandColor) : { html: '', text: '' };
  return {
    email: r.email, name: r.cu_name ?? r.name, storeId: r.cu_store_id, storeName: r.cu_store_name, storeDomain: domain,
    storeUrl: `https://${domain}`, movedBanner: banner.html, movedBannerText: banner.text,
  };
}

// Sends the next batch of one claimed campaign.
async function fireCampaign(campaign) {
  const c = campaign;
  // A send cut off by a crash or restart: it may or may not have gone out,
  // so it is marked failed rather than sent again.
  await pool.query(
    `UPDATE campaign_recipients SET status = 'failed', error = 'Interrupted while sending (server restart). Not retried, to avoid sending twice.'
      WHERE campaign_id = $1 AND status = 'sending'`, [c.id]);

  if (c.end_at && Date.now() >= new Date(c.end_at).getTime()) return finish(c.id);
  if (!S.inWindow(c, new Date())) return applyNextFire(c, await computeNextFire(c, new Date()));

  if (c.status === 'scheduled') await pool.query(`UPDATE campaigns SET status = 'running', updated_at = NOW() WHERE id = $1`, [c.id]);
  const batchStartedAt = new Date();

  let batchLimit = c.batch_size;
  if (c.send_limit != null) batchLimit = Math.min(batchLimit, Math.max(0, Number(c.send_limit) - (await sentTodayCount(c))));
  const { rows: batch } = batchLimit > 0
    ? await pool.query(
        `SELECT r.*, cu.id AS cu_id, cu.status AS cu_status, cu.store_id AS cu_store_id, cu.store_domain AS cu_store_domain,
                cu.moved_to_domain AS cu_moved, cu.name AS cu_name, s.brand_name AS cu_store_name, s.brand_color AS cu_color
           FROM campaign_recipients r
           LEFT JOIN customers cu ON cu.id = r.customer_id
           LEFT JOIN stores s ON s.id = cu.store_id
          WHERE r.campaign_id = $1 AND r.status = 'pending' ORDER BY r.id LIMIT $2`, [c.id, batchLimit])
    : { rows: [] };

  if (!batch.length) {
    if ((await pendingCount(c.id)) === 0) return finish(c.id);
    // Recipients remain but today's limit is used up: wait for tomorrow.
    return applyNextFire(c, await computeNextFire(c, new Date(Date.now() + c.interval_minutes * 60000)));
  }

  let reasonFor;
  try {
    reasonFor = await loadOptOuts(batch.map((r) => r.email));
  } catch (err) {
    // Couldn't confirm who opted out (e.g. Chat Support Pro unreachable):
    // send nothing and try again in five minutes.
    console.error(`[campaigns] #${c.id} opt-out check failed:`, err.message);
    await pool.query(`UPDATE campaigns SET last_error = $2, next_fire_at = NOW() + INTERVAL '5 minutes' WHERE id = $1`,
      [c.id, `Couldn't check opt-outs, retrying in 5 minutes: ${err.message}`]);
    return;
  }
  if (c.last_error) await pool.query('UPDATE campaigns SET last_error = NULL WHERE id = $1', [c.id]);

  const content = { subject: c.subject_template, html: c.html_template, text: c.text_template, campaignName: c.name };
  const storeCache = new Map();
  let stopped = false;

  for (let i = 0; i < batch.length; i++) {
    const r = batch[i];
    // Every 10 sends: keep the lock and notice a pause or stop straight away.
    if (i > 0 && i % 10 === 0) {
      const { rows: [s] } = await pool.query(
        `UPDATE campaigns SET locked_until = NOW() + INTERVAL '${LOCK_MINUTES} minutes' WHERE id = $1 RETURNING status`, [c.id]);
      if (!s || s.status !== 'running') { stopped = true; break; }
    }

    const reason = r.cu_status === 'archived' ? 'archived' : reasonFor(r.email);
    if (reason) {
      await pool.query(`UPDATE campaign_recipients SET status = 'skipped', error = $2, attempted_at = NOW() WHERE id = $1`, [r.id, reason]);
      continue;
    }

    const to = currentRecipient(r);
    await pool.query(`UPDATE campaign_recipients SET status = 'sending', attempted_at = NOW() WHERE id = $1`, [r.id]);
    const result = await sendToRecipient(to, content, { storeCache, idempotencyKey: `cc-${c.id}-${r.id}`, label: c.name });

    if (result.ok) {
      // Records the store it actually went out as.
      await pool.query(
        `UPDATE campaign_recipients SET status = 'sent', sent_at = NOW(), error = NULL,
                store_id = $2, store_name = $3, store_domain = $4, store_url = $5 WHERE id = $1`,
        [r.id, to.storeId, to.storeName, to.storeDomain, to.storeUrl]);
      await pool.query(`
        INSERT INTO sent_emails (email, store_domain, store_name, campaign_id) VALUES ($1, $2, $3, $4)
        ON CONFLICT (LOWER(email), store_domain) DO UPDATE SET sent_at = NOW(), campaign_id = EXCLUDED.campaign_id,
          store_name = EXCLUDED.store_name`, [r.email, to.storeDomain || '', to.storeName, c.id]);
    } else {
      await pool.query(`UPDATE campaign_recipients SET status = 'failed', error = $2 WHERE id = $1`, [r.id, result.error]);
    }
    await sleep(config.dryRun ? 0 : config.sendDelayMs);
  }

  await recount(c.id);
  if (stopped) return;
  if ((await pendingCount(c.id)) === 0) return finish(c.id);

  // Settings are re-read: an edit made while this batch was sending applies
  // from the next one, and an edit that already re-planned it wins.
  const { rows: [fresh] } = await pool.query('SELECT * FROM campaigns WHERE id = $1', [c.id]);
  if (!fresh || fresh.status !== 'running') return;
  if (fresh.settings_changed_at && new Date(fresh.settings_changed_at) > batchStartedAt) return;
  await applyNextFire(fresh, await computeNextFire(fresh, new Date(Date.now() + fresh.interval_minutes * 60000)));
}

async function runDueCampaigns() {
  let ran = 0;
  for (let c = await claimDueCampaign(); c; c = await claimDueCampaign()) {
    try {
      await fireCampaign(c);
    } catch (err) {
      console.error(`[campaigns] #${c.id} batch failed:`, err);
      await pool.query(`UPDATE campaigns SET last_error = $2, next_fire_at = NOW() + INTERVAL '2 minutes' WHERE id = $1`,
        [c.id, err.message]).catch(() => {});
    } finally {
      await release(c.id).catch(() => {});
    }
    ran++;
  }
  return ran;
}

module.exports = {
  ACTIVE,
  listCampaigns, getCampaignDetail, createCampaign, updateCampaign, changeStatus, deleteCampaign,
  runDueCampaigns, computeNextFire,
};
