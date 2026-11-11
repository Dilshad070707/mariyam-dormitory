const { Pool } = require('pg');
const externalTls = (process.env.DATABASE_URL || '').includes('sslmode=require');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' || externalTls ? { rejectUnauthorized: false } : false });
module.exports = { pool, query: (text, params) => pool.query(text, params) };
