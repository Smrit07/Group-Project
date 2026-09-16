// Central MySQL connection pool.
// A pool (rather than a single connection) lets multiple requests
// (student, staff, admin) hit the database concurrently without
// waiting on each other — important during peak-hour load (NFR-03).

const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

module.exports = pool;
