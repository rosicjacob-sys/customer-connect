// server/lib/schedule.js
// Clock and calendar rules for scheduled campaigns, independent of the
// server's own timezone: wall-clock times are always read in the campaign's
// timezone. Pure functions; the database side lives in services/campaigns.js.
// Same rules as Chat Support Pro's promoScheduler.js.

const { fromZonedTime } = require('date-fns-tz');

function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// "YYYY-MM-DDTHH:mm" in `timezone` → the UTC Date.
function localToUtc(dateTimeLocalStr, timezone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(dateTimeLocalStr || ''));
  if (!m) throw new Error('Invalid time, expected YYYY-MM-DDTHH:mm');
  const [, y, mo, d, h, mi, s] = m;
  return fromZonedTime(new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))), timezone || 'UTC');
}

// "HH:mm" → minutes after midnight, or null.
function parseClock(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// The wall-clock date and minute of the day of `date` in `timezone`.
function zonedParts(date, timezone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)) parts[p.type] = p.value;
  return { y: +parts.year, mo: +parts.month, d: +parts.day, minutes: (+parts.hour % 24) * 60 + +parts.minute };
}

// A wall-clock day + minute in `timezone` as a UTC Date (day overflow rolls over).
function zonedClockToUtc(y, mo, d, minutes, timezone) {
  return fromZonedTime(new Date(Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60)), timezone || 'UTC');
}

// "YYYY-MM-DDTHH:mm" in `timezone`, the format datetime-local inputs use.
function toLocalInput(date, timezone) {
  if (!date) return null;
  const z = zonedParts(new Date(date), timezone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${z.y}-${pad(z.mo)}-${pad(z.d)}T${pad(Math.floor(z.minutes / 60))}:${pad(z.minutes % 60)}`;
}

function startOfTodayUtc(timezone, now = new Date()) {
  const z = zonedParts(now, timezone);
  return zonedClockToUtc(z.y, z.mo, z.d, 0, timezone);
}

function startOfTomorrowUtc(timezone, now = new Date()) {
  const z = zonedParts(now, timezone);
  return zonedClockToUtc(z.y, z.mo, z.d + 1, 0, timezone);
}

function hasWindow(c) {
  const start = parseClock(c.window_start), end = parseClock(c.window_end);
  return start != null && end != null && start !== end;
}

// Inside the daily sending hours. An end earlier than the start wraps past midnight.
function inWindow(c, date) {
  if (!hasWindow(c)) return true;
  const start = parseClock(c.window_start), end = parseClock(c.window_end);
  const t = zonedParts(date, c.timezone).minutes;
  return start < end ? (t >= start && t < end) : (t >= start || t < end);
}

// The first moment at or after `earliest` (and not before now) inside the window.
function nextAllowedFire(c, earliest, now = new Date()) {
  const at = new Date(Math.max(new Date(earliest).getTime(), now.getTime()));
  if (inWindow(c, at)) return at;
  const start = parseClock(c.window_start), z = zonedParts(at, c.timezone);
  let open = zonedClockToUtc(z.y, z.mo, z.d, start, c.timezone);
  if (open.getTime() <= at.getTime()) open = zonedClockToUtc(z.y, z.mo, z.d + 1, start, c.timezone);
  return open;
}

// Daily sending hours: both "HH:mm" or both empty (send any time).
function parseWindow(start, end) {
  const blank = (v) => v == null || String(v).trim() === '';
  if (blank(start) && blank(end)) return { start: null, end: null };
  if (blank(start) || blank(end)) throw new Error('Set both a "from" and a "to" time for the sending hours, or neither');
  const s = String(start).trim(), e = String(end).trim();
  if (parseClock(s) == null || parseClock(e) == null) throw new Error('Sending hours must be times like 08:00 and 23:00');
  if (s === e) throw new Error('Sending hours need different "from" and "to" times');
  return { start: s, end: e };
}

module.exports = {
  isValidTimezone, localToUtc, parseClock, zonedParts, toLocalInput,
  startOfTodayUtc, startOfTomorrowUtc, hasWindow, inWindow, nextAllowedFire, parseWindow,
};
