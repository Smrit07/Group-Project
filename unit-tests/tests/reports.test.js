'use strict';
/**
 * UT-10  getReport(admin) - admin token -> summarised figures only, no student IDs
 *
 * Requirements: FR-13, FR-14, FR-17, NFR-06
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  useFakeDb, load, createReq, callController, runChain, signToken, bearer,
} = require('../helpers/setup');

const db = useFakeDb();
const { getSummary } = load('src/controllers/reportController.js');
const { requireAuth, requireRole } = load('src/middleware/auth.js');
const reportRouter = load('src/routes/reportRoutes.js');

function seedReportData() {
  db.reset();
  db.poolHandler = async (sql) => {
    if (/FROM queue_observations/.test(sql)) return [[{ avgWaitMinutes: 6.4, maxQueueLength: 18 }]];
    if (/FROM orders/.test(sql)) return [[{ totalOrders: 213 }]];
    if (/FROM counters/.test(sql)) return [[{ openCounters: 2, totalCounters: 3, staffOnDuty: 2 }]];
    return [[{}]];
  };
}

async function summary(query = {}, role = 'admin') {
  seedReportData();
  return callController(getSummary, createReq({ query, user: { id: 1, role } }));
}

test('UT-10 getReport: admin gets summarised figures', async () => {
  const res = await summary({ period: 'weekly' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    period: 'weekly',
    periodDays: 7,
    avgWaitMinutes: 6.4,
    maxQueueLength: 18,
    totalOrders: 213,
    openCounters: 2,
    totalCounters: 3,
    staffOnDuty: 2,
  });
});

test('UT-10 getReport: response contains no personal data (no student ids, names or emails)', async () => {
  const res = await summary();
  const keys = Object.keys(res.body).join(' ');
  assert.ok(!/student|user|email|name|password|order_?id/i.test(keys), `suspicious keys: ${keys}`);
  for (const value of Object.values(res.body)) {
    assert.ok(typeof value === 'number' || typeof value === 'string', 'only plain figures, no nested rows');
  }
});

test('UT-10 getReport: the SQL never reads student identities (aggregates only)', async () => {
  await summary();
  assert.ok(db.poolCalls.length >= 3);
  for (const { sql } of db.poolCalls) {
    assert.ok(!/student_id|full_name|email|password|JOIN users|FROM users/i.test(sql), `personal column in: ${sql}`);
    assert.ok(/COUNT|AVG|MAX/i.test(sql), 'query is an aggregate');
  }
});

test('UT-10 getReport: supports daily / weekly / monthly / semester periods (FR-14)', async () => {
  const expected = { daily: 1, weekly: 7, monthly: 30, semester: 120 };
  for (const [period, days] of Object.entries(expected)) {
    const res = await summary({ period });
    assert.equal(res.body.period, period);
    assert.equal(res.body.periodDays, days);
  }
});

test('UT-10 getReport: unknown or missing period falls back to weekly', async () => {
  assert.equal((await summary({ period: 'fortnightly' })).body.period, 'weekly');
  assert.equal((await summary({})).body.period, 'weekly');
});

test('UT-10 getReport: period value is passed as a bound parameter, not pasted into SQL (no injection)', async () => {
  await summary({ period: "daily'; DROP TABLE orders;--" });
  for (const { sql } of db.poolCalls) assert.ok(!/DROP TABLE/i.test(sql));
});

test('UT-10 getReport: the route allows admin and manager but blocks students and staff', async () => {
  const layer = reportRouter.stack.find((l) => l.route && l.route.path === '/summary');
  assert.ok(layer, 'GET /summary exists');
  const guards = layer.route.stack.map((l) => l.handle).slice(0, -1);
  assert.equal(guards[0], requireAuth);

  for (const role of ['admin', 'manager']) {
    const { reachedHandler } = await runChain(guards, createReq({ headers: bearer(signToken({ role })) }));
    assert.equal(reachedHandler, true, `${role} should reach the report`);
  }
  for (const role of ['student', 'staff']) {
    const { res, reachedHandler } = await runChain(guards, createReq({ headers: bearer(signToken({ role })) }));
    assert.equal(reachedHandler, false, `${role} must not reach the report`);
    assert.equal(res.statusCode, 403);
  }
  assert.equal(typeof requireRole('admin'), 'function');
});
