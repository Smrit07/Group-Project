const pool = require('../config/db');
const desClient = require('../services/desClient');
const { estimateWaitMinutes } = require('../utils/waitTimeEstimator');

// ---------------------------------------------------------------------------
// Live queue state (FR-02, FR-03, FR-04, FR-15).
// ---------------------------------------------------------------------------
// This endpoint is the busiest in the system: every open student browser polls
// it, and it is the one thing that must never be slow or fail, because it is
// what the student looks at before deciding whether to walk over. Three
// decisions follow from that:
//
//   1. The DES call goes through desClient, which gives up after 1.5s and
//      opens a circuit breaker if the engine is down, so an unavailable
//      engine costs one slow request rather than every request (NFR-09).
//   2. The fallback is never an error — it is a worse estimate, clearly
//      labelled as such in `source`, so the banner keeps working.
//   3. Snapshots are written on a timer, not on every request. Previously one
//      row went into queue_observations per page load; twenty students with
//      the page open wrote twenty identical rows a second, which both bloated
//      the table and skewed every average computed from it.
// ---------------------------------------------------------------------------

// Minimum gap between persisted snapshots. Five seconds keeps the history
// dense enough to chart while making the row count independent of how many
// students happen to be looking.
const SNAPSHOT_INTERVAL_MS = Number(process.env.QUEUE_SNAPSHOT_INTERVAL_MS || 5000);
let lastSnapshotAt = 0;

/**
 * Read the two live counts the model needs.
 * Deliberately one round trip rather than two: at peak these fire constantly,
 * and two sequential queries double the pool pressure for no benefit.
 */
async function readLiveState() {
  const [[row]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM orders   WHERE status IN ('received', 'preparing')) AS queueLength,
       (SELECT COUNT(*) FROM counters WHERE is_open = TRUE)                      AS openCounters,
       (SELECT COUNT(DISTINCT assigned_staff_id) FROM counters
         WHERE is_open = TRUE AND assigned_staff_id IS NOT NULL)                 AS staffOnDuty`
  );
  return {
    queueLength: Number(row.queueLength) || 0,
    openCounters: Number(row.openCounters) || 0,
    staffOnDuty: Number(row.staffOnDuty) || 0,
  };
}

/**
 * Ask the DES engine, falling back to the arithmetic estimator.
 *
 * The fallback is not a second-best implementation of the same thing — it is a
 * different, much cruder claim, so the response says which one produced the
 * number. FR-04 requires every figure to be labelled an estimate; a student
 * deserves to know when it is a simulation and when it is queue ÷ counters.
 */
async function estimateWait(state) {
  try {
    const result = await desClient.estimate({
      queueLength: state.queueLength,
      openCounters: state.openCounters,
      staffCount: state.staffOnDuty || state.openCounters,
    });
    return {
      minutes: result.estimatedWaitMinutes,
      p90Minutes: result.p90WaitMinutes ?? null,
      confidence: result.confidence || 'medium',
      source: 'des_model',
      modelVersion: result.modelVersion || null,
      note: result.message || null,
    };
  } catch (err) {
    return {
      minutes: estimateWaitMinutes(state.queueLength, state.openCounters),
      p90Minutes: null,
      confidence: 'low',
      source: 'live_count',
      modelVersion: null,
      note:
        'The simulation engine is unavailable, so this is a rough average-rate estimate ' +
        'rather than a simulated one.',
    };
  }
}

/**
 * Persist a snapshot, rate-limited. Failures here are logged and swallowed:
 * a student should never see an error because a history row could not be
 * written — the reporting data is secondary to the live answer.
 */
async function recordSnapshot(state, estimate) {
  const now = Date.now();
  if (now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return false;
  lastSnapshotAt = now;

  try {
    await pool.query(
      `INSERT INTO queue_observations
         (queue_length, open_counters, estimated_wait_minutes, source, model_version)
       VALUES (?, ?, ?, ?, ?)`,
      [state.queueLength, state.openCounters, estimate.minutes, estimate.source, estimate.modelVersion]
    );
    return true;
  } catch (err) {
    console.warn('[queue] Could not record snapshot:', err.message);
    return false;
  }
}

// GET /api/queue — live queue length + estimated wait.
// Public: FR-15 requires this to be visible without placing an order, and
// without logging in at all.
async function getLiveQueue(req, res, next) {
  try {
    const state = await readLiveState();
    const estimate = await estimateWait(state);
    await recordSnapshot(state, estimate);

    res.json({
      queueLength: state.queueLength,
      openCounters: state.openCounters,
      staffOnDuty: state.staffOnDuty,
      estimatedWaitMinutes: estimate.minutes, // null when it genuinely cannot be estimated
      p90WaitMinutes: estimate.p90Minutes,
      isEstimate: true, // FR-04: always an estimate, never a guaranteed time
      confidence: estimate.confidence,
      source: estimate.source,
      modelVersion: estimate.modelVersion,
      note: estimate.note,
      observedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/queue/history?limit=50&hours=24 — admin dashboard (FR-13, FR-14)
async function getQueueHistory(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const hours = Math.min(parseInt(req.query.hours, 10) || 24, 24 * 90);

    const [rows] = await pool.query(
      `SELECT queue_length, open_counters, estimated_wait_minutes, source, recorded_at
       FROM queue_observations
       WHERE recorded_at >= (NOW() - INTERVAL ? HOUR)
       ORDER BY recorded_at DESC
       LIMIT ?`,
      [hours, limit]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
}

// GET /api/queue/accuracy — how close the predictions have been (Section 6.3
// of the proposal names "prediction accuracy" as an evaluation metric; this is
// the endpoint that finally supplies a number for it).
//
// Reads the v_prediction_accuracy view rather than recomputing the join here,
// so the definition of "accuracy" lives in exactly one place and the report
// and the dashboard cannot drift apart.
async function getPredictionAccuracy(req, res, next) {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 14, 180);
    const [rows] = await pool.query(
      `SELECT observation_date, estimate_source, observations,
              avg_predicted_minutes, avg_actual_minutes, mean_absolute_error_minutes
       FROM v_prediction_accuracy
       WHERE observation_date >= (CURDATE() - INTERVAL ? DAY)
       ORDER BY observation_date DESC`,
      [days]
    );

    const withError = rows.filter((r) => r.mean_absolute_error_minutes !== null);
    const overallMae = withError.length
      ? withError.reduce((sum, r) => sum + Number(r.mean_absolute_error_minutes), 0) / withError.length
      : null;

    res.json({
      days,
      rows,
      overallMeanAbsoluteErrorMinutes: overallMae === null ? null : Math.round(overallMae * 100) / 100,
      interpretation:
        overallMae === null
          ? 'Not enough matched observations yet to measure prediction accuracy.'
          : `On average the predicted wait differs from the actual wait by about ${overallMae.toFixed(1)} minutes.`,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getLiveQueue, getQueueHistory, getPredictionAccuracy };
