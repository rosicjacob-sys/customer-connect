// Merge fields, colour helpers, template maps and UTM tagging.

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../server/lib/merge');

test('applyMerge fills known tokens and leaves unknown ones', () => {
  assert.equal(m.applyMerge('Hi {{ customer_name }}, {{nope}}', { customer_name: 'Ana' }), 'Hi Ana, {{nope}}');
});

test('hasUsableName rejects blanks, "Guest" and emails', () => {
  assert.equal(m.hasUsableName('Ana'), true);
  assert.equal(m.hasUsableName(' guest '), false);
  assert.equal(m.hasUsableName('ana@x.com'), false);
  assert.equal(m.hasUsableName(''), false);
});

test('brand colour helpers', () => {
  assert.equal(m.brandTextColor('#0924AF'), '#FFFFFF');
  assert.equal(m.brandTextColor('#F5D76E'), '#1A1A1A');
  assert.equal(m.brandRgb('#D23025'), '210, 48, 37');
  assert.match(m.brandTint('#0924AF'), /^#[0-9A-F]{6}$/);
});

test('template maps resolve by hex and fall back to default, and are stripped', () => {
  const html = `<!--@map product_image_url from store_brand_color
  Red  #D23025 = https://cdn/red.png
  default      = https://cdn/blue.png
  --><img src="{{product_image_url}}">`;
  assert.equal(m.applyTemplateMaps(html, { store_brand_color: '#d23025' }).product_image_url, 'https://cdn/red.png');
  assert.equal(m.applyTemplateMaps(html, { store_brand_color: '#000000' }).product_image_url, 'https://cdn/blue.png');
  assert.equal(m.stripTemplateMaps(html), '<img src="{{product_image_url}}">');
});

test('UTM tags only the store links, named after their text or image alt', () => {
  const html = [
    '<a href="https://www.shop.com/a">Shop Now</a>',
    '<a href="https://shop.com/b">Shop now</a>',
    '<a href="https://shop.com/c"><img src="x.gif" alt="Big Sale"></a>',
    '<a href="https://instagram.com/shop">IG</a>',
    '<a href="mailto:hi@shop.com">Mail</a>',
  ].join('');
  const out = m.appendUtmToStoreLinks(html, { storeDomain: 'shop.com', campaignName: 'October Thank-you!' });
  assert.match(out, /a\?utm_source=shop\.com&utm_medium=promo_email&utm_campaign=october-thank-you&utm_content=shop-now"/);
  assert.match(out, /b\?[^"]*utm_content=shop-now-2"/);
  assert.match(out, /c\?[^"]*utm_content=big-sale"/);
  assert.match(out, /href="https:\/\/instagram\.com\/shop"/);
  assert.match(out, /href="mailto:hi@shop\.com"/);
});

test('moved banner uses plain colours (no CSS variables) and escapes the domain', () => {
  const b = m.movedBanner('new.shop.com', '#123456');
  assert.doesNotMatch(b.html, /var\(--/);
  assert.match(b.html, /https:\/\/new\.shop\.com/);
  assert.equal(m.movedBanner('').html, '');
});
