// server/lib/merge.js
// Pure helpers for building one email: {{token}} merge, brand colour
// variants, <!--@map--> lookup blocks and UTM tagging of store links.
// Ported unchanged from Chat Support Pro's promoUtils.js / promoSend.js so
// templates written there render the same here. src/lib/merge.js mirrors
// the merge and map parts for previews; keep the two in step.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function cleanDomain(d) {
  return String(d || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

function applyMerge(template, fields) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in fields ? String(fields[k] ?? '') : m));
}

// "Guest" is Shopify's placeholder for a checkout with no name entered.
function hasUsableName(name) {
  const trimmed = String(name || '').trim();
  return !!trimmed && trimmed.toLowerCase() !== 'guest' && !trimmed.includes('@');
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// WCAG relative luminance.
function luminance({ r, g, b }) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// A pale wash of the brand colour for section backgrounds.
function brandTint(hex, whiteShare = 0.88) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#F4F4F4';
  const mix = (v) => v + (255 - v) * whiteShare;
  return toHex({ r: mix(rgb.r), g: mix(rgb.g), b: mix(rgb.b) });
}

// White or near-black, whichever reads better on top of the brand colour.
const DARK_TEXT = '#1A1A1A';
function brandTextColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#FFFFFF';
  const l = luminance(rgb);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (luminance(hexToRgb(DARK_TEXT)) + 0.05);
  return onWhite >= onDark ? '#FFFFFF' : DARK_TEXT;
}

// "210, 48, 37", for rgba({{store_brand_rgb}}, .3) in templates.
function brandRgb(hex) {
  const rgb = hexToRgb(hex) || { r: 26, g: 86, b: 50 };
  return `${rgb.r}, ${rgb.g}, ${rgb.b}`;
}

// Lookup tables written inside the template itself:
//
//   <!--@map product_image_url from store_brand_color
//   Red  #D23025 = https://.../red.png
//   default      = https://.../blue.png
//   -->
//
// A line's key is the hex colour in it if there is one, otherwise the whole
// left-hand side, matched case-insensitively. The block is removed from the
// sent email.
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

function stripTemplateMaps(template) {
  return String(template || '').replace(MAP_BLOCK_RE, '');
}

function applyTemplateMaps(template, fields) {
  const out = { ...fields };
  for (const { name, source, entries, fallback } of parseTemplateMaps(template)) {
    out[name] = entries.get(lookupKey(fields[source] ?? '')) ?? fallback;
  }
  return out;
}

function slugify(str) {
  return String(str || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Tags every link to the recipient's own store with utm_source (the store
// domain), utm_medium=promo_email, utm_campaign (the campaign name) and
// utm_content (the link's text, an image link's alt text, or link-N, with
// -2/-3 for repeats). Links elsewhere and the unsubscribe link are left alone.
function appendUtmToStoreLinks(html, { storeDomain, campaignName } = {}) {
  const targetHost = cleanDomain(storeDomain).replace(/^www\./, '');
  if (!targetHost) return html;

  const utmCampaign = slugify(campaignName) || 'untitled';
  let linkIndex = 0;
  const seenSlugs = new Map();

  return String(html).replace(
    /<a\s+([^>]*?)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi,
    (match, beforeAttrs, quote, url, afterAttrs, inner) => {
      let parsed;
      try { parsed = new URL(url); } catch { return match; }
      if (!/^https?:$/.test(parsed.protocol)) return match;
      if (parsed.hostname.replace(/^www\./i, '').toLowerCase() !== targetHost) return match;

      linkIndex += 1;
      const imgAlt = /<img\b[^>]*\balt\s*=\s*(["'])(.*?)\1/i.exec(inner);
      let contentSlug = slugify(inner) || (imgAlt && slugify(imgAlt[2])) || `link-${linkIndex}`;
      const seenCount = (seenSlugs.get(contentSlug) || 0) + 1;
      seenSlugs.set(contentSlug, seenCount);
      if (seenCount > 1) contentSlug = `${contentSlug}-${seenCount}`;

      parsed.searchParams.set('utm_source', targetHost);
      parsed.searchParams.set('utm_medium', 'promo_email');
      parsed.searchParams.set('utm_campaign', utmCampaign);
      parsed.searchParams.set('utm_content', contentSlug);
      return `<a ${beforeAttrs}href=${quote}${parsed.toString()}${quote}${afterAttrs}>${inner}</a>`;
    }
  );
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The {{moved_banner}} shown to a customer whose store now lives at another
// domain. Plain colours only: mail clients ignore CSS variables.
function movedBanner(movedToDomain, brandColor = '#0b3d2c') {
  const domain = cleanDomain(movedToDomain);
  if (!domain) return { html: '', text: '' };
  const url = `https://${domain}`;
  return {
    html: `<p style="margin:0 0 16px 0;padding:14px 18px;background:#f4f6f5;border-left:4px solid ${escapeHtml(brandColor)};border-radius:6px;color:#1a1a1a;font-size:14px;">📍 We've moved. You can now find us at <a href="${url}" style="color:${escapeHtml(brandColor)};font-weight:700;">${escapeHtml(domain)}</a>.</p>`,
    text: `We've moved! You can now find us at ${url}.\n`,
  };
}

module.exports = {
  EMAIL_RE, cleanDomain, applyMerge, hasUsableName, escapeHtml,
  brandTint, brandTextColor, brandRgb,
  applyTemplateMaps, stripTemplateMaps,
  slugify, appendUtmToStoreLinks, movedBanner,
};
