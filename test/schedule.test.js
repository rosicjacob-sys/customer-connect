// Timezone, sending-hours and next-send rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server/lib/schedule');

test('localToUtc reads the wall clock in the given timezone', () => {
  assert.equal(S.localToUtc('2026-01-15T09:00', 'America/New_York').toISOString(), '2026-01-15T14:00:00.000Z');
  assert.equal(S.localToUtc('2026-07-15T09:00', 'America/New_York').toISOString(), '2026-07-15T13:00:00.000Z');
  assert.equal(S.localToUtc('2026-01-15T09:00', 'Asia/Manila').toISOString(), '2026-01-15T01:00:00.000Z');
  assert.throws(() => S.localToUtc('tomorrow', 'UTC'));
});

test('toLocalInput is the inverse of localToUtc', () => {
  const d = S.localToUtc('2026-03-02T17:45', 'America/New_York');
  assert.equal(S.toLocalInput(d, 'America/New_York'), '2026-03-02T17:45');
});

test('inWindow handles normal and overnight windows', () => {
  const day = { window_start: '08:00', window_end: '23:00', timezone: 'UTC' };
  const night = { window_start: '22:00', window_end: '06:00', timezone: 'UTC' };
  const at = (h) => new Date(`2026-05-01T${h}:00Z`);
  assert.equal(S.inWindow(day, at('07:59')), false);
  assert.equal(S.inWindow(day, at('08:00')), true);
  assert.equal(S.inWindow(day, at('23:00')), false);
  assert.equal(S.inWindow(night, at('23:30')), true);
  assert.equal(S.inWindow(night, at('05:59')), true);
  assert.equal(S.inWindow(night, at('12:00')), false);
  assert.equal(S.inWindow({ timezone: 'UTC' }, at('03:00')), true);
});

test('nextAllowedFire waits for the window to open, today or tomorrow', () => {
  const c = { window_start: '08:00', window_end: '17:00', timezone: 'America/New_York' };
  const now = new Date('2026-05-01T04:00:00Z'); // 00:00 in New York
  assert.equal(S.nextAllowedFire(c, now, now).toISOString(), '2026-05-01T12:00:00.000Z');
  const evening = new Date('2026-05-01T22:00:00Z'); // 18:00 in New York
  assert.equal(S.nextAllowedFire(c, evening, evening).toISOString(), '2026-05-02T12:00:00.000Z');
  const inside = new Date('2026-05-01T15:00:00Z');
  assert.equal(S.nextAllowedFire(c, inside, inside).toISOString(), inside.toISOString());
});

test('startOfTomorrowUtc follows the campaign timezone', () => {
  const now = new Date('2026-05-01T03:00:00Z'); // still Apr 30 in New York
  assert.equal(S.startOfTomorrowUtc('America/New_York', now).toISOString(), '2026-05-01T04:00:00.000Z');
});

test('parseWindow validation', () => {
  assert.deepEqual(S.parseWindow('', ''), { start: null, end: null });
  assert.deepEqual(S.parseWindow('08:00', '23:00'), { start: '08:00', end: '23:00' });
  assert.throws(() => S.parseWindow('08:00', ''));
  assert.throws(() => S.parseWindow('8am', '23:00'));
  assert.throws(() => S.parseWindow('08:00', '08:00'));
});
