// server/auth.js
// Passwords (bcrypt), sign-in tokens (JWT) and the route guards.
// Roles: admin (everything, including users) and editor (everything else).

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { pool } = require('./db');

const hashPassword = (password) => bcrypt.hash(password, 10);
const verifyPassword = (password, hash) => bcrypt.compare(password, hash);

function signToken(user, { remember = true } = {}) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    config.jwtSecret,
    { expiresIn: remember ? '30d' : '12h' }
  );
}

// Checks the token, then that the account still exists and is active, so a
// deactivated user is signed out on their next request.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please sign in' });
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }
  try {
    const { rows } = await pool.query('SELECT id, email, name, role, is_active FROM users WHERE id = $1', [payload.id]);
    if (!rows[0] || !rows[0].is_active) return res.status(401).json({ error: 'This account is no longer active' });
    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Only admins can do this' });
  next();
}

module.exports = { hashPassword, verifyPassword, signToken, requireAuth, requireAdmin };
