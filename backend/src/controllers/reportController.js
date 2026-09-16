const pool = require('../config/db');

// GET /api/reports/summary?days=7
// Returns aggregated figures only — never individual student orders,
// per FR-17 ("College administrators shall see summarised figures
// only, not individual student orders") and NFR-06 (data minimisation).
async function getSummary(req, res, next) {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 7, 90);

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
      'SELECT COUNT(*) AS openCounters, (SELECT COUNT(*) FROM counters) AS totalCounters FROM counters WHERE is_open = TRUE'
    );

    res.json({
      periodDays: days,
      avgWaitMinutes: waitStats.avgWaitMinutes,
      maxQueueLength: waitStats.maxQueueLength,
      totalOrders: orderStats.totalOrders,
      openCounters: counterStats.openCounters,
      totalCounters: counterStats.totalCounters,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getSummary };
