// server/routes/util.js
// Small helpers shared by the route files.

// Lets a route be async: a thrown error reaches the error handler in
// server/index.js, which answers with err.status (default 500).
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const httpError = (status, message) => Object.assign(new Error(message), { status });

function idParam(req, name = 'id') {
  const id = parseInt(req.params[name], 10);
  if (!Number.isFinite(id)) throw httpError(400, `Invalid ${name}`);
  return id;
}

// Trimmed string from a query/body value, or undefined when blank.
const str = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s || undefined;
};

// "1,2,3" (or an array) → [1, 2, 3]; undefined when not given.
function intList(v) {
  if (v == null || v === '') return undefined;
  const parts = Array.isArray(v) ? v : String(v).split(',');
  return parts.map((x) => parseInt(x, 10)).filter(Number.isFinite);
}

module.exports = { wrap, httpError, idParam, str, intList };
