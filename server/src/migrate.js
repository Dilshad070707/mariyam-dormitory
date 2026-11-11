require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
(async () => {
  try {
    const migrationDir = path.join(__dirname, '../migrations');
    const migrations = fs.readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort();
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const existingSchema = await pool.query("SELECT to_regclass('public.bookings') AS bookings");
    if (existingSchema.rows[0].bookings) {
      await pool.query("INSERT INTO schema_migrations(name) VALUES('001_initial.sql') ON CONFLICT(name) DO NOTHING");
    }
    for (const migration of migrations) {
      const alreadyApplied = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [migration]);
      if (alreadyApplied.rowCount) {
        console.log(`Skipping ${migration} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(migrationDir, migration), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [migration]);
        await client.query('COMMIT');
        console.log(`Applied ${migration}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
    console.log('Database schema is up to date.');
  }
  catch (err) { console.error(err.message); process.exitCode = 1; }
  finally { await pool.end(); }
})();
