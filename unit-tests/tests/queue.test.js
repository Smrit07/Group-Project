'use strict';
/**
 * UT-03  getQueueLength()                 - 3 orders in received/preparing -> queue length 3
 * UT-04  estimateWait(queue, counters)    - queue=6, counters=2, avg service=2.5 -> 7.5 min, labelled
 * UT-11  fallbackEstimate()               - simulation engine stopped -> queue length + "approximate" label
 *
 * Requirements: FR-02, FR-03, FR-04, FR-15, NFR-07, NFR-09
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  useFakeDb, load, createReq, callController, liveStateFromSql,
  stubFetch, engineReturns, engineDown, resetDesBreaker, silenceConsole,
} = require('../helpers/setup');

const db = useFakeDb();
const { getLiveQueue } = load('src/controllers/queueController.js');
const { estimateWaitMinutes } = load('src/utils/waitTimeEstimator.js');

const order = (status) => ({ status });
const counter = (id, is_open, staff = null) => ({ id, is_open, assigned_staff_id: staff });

/** Seed the fake database with orders + counters, then call GET /api/queue. */
async function getQueue({ orders, counters }) {
  db.reset();
  db.poolHandler = async (sql) => {
    if (/AS queueLength/.test(sql)) return [[liveStateFromSql(sql, { orders, counters })]];
    return [{ affectedRows: 1 }]; // the queue_observations snapshot INSERT
  };
  return callController(getLiveQueue, createReq());
}

const TWO_OPEN = [counter(1, true, 10), counter(2, true, 11), counter(3, false)];

// ------------------------------------------------------------------ UT-03
test('UT-03 getQueueLength: 3 orders in received/preparing -> queue length = 3', async () => {
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const res = await getQueue({
      orders: [order('received'), order('preparing'), order('received')],
      counters: TWO_OPEN,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.queueLength, 3);
  } finally { restore(); stub.restore(); }
});

test('UT-03 getQueueLength: ready / completed / cancelled orders are NOT counted as queueing', async () => {
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const res = await getQueue({
      orders: [
        order('received'), order('preparing'), order('received'), // 3 waiting
        order('ready'), order('completed'), order('completed'), order('cancelled'),
      ],
      counters: TWO_OPEN,
    });
    assert.equal(res.body.queueLength, 3);
  } finally { restore(); stub.restore(); }
});

test('UT-03 getQueueLength: empty cafeteria -> 0', async () => {
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const res = await getQueue({ orders: [], counters: TWO_OPEN });
    assert.equal(res.body.queueLength, 0);
  } finally { restore(); stub.restore(); }
});

test('UT-03 getQueueLength: counts open counters and staff on duty alongside the queue', async () => {
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const res = await getQueue({ orders: [order('received')], counters: TWO_OPEN });
    assert.equal(res.body.openCounters, 2);
    assert.equal(res.body.staffOnDuty, 2);
  } finally { restore(); stub.restore(); }
});

// ------------------------------------------------------------------ UT-04 (the formula)
test('UT-04 estimateWait: queue=6, counters=2, avg service 2.5 min -> 7.5 min', () => {
  assert.equal(estimateWaitMinutes(6, 2), 7.5);
});

test('UT-04 estimateWait: scales with queue and counters, rounded to 1 decimal', () => {
  assert.equal(estimateWaitMinutes(0, 2), 0);
  assert.equal(estimateWaitMinutes(10, 1), 25);
  assert.equal(estimateWaitMinutes(5, 3), 4.2); // 5/3*2.5 = 4.1667
  assert.equal(estimateWaitMinutes(6, 3), 5);
});

test('UT-04 estimateWait: more open counters never makes the wait longer', () => {
  let previous = Infinity;
  for (let counters = 1; counters <= 6; counters += 1) {
    const wait = estimateWaitMinutes(12, counters);
    assert.ok(wait <= previous, `${counters} counters gave ${wait}, worse than ${previous}`);
    previous = wait;
  }
});

test('UT-04 estimateWait: no open counters -> null (cannot estimate), not Infinity/NaN', () => {
  assert.equal(estimateWaitMinutes(6, 0), null);
  assert.equal(estimateWaitMinutes(6, undefined), null);
});

// ------------------------------------------------------------------ UT-04 (labelling, via the API)
test('UT-04 estimateWait: the API labels the figure as an estimate (FR-04) - DES engine available', async () => {
  await resetDesBreaker();
  const stub = stubFetch(
    engineReturns({ estimatedWaitMinutes: 6.8, p90WaitMinutes: 9.1, confidence: 'high', modelVersion: 'des-test' })
  );
  try {
    const res = await getQueue({
      orders: Array.from({ length: 6 }, () => order('received')),
      counters: [counter(1, true, 10), counter(2, true, 11)],
    });
    assert.equal(res.body.queueLength, 6);
    assert.equal(res.body.estimatedWaitMinutes, 6.8);
    assert.equal(res.body.isEstimate, true, 'FR-04: always flagged as an estimate');
    assert.equal(res.body.source, 'des_model');
    assert.equal(res.body.confidence, 'high');
    assert.equal(stub.calls.length, 1);
    assert.match(stub.calls[0].url, /\/estimate$/);
    assert.deepEqual(JSON.parse(stub.calls[0].body).queueLength, 6, 'engine was asked about the real queue');
  } finally { stub.restore(); }
});

test('UT-04 estimateWait: engine down, queue=6 counters=2 -> 7.5 min, labelled as an estimate', async () => {
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const res = await getQueue({
      orders: Array.from({ length: 6 }, () => order('received')),
      counters: [counter(1, true, 10), counter(2, true, 11)],
    });
    assert.equal(res.body.estimatedWaitMinutes, 7.5);
    assert.equal(res.body.isEstimate, true);
  } finally { restore(); stub.restore(); }
});

// ------------------------------------------------------------------ UT-11
test('UT-11 fallbackEstimate: engine stopped -> request still succeeds and queue length is shown', async () => {
  await resetDesBreaker();
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const res = await getQueue({
      orders: [order('received'), order('preparing'), order('received'), order('received')],
      counters: TWO_OPEN,
    });
    assert.equal(res.statusCode, 200, 'NFR-09: never an error page');
    assert.equal(res.body.queueLength, 4);
  } finally { restore(); stub.restore(); }
});

test('UT-11 fallbackEstimate: result is labelled approximate (source, low confidence, explanatory note)', async () => {
  await resetDesBreaker();
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const res = await getQueue({ orders: [order('received'), order('received')], counters: TWO_OPEN });
    assert.equal(res.body.source, 'live_count', 'not presented as a DES result');
    assert.equal(res.body.confidence, 'low');
    assert.equal(res.body.isEstimate, true);
    assert.match(res.body.note, /unavailable/i);
    assert.match(res.body.note, /rough|estimate/i);
    assert.equal(res.body.modelVersion, null);
    assert.equal(res.body.p90WaitMinutes, null);
    assert.equal(res.body.estimatedWaitMinutes, 2.5); // 2 / 2 counters * 2.5
  } finally { restore(); stub.restore(); }
});

test('UT-11 fallbackEstimate: no counters open -> wait is null but queue length is still shown', async () => {
  await resetDesBreaker();
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const res = await getQueue({
      orders: [order('received'), order('received'), order('received')],
      counters: [counter(1, false), counter(2, false)],
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.queueLength, 3);
    assert.equal(res.body.estimatedWaitMinutes, null);
  } finally { restore(); stub.restore(); }
});

test('UT-11 fallbackEstimate: engine returns HTTP 500 -> same graceful fallback', async () => {
  await resetDesBreaker();
  const stub = stubFetch(engineReturns({ message: 'boom' }, 500));
  const restore = silenceConsole();
  try {
    const res = await getQueue({ orders: [order('received')], counters: TWO_OPEN });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.source, 'live_count');
  } finally { restore(); stub.restore(); }
});

test('UT-11 fallbackEstimate: engine times out -> same graceful fallback', async () => {
  await resetDesBreaker();
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const stub = stubFetch(async () => { throw timeout; });
  const restore = silenceConsole();
  try {
    const res = await getQueue({ orders: [order('received')], counters: TWO_OPEN });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.source, 'live_count');
  } finally { restore(); stub.restore(); }
});
