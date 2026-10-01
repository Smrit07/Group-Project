'use strict';
/**
 * Shared test helpers.
 *
 * The goal: run the REAL backend code (controllers, middleware, desClient,
 * waitTimeEstimator) without needing MySQL/XAMPP, the Python engine, or a
 * running server. Only the two outside dependencies are replaced:
 *
 *   1. The MySQL pool  -> an in-memory fake (createFakeDb / useFakeDb)
 *   2. The DES engine  -> global.fetch is stubbed (stubFetch)
 *
 * Everything else is the code you wrote.
 */
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

// ---------------------------------------------------------------- locating the backend
const BACKEND = path.resolve(
  process.env.BACKEND_DIR || path.join(__dirname, '..', '..', 'backend')
);

if (!fs.existsSync(path.join(BACKEND, 'server.js'))) {
  throw new Error(
    `Could not find the backend at: ${BACKEND}\n` +
      'Put the unit-tests folder next to the "backend" folder, or set BACKEND_DIR to its path.'
  );
}
if (!fs.existsSync(path.join(BACKEND, 'node_modules'))) {
  throw new Error(
    `The backend dependencies are not installed.\nRun:  cd "${BACKEND}" && npm install`
  );
}

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-secret';
process.env.JWT_EXPIRES_IN = '8h';
// Point the DES client at a port nothing listens on, in case a test forgets to stub fetch.
process.env.DES_ENGINE_URL = process.env.DES_ENGINE_URL || 'http://127.0.0.1:9';

/** require() that resolves packages from the backend's own node_modules. */
const backendRequire = createRequire(path.join(BACKEND, 'package.json'));

const backendPath = (...parts) => path.join(BACKEND, ...parts);

/** Load a backend module by path relative to the backend folder. */
const load = (relPath) => require(backendPath(relPath));

// ---------------------------------------------------------------- fake database
/**
 * Replace src/config/db.js with an in-memory fake.
 *
 *  db.poolHandler(sql, params) -> what pool.query() resolves to
 *  db.txHandler(sql, params)   -> what connection.query() resolves to (transactions)
 *  db.poolCalls / db.txCalls   -> every query that was issued, for assertions
 *  db.tx                       -> { began, committed, rolledBack, released }
 */
function createFakeDb() {
  const db = {
    poolCalls: [],
    txCalls: [],
    tx: { began: 0, committed: 0, rolledBack: 0, released: 0 },
    poolHandler: async () => [[]],
    txHandler: async () => [[]],
  };

  const connection = {
    query: async (sql, params) => {
      db.txCalls.push({ sql, params });
      return db.txHandler(sql, params);
    },
    beginTransaction: async () => { db.tx.began += 1; },
    commit: async () => { db.tx.committed += 1; },
    rollback: async () => { db.tx.rolledBack += 1; },
    release: () => { db.tx.released += 1; },
  };

  db.pool = {
    query: async (sql, params) => {
      db.poolCalls.push({ sql, params });
      return db.poolHandler(sql, params);
    },
    getConnection: async () => connection,
  };

  db.reset = () => {
    db.poolCalls.length = 0;
    db.txCalls.length = 0;
    db.tx = { began: 0, committed: 0, rolledBack: 0, released: 0 };
  };
  return db;
}

/** Create a fake DB and install it in place of the real MySQL pool. */
function useFakeDb() {
  const db = createFakeDb();
  const dbPath = require.resolve(backendPath('src', 'config', 'db.js'));
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: db.pool,
    children: [],
    paths: [],
  };
  return db;
}

/**
 * Emulates the "live state" SELECT used by queueController and orderController:
 *   (SELECT COUNT(*) FROM orders WHERE status IN ('received','preparing')) AS queueLength, ...
 * It reads the status list OUT OF THE SQL, so if someone changes which statuses count
 * as "in the queue", these tests notice.
 */
function liveStateFromSql(sql, { orders = [], counters = [] } = {}) {
  const match = sql.match(/FROM orders\s+WHERE status IN \(([^)]*)\)/);
  const statuses = match
    ? match[1].split(',').map((s) => s.trim().replace(/'/g, ''))
    : [];
  const open = counters.filter((c) => c.is_open);
  return {
    queueLength: orders.filter((o) => statuses.includes(o.status)).length,
    openCounters: open.length,
    staffOnDuty: new Set(open.filter((c) => c.assigned_staff_id).map((c) => c.assigned_staff_id)).size,
  };
}

// ---------------------------------------------------------------- fake Express req / res
function createRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

/** Fake request. `emitted` collects everything sent through Socket.io (req.app.get('io')). */
function createReq({ body = {}, params = {}, query = {}, headers = {}, user } = {}) {
  const emitted = [];
  const io = { emit: (event, payload) => emitted.push({ event, payload }) };
  return {
    body, params, query, headers, user, emitted,
    app: { get: (key) => (key === 'io' ? io : undefined) },
  };
}

/**
 * Call a controller the way Express would. Errors passed to next(err) are run through
 * the REAL errorHandler so you assert on the final HTTP status + body.
 */
async function callController(handler, req) {
  const res = createRes();
  let nextError;
  await handler(req, res, (err) => { nextError = err; });
  if (nextError) {
    const errorHandler = load('src/middleware/errorHandler.js');
    const restore = silenceConsole();
    try { errorHandler(nextError, req, res, () => {}); } finally { restore(); }
  }
  return res;
}

/** Run a list of middlewares/handlers in order, stopping where one does not call next(). */
async function runChain(chain, req) {
  const res = createRes();
  for (const middleware of chain) {
    let proceeded = false;
    await middleware(req, res, () => { proceeded = true; });
    if (!proceeded) return { res, reachedHandler: false };
  }
  return { res, reachedHandler: true };
}

// ---------------------------------------------------------------- tokens
function signToken(user, options = {}) {
  const jwt = backendRequire('jsonwebtoken');
  return jwt.sign(
    { id: user.id ?? 1, role: user.role, email: user.email ?? `${user.role}@nami.test` },
    options.secret || process.env.JWT_SECRET,
    { expiresIn: options.expiresIn ?? '1h' }
  );
}
const bearer = (token) => ({ authorization: `Bearer ${token}` });

// ---------------------------------------------------------------- DES engine stubs
/** Replace global fetch. Returns the list of calls made and a function that restores it. */
function stubFetch(impl) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers, body: options.body });
    return impl(String(url), options);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

/** An engine that answers every call with the given JSON payload. */
const engineReturns = (payload, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

/** An engine that is switched off (connection refused). */
const engineDown = () => async () => { throw new TypeError('fetch failed'); };

/** Close the circuit breaker again (a successful /health call resets it). */
async function resetDesBreaker() {
  const stub = stubFetch(engineReturns({ status: 'ok' }));
  try { await load('src/services/desClient.js').health(); } finally { stub.restore(); }
}

// ---------------------------------------------------------------- misc
/** Silence console.warn/error while noisy code runs. Returns a restore function. */
function silenceConsole() {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  return () => { console.warn = warn; console.error = error; };
}

module.exports = {
  BACKEND, backendRequire, backendPath, load,
  createFakeDb, useFakeDb, liveStateFromSql,
  createRes, createReq, callController, runChain,
  signToken, bearer,
  stubFetch, engineReturns, engineDown, resetDesBreaker,
  silenceConsole,
};
