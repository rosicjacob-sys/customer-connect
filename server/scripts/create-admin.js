// server/scripts/create-admin.js
// Creates an admin, or resets an existing user's password and makes them admin.
//   npm run create-admin -- you@example.com 'a-long-password' "Your Name"

const db = require('../db');
const { hashPassword } = require('../auth');

async function main() {
  const [email, password, ...nameParts] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: npm run create-admin -- <email> <password> [name]');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('The password needs at least 8 characters.');
    process.exit(1);
  }
  await db.migrate();
  const name = nameParts.join(' ') || email.split('@')[0];
  const { rows: [u] } = await db.pool.query(`
    INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, 'admin', $3)
    ON CONFLICT (LOWER(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', is_active = TRUE, updated_at = NOW()
    RETURNING (xmax = 0) AS created`,
  [email.trim().toLowerCase(), name, await hashPassword(password)]);
  console.log(u.created ? `✅ Created admin ${email}` : `✅ Reset ${email}'s password; they are an admin`);
  await db.pool.end();
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
