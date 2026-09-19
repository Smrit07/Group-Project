const pool = require('../config/db');

// FR-14: daily, weekly, monthly and semester report periods.
// A semester is approximated as 4 months, since NAMI College's academic
// calendar isn't part of the system's data.
const PERIOD_DAYS = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  semester: 120,
};

// GET /api/reports/summary?period=daily|weekly|monthly|semester
// Aggregated figures only — never individual student orders — per FR-17
// ("College administrators shall see summarised figures only") and
// NFR-06 (data minimisation).
async function getSummary(req, res, next) {
  try {
    const period = PERIOD_DAYS[req.query.period] ? req.query.period : 'weekly';
    const days = PERIOD_DAYS[period];

    const [[waitStats]] = await pool.query(
      `SELECT
         ROUND(AVG(estimated_wait_minutes), 1) AS avgWaitMinutes,
         MAX(queue_length) AS maxQueueLength
       FROM queue_observations
       WHERE recorded_at >= (NOW() - INTERVAL ? DAY)`,
      [days]
    );

    const [[orderStats]] = await pool.query(
      `SELECT COUNT(*) AS totalOrders
       FROM orders
       WHERE created_at >= (NOW() - INTERVAL ? DAY)`,
      [days]
    );

    const [[counterStats]] = await pool.query(
      `SELECT
         COUNT(*) AS openCounters,
         (SELECT COUNT(*) FROM counters) AS totalCounters,
         COUNT(DISTINCT assigned_staff_id) AS staffOnDuty
       FROM counters
       WHERE is_open = TRUE`
    );

    res.json({
      period,
      periodDays: days,
      avgWaitMinutes: waitStats.avgWaitMinutes,
      maxQueueLength: waitStats.maxQueueLength,
      totalOrders: orderStats.totalOrders,
      openCounters: counterStats.openCounters,
      totalCounters: counterStats.totalCounters,
      staffOnDuty: counterStats.staffOnDuty,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getSummary };
