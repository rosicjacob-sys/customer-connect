// server/services/worker.js
// Checks for due campaigns every WORKER_POLL_MS and sends them. kick()
// starts a check right away, e.g. just after "Send now".

const config = require('../config');
const { runDueCampaigns } = require('./campaigns');

let timer = null;
let running = false;
let again = false;

async function tick() {
  if (running) { again = true; return; }
  running = true;
  try {
    do {
      again = false;
      await runDueCampaigns();
    } while (again);
  } catch (err) {
    console.error('[worker] check failed:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, config.workerPollMs);
  timer.unref?.();
  tick();
  console.log(`[worker] sending campaigns (checks every ${Math.round(config.workerPollMs / 1000)}s)`);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

// Does nothing when the worker isn't running (DISABLE_WORKER=true, or tests).
const kick = () => { if (timer) setImmediate(tick); };

module.exports = { start, stop, kick, tick, isBusy: () => running };
