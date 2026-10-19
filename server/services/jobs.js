// server/services/jobs.js
// Background jobs besides sending campaigns:
//   * Chat Support Pro sync every CHAT_SUPPORT_SYNC_MINUTES (when linked)
//   * re-checking "unverified" emails every hour
// A Postgres lock lets only one server instance run a job at a time.

const config = require('../config');
const { pool } = require('../db');
const chatSupport = require('./chatSupportBridge');
const { recheckUnverified } = require('./mailDomains');

const LOCKS = { chatSupport: 772010, recheck: 772011 };
const timers = [];

// Runs fn only if no other instance holds the lock; returns null if skipped.
async function withLock(key, fn) {
  const client = await pool.connect();
  try {
    const { rows: [{ ok }] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (!ok) return null;
    try { return await fn(); } finally { await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {}); }
  } finally {
    client.release();
  }
}

const syncChatSupport = (opts) => withLock(LOCKS.chatSupport, () => chatSupport.syncFromChatSupport(opts));

function every(minutes, name, fn) {
  const run = () => fn().catch((err) => console.error(`[jobs] ${name} failed:`, err.message));
  timers.push(setInterval(run, minutes * 60000));
  timers[timers.length - 1].unref?.();
  setTimeout(run, 20000).unref?.();
}

function start() {
  if (chatSupport.isConfigured() && config.chatSupportSyncMinutes > 0) {
    every(config.chatSupportSyncMinutes, 'Chat Support Pro sync', async () => {
      const r = await syncChatSupport();
      if (r && (r.customers.saved || r.optOuts.unsubscribes)) {
        console.log(`[jobs] Chat Support Pro: ${r.customers.saved} customers saved (${r.customers.added} new, ${r.customers.storeChanged} moved store), ${r.optOuts.unsubscribes} unsubscribes`);
      }
    });
    console.log(`[jobs] Chat Support Pro sync every ${config.chatSupportSyncMinutes} min`);
  }
  every(60, 'unverified email recheck', () => withLock(LOCKS.recheck, recheckUnverified));
}

function stop() { timers.splice(0).forEach(clearInterval); }

module.exports = { start, stop, syncChatSupport };
