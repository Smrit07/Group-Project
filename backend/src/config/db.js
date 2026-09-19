// ---------------------------------------------------------------------------
// MySQL connection pool (XAMPP).
// ---------------------------------------------------------------------------
// A pool rather than a single connection, so student, staff and admin requests
// do not queue behind each other during the peak-hour load the whole project
// is about (NFR-03).
//
// Beyond that, the two things this file adds are both about the same failure:
// XAMPP's MySQL not being started. That is the single most common reason this
// app appears "broken" on a fresh machine, and the default mysql2 behaviour is
// to fail on the first query with ECONNREFUSED — an error that reaches the
// browser as a generic 500 with no hint about what to do. So:
//
//   * verifyConnection() runs once at boot and prints an explicit, actionable
//     message naming XAMPP's control panel.
//   * describeError() translates the handful of MySQL error codes that
//     actually occur in this setup into instructions.
// ---------------------------------------------------------------------------

const mysql = require('mysql2/promise');

// XAMPP ships MySQL on 3306 as root with an empty password. Those are the
// defaults here so that a clone with no .env at all still connects on a
// standard XAMPP install — the state most people will first run it in.
const config = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'smart_cafeteria',

  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  queueLimit: 0,

  // Fail fast rather than hanging an HTTP request for the OS default of ~75s
  // when MySQL is not listening.
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 8000),

  // Keeps DECIMAL columns (prices, wait estimates) as JS numbers instead of
  // strings. Without this, `price * quantity` silently concatenates.
  decimalNumbers: true,
  dateStrings: false,
  timezone: process.env.DB_TIMEZONE || 'local',
  charset: 'utf8mb4_unicode_ci',

  // Explicitly off: enabling it would turn any single injection point into a
  // multi-statement one.
  multipleStatements: false,
};

const pool = mysql.createPool(config);

/**
 * Turn a mysql2 error into something a person can act on.
 * Used by the boot check and by the error-handler middleware.
 */
function describeError(err) {
  switch (err.code) {
    case 'ECONNREFUSED':
      return (
        `Cannot reach MySQL at ${config.host}:${config.port}. ` +
        'Open the XAMPP Control Panel and press Start next to MySQL.'
      );
    case 'ER_BAD_DB_ERROR':
      return (
        `The database "${config.database}" does not exist. Import database/schema.sql ` +
        '(then seed.sql) via phpMyAdmin at http://localhost/phpmyadmin.'
      );
    case 'ER_ACCESS_DENIED_ERROR':
      return (
        `MySQL rejected the credentials for user "${config.user}". On a default XAMPP ` +
        'install the user is root with an empty password — check backend/.env.'
      );
    case 'ER_NO_SUCH_TABLE':
      return (
        'A required table is missing. Run database/schema.sql on a fresh database, or ' +
        'database/migration_2026_10_des.sql if you are upgrading an existing one.'
      );
    case 'PROTOCOL_CONNECTION_LOST':
    case 'ECONNRESET':
      return 'The MySQL connection dropped — usually XAMPP restarting MySQL mid-request.';
    case 'ER_CON_COUNT_ERROR':
      return 'MySQL refused a new connection because it has hit max_connections.';
    default:
      return err.sqlMessage || err.message;
  }
}

/**
 * One-off boot check, called from server.js before the HTTP listener starts,
 * so a misconfigured database is reported in the terminal the developer is
 * already looking at rather than discovered later through a browser 500.
 *
 * Returns rather than throws: the API should still start and serve
 * /api/health, so the deployment can be diagnosed from the browser.
 */
async function verifyConnection() {
  try {
    const connection = await pool.getConnection();
    try {
      const [[row]] = await connection.query('SELECT VERSION() AS version');

      // Confirm the DES migration has been applied. A schema predating
      // service_events fails later, inside the calibration query, a long way
      // from the actual cause.
      const expected = ['users', 'orders', 'service_events', 'queue_observations'];
      const [tables] = await connection.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?, ?, ?, ?)`,
        [config.database, ...expected]
      );
      const present = new Set(tables.map((t) => t.TABLE_NAME));
      const missing = expected.filter((t) => !present.has(t));

      return {
        connected: true,
        version: row.version,
        database: config.database,
        missingTables: missing,
        warning: missing.length
          ? `Missing table(s): ${missing.join(', ')}. Run database/migration_2026_10_des.sql.`
          : null,
      };
    } finally {
      connection.release();
    }
  } catch (err) {
    return { connected: false, error: describeError(err), code: err.code || null };
  }
}

/** Close the pool cleanly on shutdown so MySQL does not log aborted clients. */
async function closePool() {
  try {
    await pool.end();
  } catch (err) {
    console.warn('[db] Error while closing the pool:', err.message);
  }
}

module.exports = pool;
module.exports.verifyConnection = verifyConnection;
module.exports.describeError = describeError;
module.exports.closePool = closePool;
module.exports.config = config;
