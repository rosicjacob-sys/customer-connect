// server/routes/auth.js
//   POST /api/auth/login          email + password → token
//   GET  /api/auth/me             the signed-in user
//   POST /api/auth/me/password    change your own password
//   /api/users …                  (admin) manage who can sign in

const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { hashPassword, verifyPassword, signToken, requireAuth, requireAdmin } = require('../auth');
const { EMAIL_RE } = require('../lib/merge');
const { wrap, httpError, idParam } = require('./util');

const router = express.Router();
const ROLES = ['admin', 'editor'];
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, isActive: u.is_active, lastLoginAt: u.last_login_at });

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' },
});

router.post('/auth/login', loginLimiter, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const { rows: [user] } = await pool.query('SELECT * FROM users WHERE LOWER(email) = $1', [email]);
  // Same message either way, so the form doesn't reveal which emails have accounts.
  if (!user || !user.is_active || !(await verifyPassword(password, user.password_hash))) {
    throw httpError(401, 'Wrong email or password');
  }
  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
  res.json({ token: signToken(user, { remember: req.body?.remember !== false }), user: publicUser(user) });
}));

router.get('/auth/me', requireAuth, (req, res) => res.json(publicUser(req.user)));

router.post('/auth/me/password', requireAuth, wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (String(newPassword || '').length < 8) throw httpError(400, 'The new password needs at least 8 characters');
  const { rows: [user] } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await verifyPassword(String(currentPassword || ''), user.password_hash))) throw httpError(400, 'Your current password is not right');
  await pool.query('UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1', [req.user.id, await hashPassword(newPassword)]);
  res.json({ ok: true });
}));

// ── Users (admin) ───────────────────────────────────────────────────────────

router.get('/users', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY is_active DESC, LOWER(name)');
  res.json(rows.map(publicUser));
}));

router.post('/users', requireAuth, requireAdmin, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  const role = ROLES.includes(req.body?.role) ? req.body.role : 'editor';
  const password = String(req.body?.password || '');
  if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email');
  if (!name) throw httpError(400, 'Enter a name');
  if (password.length < 8) throw httpError(400, 'The password needs at least 8 characters');
  try {
    const { rows: [u] } = await pool.query(
      'INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING *',
      [email, name, role, await hashPassword(password)]);
    res.status(201).json(publicUser(u));
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'Someone already uses that email');
    throw err;
  }
}));

router.put('/users/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
  const id = idParam(req);
  const { name, role, isActive, password } = req.body || {};
  if (id === req.user.id && (role && role !== 'admin' || isActive === false)) {
    throw httpError(400, "You can't remove your own admin access or deactivate yourself");
  }
  if (role != null && !ROLES.includes(role)) throw httpError(400, 'Unknown role');
  if (password != null && String(password).length < 8) throw httpError(400, 'The password needs at least 8 characters');
  const { rows: [u] } = await pool.query(`
    UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), is_active = COALESCE($4, is_active),
           password_hash = COALESCE($5, password_hash), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
  [id, name ? String(name).trim() : null, role || null, typeof isActive === 'boolean' ? isActive : null,
    password ? await hashPassword(String(password)) : null]);
  if (!u) throw httpError(404, 'User not found');
  res.json(publicUser(u));
}));

module.exports = router;
