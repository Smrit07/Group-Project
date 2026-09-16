const pool = require('../config/db');
const { estimateWaitMinutes } = require('../utils/waitTimeEstimator');

// DES_ENGINE_URL points at the Python/SimPy service (see /des-engine).
// It is optional for local dev — if it's not running we fall back to
// the simple estimator so the app keeps working (NFR-09).
const DES_ENGINE_URL = process.env.DES_ENGINE_URL || 'http://localhost:5001';

async function fetchDesEstimate(queueLength, openCounters) {
  try {
    const response = await fetch(`${DES_ENGINE_URL}/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueLength, openCounters }),
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw new Error('DES engine returned a non-OK status');
    const data = await response.json();
    return { minutes: data.estimatedWaitMinutes, source: 'des_model' };
  } catch (err) {
    // DES engine unreachable/slow — fall back rather than fail the request.
    return { minutes: estimateWaitMinutes(queueLength, openCounters), source: 'live_count' };
  }
}

// GET /api/queue — live queue length + estimated wait, visible to everyone
// including students who have not placed an order (FR-02, FR-15).
async function getLiveQueue(req, res, next) {
  try {
    const [[{ queueLength }]] = await pool.query(
      "SELECT COUNT(*) AS queueLength FROM orders WHERE status IN ('received', 'preparing')"
    );
    const [[{ openCounters }]] = await pool.query(
      'SELECT COUNT(*) AS openCounters FROM counters WHERE is_open = TRUE'
    );

    const { minutes, source } = await fetchDesEstimate(queueLength, openCounters);

    // Store a snapshot for historical/admin reporting (FR-13, FR-14).
    await pool.query(
      'INSERT INTO queue_observations (queue_length, estimated_wait_minutes, source) VALUES (?, ?, ?)',
      [queueLength, minutes, source]
    );

    res.json({
      queueLength,
      openCounters,
      estimatedWaitMinutes: minutes, // null if it genuinely cannot be estimated
      isEstimate: true, // FR-04: always label as an estimate, never an exact time
      source,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/queue/history?limit=50 — used by the admin dashboard (FR-13, FR-14)
async function getQueueHistory(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const [rows] = await pool.query(
      'SELECT queue_length, estimated_wait_minutes, source, recorded_at FROM queue_observations ORDER BY recorded_at DESC LIMIT ?',
      [limit]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { getLiveQueue, getQueueHistory };
