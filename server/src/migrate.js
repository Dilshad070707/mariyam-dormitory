require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
(async () => {
  try { const sql = fs.readFileSync(path.join(__dirname, '../migrations/001_initial.sql'), 'utf8'); await pool.query(sql); console.log('Database schema is up to date.'); }
  catch (err) { console.error(err.message); process.exitCode = 1; }
  finally { await pool.end(); }
})();
