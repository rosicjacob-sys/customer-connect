// The cleaning rules every customer row goes through before it is saved.

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../server/lib/clean');

const email = (e) => C.cleanEmail(e);

test('emails are trimmed and lowercased', () => {
  assert.equal(email('  John.Doe@Gmail.COM ').email, 'john.doe@gmail.com');
  assert.equal(email('mailto:<ana@shop.ca>').email, 'ana@shop.ca');
});

test('misspelled big providers are corrected', () => {
  for (const typo of ['gmail.con', 'gmial.com', 'gamil.com', 'gmal.com', 'gmaill.com', 'gnail.com', 'gmail.ca', 'gmail.cm', 'gmail.co']) {
    assert.equal(email(`ana@${typo}`).email, 'ana@gmail.com', typo);
  }
  assert.equal(email('ana@hotmial.com').email, 'ana@hotmail.com');
  assert.equal(email('ana@outlok.com').email, 'ana@outlook.com');
  assert.equal(email('ana@yahooo.com').email, 'ana@yahoo.com');
  assert.equal(email('ana@icloud.co').email, 'ana@icloud.com');
  assert.equal(email('ana@gmail.con').fixed, 'gmail.con → gmail.com');
});

test('real providers that look like typos are left alone', () => {
  for (const real of ['mail.com', 'email.com', 'ymail.com', 'gmx.com', 'live.com', 'me.com', 'yahoo.ca', 'hotmail.ca', 'proton.me', 'protonmail.com']) {
    assert.equal(email(`ana@${real}`).email, `ana@${real}`, real);
    assert.equal(email(`ana@${real}`).fixed, null, real);
  }
});

test('company and other real domains are kept as they are', () => {
  assert.equal(email('j.smith@acmecorp.com').email, 'j.smith@acmecorp.com');
  assert.equal(email('j@lab.utoronto.ca').email, 'j@lab.utoronto.ca');
  assert.equal(email('jo+orders@gmail.com').email, 'jo+orders@gmail.com', 'plus addresses are a separate person, kept as written');
});

test('"test" is dropped only as a word, so real names survive', () => {
  for (const e of ['test@gmail.com', 'test123@gmail.com', 'john.test@gmail.com', 'test.john@gmail.com', 'ana@test.com', 'x@mailinator.com']) {
    assert.ok(email(e).drop, e);
  }
  for (const e of ['latest.deals@gmail.com', 'contestwinner@gmail.com', 'anna.testa@gmail.com', 'greatestmom@gmail.com', 'celeste@gmail.com']) {
    assert.ok(!email(e).drop, e);
  }
});

test('random text and broken addresses are not saved', () => {
  for (const e of ['', 'nope', 'a@b', 'a@@gmail.com', 'two words@gmail.com', 'ana@gmail', 'ana@-bad-.com', 'ana@123.456', 'ana@domain.c']) {
    assert.ok(email(e).drop, JSON.stringify(e));
  }
});

test('store address becomes a bare domain; checkout and myshopify are refused', () => {
  assert.equal(C.cleanStoreUrl('https://www.OttawaPeptides.com/collections/all?x=1').domain, 'ottawapeptides.com');
  assert.equal(C.cleanStoreUrl('ottawapeptides.com').domain, 'ottawapeptides.com');
  assert.ok(C.cleanStoreUrl('https://pepscheckoutportal.com/checkout').drop);
  assert.ok(C.cleanStoreUrl('my-store-123.myshopify.com').drop);
  assert.ok(C.cleanStoreUrl('').drop);
  assert.ok(C.cleanStoreUrl('not a domain').drop);
  const moved = C.cleanStoreUrl('etobicokepeptides.ca');
  assert.deepEqual(moved, { domain: 'torontopeptides.shop', moved: true });
});

test('names: placeholders and emails are not names', () => {
  assert.equal(C.cleanName('  Jane   Doe '), 'Jane Doe');
  for (const n of ['Guest', 'guest', '', 'jane@gmail.com', 'N/A', '--']) assert.equal(C.cleanName(n), null, n);
});

test('phones are written one way; unusable ones are blanked', () => {
  assert.equal(C.cleanPhone('(613) 555-0101'), '+16135550101');
  assert.equal(C.cleanPhone('1-613-555-0101'), '+16135550101');
  assert.equal(C.cleanPhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(C.cleanPhone('555-0101'), null);
  assert.equal(C.cleanPhone(''), null);
});

test('dates: day, date-time and ISO; nonsense and the future are undated', () => {
  assert.equal(C.cleanDate('2026-10-02').toISOString(), '2026-10-02T12:00:00.000Z', 'a bare day is noon UTC: the same day across the Americas');
  assert.equal(C.cleanDate('2026-10-02 14:03:00').toISOString(), '2026-10-02T14:03:00.000Z');
  assert.equal(C.cleanDate('2026-10-02T14:03:00-04:00').toISOString(), '2026-10-02T18:03:00.000Z');
  assert.equal(C.cleanDate('Oct 2'), null);
  assert.equal(C.cleanDate('2099-01-01'), null);
  assert.equal(C.cleanDate(''), null);
});

test('cleanRow drops on the first problem and notes what it fixed', () => {
  assert.deepEqual(C.cleanRow({ email: 'test@gmail.com', storeUrl: 'shop.com' }), { drop: 'test or placeholder email' });
  assert.deepEqual(C.cleanRow({ email: 'ana@gmail.com', storeUrl: 'x.myshopify.com' }).drop !== undefined, true);
  const r = C.cleanRow({ email: 'Ana@Gmail.con', name: 'Guest', phone: '613 555 0101', storeUrl: 'https://ottawa.com', seenAt: '2026-10-02' });
  assert.equal(r.email, 'ana@gmail.com');
  assert.equal(r.name, null);
  assert.equal(r.phone, '+16135550101');
  assert.equal(r.storeDomain, 'ottawa.com');
  assert.match(r.notes[0], /typo fixed/);
});
