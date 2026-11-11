require('dotenv').config();
const bcrypt = require('bcryptjs');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { pool } = require('./db');
(async () => {
  const rl = readline.createInterface({ input, output });
  try {
    const email = (await rl.question('Admin email: ')).trim().toLowerCase();
    const password = await rl.question('Admin password (12+ characters): ');
    if (!email || password.length < 12) throw new Error('Enter a valid email and a password of at least 12 characters.');
    const hash = await bcrypt.hash(password, 12);
    await pool.query("INSERT INTO admin_users(email,password_hash,role) VALUES($1,$2,'admin') ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash, active=TRUE", [email, hash]);
    console.log('Admin account created or updated.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { rl.close(); await pool.end(); }
})();
