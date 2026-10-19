// server/services/customerImport.js
// Customer file uploads (CSV or Excel). The format is the template from
// GET /api/customers/import/template:
//
//   customer_name,email,store_name,store_url,phone,last_order_date
//
// email and store_url are required. Rows go through services/ingest.js
// (cleaning, one customer per email, latest store wins). A row without a
// last_order_date can add a new customer but never moves an existing one.
// A row whose store isn't set up is left out and listed, so it can be added
// first (POST /api/stores/bulk) and the file imported again.

const XLSX = require('xlsx');
const { ingest } = require('./ingest');

const MAX_ROWS = 200000;

const TEMPLATE = [
  'customer_name,email,store_name,store_url,phone,last_order_date',
  'Jane Doe,jane.doe@gmail.com,Ottawa Peptides,https://ottawapeptides.com,613-555-0101,2026-10-02',
  'John Smith,john@acmecorp.com,Montreal Peptides,montrealpeptides.com,,2026-09-15',
  'Ana Lopez,ana.lopez@proton.me,Ottawa Peptides,ottawapeptides.com,(613) 555-0199,',
].join('\n') + '\n';

// Accepted column names, compared without spaces, case or punctuation.
const HEADERS = {
  email:     ['email', 'emailaddress', 'customeremail'],
  storeUrl:  ['storeurl', 'store', 'storedomain', 'domain', 'website', 'url', 'storewebsite', 'sourcestore', 'sourcedomain'],
  name:      ['customername', 'name', 'customer', 'fullname'],
  storeName: ['storename', 'brand', 'brandname'],
  phone:     ['phone', 'phonenumber', 'customerphone', 'mobile', 'tel', 'telephone'],
  seenAt:    ['lastorderdate', 'orderdate', 'lastorder', 'lastpurchase', 'lastpurchasedate', 'date', 'lastseen'],
};
const norm = (h) => String(h || '').trim().toLowerCase().replace(/[^a-z]/g, '');

function readFile(buffer) {
  let wb;
  try {
    // cellDates: Excel date cells arrive as dates, not day numbers.
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch (err) {
    return { error: `Could not read the file: ${err.message}` };
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
  if (!rows.length) return { error: 'The file has no rows.' };
  if (rows.length > MAX_ROWS) return { error: `The file has ${rows.length.toLocaleString()} rows; the most is ${MAX_ROWS.toLocaleString()}. Split it and import the parts.` };
  const keys = Object.keys(rows[0]);
  const col = {};
  for (const [field, names] of Object.entries(HEADERS)) col[field] = keys.find((k) => names.includes(norm(k)));
  const missing = [!col.email && 'email', !col.storeUrl && 'store_url'].filter(Boolean);
  if (missing.length) {
    return { error: `The file needs ${missing.join(' and ')} column${missing.length > 1 ? 's' : ''}. Download the template to see the format. Columns found: ${keys.join(', ')}` };
  }
  const get = (r, f) => {
    if (!col[f]) return '';
    const v = r[col[f]];
    if (v instanceof Date) return v;
    return String(v ?? '').trim();
  };
  return {
    rows: rows.map((r, i) => ({
      line: i + 2,
      email: get(r, 'email'),
      storeUrl: get(r, 'storeUrl'),
      name: get(r, 'name'),
      storeName: get(r, 'storeName'),
      phone: get(r, 'phone'),
      seenAt: get(r, 'seenAt'),
    })),
    columns: Object.fromEntries(Object.entries(col).filter(([, v]) => v)),
  };
}

// Without apply: a preview, nothing written.
async function importFile(buffer, { apply = false, createdBy } = {}) {
  const file = readFile(buffer);
  if (file.error) return { error: file.error };
  const report = await ingest(file.rows, { source: 'upload', apply, unknownStores: 'skip', createdBy });
  const { customerIds, ...rest } = report;
  return {
    ...rest,
    preview: !apply,
    columns: file.columns,
    undated: file.rows.filter((r) => !r.seenAt).length,
    rejected: report.rejected.slice(0, 20000),
  };
}

module.exports = { TEMPLATE, readFile, importFile };
