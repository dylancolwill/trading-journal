const { Pool, types } = require('pg');
const fs = require('fs');
const path = require('path');

// Return TIMESTAMP and DATE columns as raw strings — no timezone conversion
types.setTypeParser(1114, val => val); // TIMESTAMP
types.setTypeParser(1082, val => val); // DATE

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'journal',
  password: process.env.DB_PASS || 'journal',
  database: process.env.DB_NAME || 'journal',
});

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('DB schema ready');
}

module.exports = { pool, initDb };
