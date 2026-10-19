// src/lib/merge.js
// Mirrors applyMerge and the <!--@map--> lookup blocks in
// server/lib/merge.js so template previews look like a real send. Keep the two in step.

const MAP_BLOCK_RE = /<!--\s*@map\s+(\w+)\s+from\s+(\w+)([\s\S]*?)-->/gi;

function lookupKey(s) {
  const hex = /#[0-9a-f]{6}\b/i.exec(s);
  return (hex ? hex[0] : String(s)).trim().toLowerCase();
}

function parseTemplateMaps(template) {
  const maps = [];
  for (const [, name, source, body] of String(template || '').matchAll(MAP_BLOCK_RE)) {
    const entries = new Map();
    let fallback = '';
    for (const line of body.split('\n')) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (!key || !value) continue;
      if (key.toLowerCase() === 'default') fallback = value;
      else entries.set(lookupKey(key), value);
    }
    maps.push({ name, source, entries, fallback });
  }
  return maps;
}

export const stripTemplateMaps = (template) => String(template || '').replace(MAP_BLOCK_RE, '');

export function applyTemplateMaps(template, fields) {
  const out = { ...fields };
  for (const { name, source, entries, fallback } of parseTemplateMaps(template)) {
    out[name] = entries.get(lookupKey(fields[source] ?? '')) ?? fallback;
  }
  return out;
}

export const applyMerge = (text, fields) =>
  String(text ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in fields ? String(fields[k] ?? '') : m));

// Same rules as slugify() on the server, so the Send step can show the utm_campaign.
export const utmSlug = (str) => String(str || '')
  .replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ')
  .toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export const SAMPLE_FIELDS = {
  customer_name: 'Jane Doe',
  customer_email: 'jane@example.com',
  store_name: 'Sample Store',
  store_url: 'https://samplestore.com',
  store_domain: 'samplestore.com',
  store_brand_color: '#0924AF',
  store_brand_color_light: '#E1E5F5',
  store_brand_text_color: '#FFFFFF',
  store_brand_rgb: '9, 36, 175',
  unsubscribe_url: '#unsubscribe',
  moved_banner: '',
  moved_banner_text: '',
};

export function renderPreview(subject, html, fields = SAMPLE_FIELDS) {
  const merged = applyTemplateMaps(html, fields);
  return { subject: applyMerge(subject, merged), html: applyMerge(stripTemplateMaps(html), merged) };
}

export const TOKENS = [
  ['{{customer_name}}', "Recipient's name (their email when there's no name on file)."],
  ['{{customer_email}}', "Recipient's email address."],
  ['{{store_name}}', "The recipient's store name."],
  ['{{store_url}}', "The store's web address (the new one, if the store moved)."],
  ['{{store_domain}}', 'The bare domain, without https://.'],
  ['{{store_brand_color}}', 'The store\'s brand colour, e.g. style="background:{{store_brand_color}}".'],
  ['{{store_brand_color_light}}', 'A pale tint of the brand colour, for backgrounds behind dark text.'],
  ['{{store_brand_text_color}}', 'White or near-black, whichever reads on top of the brand colour.'],
  ['{{store_brand_rgb}}', 'The brand colour as "r, g, b", e.g. rgba({{store_brand_rgb}}, .35).'],
  ['{{product_image_url}}', 'From a <!--@map product_image_url from store_brand_color … --> block: one line per colour (Red #D23025 = https://…/red.png) plus a default line.'],
  ['{{unsubscribe_url}}', 'One-click unsubscribe link. Promo emails to customer lists should include it.'],
  ['{{moved_banner}}', 'A "we\'ve moved" note, only for customers whose store moved domain. Empty otherwise.'],
  ['{{moved_banner_text}}', 'The same note for the plain-text part.'],
];
