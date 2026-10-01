'use strict';
/**
 * UT-09  runScenario(params) - 2 counters vs 3 counters -> avg wait + confidence interval for both
 *
 * Requirements: FR-12, FR-13, FR-17
 *
 * This file tests the Node side: the manager's form is validated, forwarded to the engine,
 * stored, and engine failures are reported correctly. The real SimPy maths (averages and
 * confidence intervals) are tested against the actual Python engine in
 * python/test_ut09_des_engine.py.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  useFakeDb, load, createReq, callController, stubFetch, engineReturns, engineDown,
  resetDesBreaker, silenceConsole,
} = require('../helpers/setup');

const db = useFakeDb();
const { runSimulation, compareScenarios } = load('src/controllers/simulationController.js');

const MANAGER = { id: 4, role: 'manager' };

/** What the Python engine returns for POST /simulate (shape taken from des-engine/des/engine.py). */
function engineResult(counters) {
  const mean = counters === 2 ? 18.85 : 13.47;
  return {
    engine: 'simpy-des',
    avgWaitMinutes: mean,
    p90WaitMinutes: mean + 6,
    metrics: {
      meanWaitMinutes: { mean, ci_low: mean - 1.2, ci_high: mean + 1.2, half_width: 1.2, replications: 5 },
    },
    scenario: { countersOpen: counters },
    disclaimer: 'All figures are simulation estimates, not guaranteed times (FR-04).',
  };
}

function seedDb() {
  db.reset();
  db.poolHandler = async (sql) => {
    if (/AS openCounters/.test(sql)) return [[{ openCounters: 2, staffOnDuty: 2, ordersLastHour: 120 }]];
    if (/INSERT INTO simulation_scenarios/.test(sql)) return [{ insertId: 55 }];
    return [[]];
  };
}

/** Engine stub that answers /simulate according to the countersOpen it is sent. */
const smartEngine = async (url, options) => {
  const body = JSON.parse(options.body);
  return engineReturns(engineResult(body.countersOpen))();
};

const run = (body) => callController(runSimulation, createReq({ body, user: MANAGER }));

// ------------------------------------------------------------------ happy path
test('UT-09 runScenario: 2 counters and 3 counters both return avg wait + confidence interval', async () => {
  await resetDesBreaker();
  const stub = stubFetch(smartEngine);
  try {
    const results = {};
    for (const counters of [2, 3]) {
      seedDb();
      const res = await run({ scenarioName: `${counters} counters`, countersOpen: counters, staffCount: counters, arrivalRatePerHour: 300 });
      assert.equal(res.statusCode, 201, `${counters} counters`);
      results[counters] = res.body.results;

      const wait = res.body.results.metrics.meanWaitMinutes;
      assert.equal(typeof res.body.results.avgWaitMinutes, 'number');
      assert.ok(wait.ci_low < wait.mean && wait.mean < wait.ci_high, 'mean sits inside its CI');
    }
    assert.ok(results[3].avgWaitMinutes < results[2].avgWaitMinutes, 'the extra counter shortens the wait');
  } finally { stub.restore(); }
});

test('UT-09 runScenario: forwards validated numbers to the engine and stores the scenario', async () => {
  await resetDesBreaker();
  seedDb();
  const stub = stubFetch(smartEngine);
  try {
    const res = await run({
      scenarioName: '  Three counters  ', countersOpen: '3', staffCount: '4', arrivalRatePerHour: '280',
      preorderShare: '0.4',
    });
    assert.equal(res.statusCode, 201);

    // sent to the engine as real numbers (strings from the form are coerced), name trimmed
    assert.match(stub.calls[0].url, /\/simulate$/);
    assert.deepEqual(JSON.parse(stub.calls[0].body), {
      countersOpen: 3, staffCount: 4, arrivalRatePerHour: 280, preorderShare: 0.4,
    });
    assert.equal(res.body.scenarioName, 'Three counters');

    // persisted for later comparison (FR-13), against the manager who ran it
    const insert = db.poolCalls.find((c) => /INSERT INTO simulation_scenarios/.test(c.sql));
    assert.ok(insert);
    assert.equal(insert.params[0], MANAGER.id);
    assert.equal(insert.params[1], 'Three counters');
    assert.equal(JSON.parse(insert.params[3]).avgWaitMinutes, 13.47);
    assert.equal(res.body.id, 55);
    assert.deepEqual(res.body.currentConfiguration, { openCounters: 2, staffOnDuty: 2, ordersLastHour: 120 });
  } finally { stub.restore(); }
});

test('UT-09 runScenario: results keep the "estimate, not a promise" disclaimer (FR-04)', async () => {
  await resetDesBreaker();
  seedDb();
  const stub = stubFetch(smartEngine);
  try {
    const res = await run({ scenarioName: 'x', countersOpen: 2, staffCount: 2, arrivalRatePerHour: 300 });
    assert.match(res.body.results.disclaimer, /estimate/i);
  } finally { stub.restore(); }
});

// ------------------------------------------------------------------ validation (engine never called)
test('UT-09 runScenario: invalid forms are rejected with 400 and never reach the engine', async () => {
  const valid = { scenarioName: 'ok', countersOpen: 2, staffCount: 2, arrivalRatePerHour: 300 };
  const invalid = [
    { ...valid, scenarioName: '' },
    { ...valid, scenarioName: 'x'.repeat(101) },
    { ...valid, countersOpen: 0 },
    { ...valid, countersOpen: 21 },
    { ...valid, countersOpen: 'many' },
    { ...valid, staffCount: undefined },
    { ...valid, staffCount: 61 },
    { ...valid, arrivalRatePerHour: 0 },
    { ...valid, arrivalRatePerHour: 3001 },
    { ...valid, preorderShare: 1.5 },
    { ...valid, replications: 2 },
    { ...valid, horizonMinutes: 4 },
  ];
  const stub = stubFetch(smartEngine);
  try {
    for (const body of invalid) {
      seedDb();
      const res = await run(body);
      assert.equal(res.statusCode, 400, `should reject ${JSON.stringify(body).slice(0, 80)}`);
      assert.ok(res.body.message.length > 5, 'tells the manager what is wrong');
    }
    assert.equal(stub.calls.length, 0, 'no engine call was wasted on bad input');
  } finally { stub.restore(); }
});

// ------------------------------------------------------------------ engine failures
test('UT-09 runScenario: engine switched off -> 503 with a hint, nothing stored', async () => {
  await resetDesBreaker();
  seedDb();
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const res = await run({ scenarioName: 'x', countersOpen: 2, staffCount: 2, arrivalRatePerHour: 300 });
    assert.equal(res.statusCode, 503);
    assert.match(res.body.hint, /simulation engine/i);
    assert.ok(res.body.engine, 'breaker status included for the dashboard');
    assert.equal(db.poolCalls.some((c) => /INSERT INTO simulation_scenarios/.test(c.sql)), false);
  } finally { restore(); stub.restore(); }
});

test('UT-09 runScenario: engine rejects the parameters (HTTP 400) -> 400, not 503', async () => {
  await resetDesBreaker();
  seedDb();
  const stub = stubFetch(engineReturns({ message: 'staffCount cannot exceed counters' }, 400));
  try {
    const res = await run({ scenarioName: 'x', countersOpen: 2, staffCount: 2, arrivalRatePerHour: 300 });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.message, /staffCount/);
  } finally { stub.restore(); }
});

// ------------------------------------------------------------------ compare
test('UT-09 compareScenarios: needs between 2 and 6 scenarios', async () => {
  const one = await callController(compareScenarios, createReq({ body: { scenarios: [{ countersOpen: 2 }] }, user: MANAGER }));
  const none = await callController(compareScenarios, createReq({ body: {}, user: MANAGER }));
  const seven = await callController(compareScenarios, createReq({
    body: { scenarios: Array.from({ length: 7 }, () => ({ countersOpen: 2 })) }, user: MANAGER,
  }));
  assert.equal(one.statusCode, 400);
  assert.equal(none.statusCode, 400);
  assert.equal(seven.statusCode, 400);
});

test('UT-09 compareScenarios: 2 counters vs 3 counters is sent to the engine and its answer returned', async () => {
  await resetDesBreaker();
  const payload = { scenarios: [{ countersOpen: 2 }, { countersOpen: 3 }], seed: 7 };
  const comparison = { results: [engineResult(2), engineResult(3)] };
  const stub = stubFetch(engineReturns(comparison));
  try {
    const res = await callController(compareScenarios, createReq({ body: payload, user: MANAGER }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, comparison);
    assert.match(stub.calls[0].url, /\/compare$/);
    assert.deepEqual(JSON.parse(stub.calls[0].body).scenarios, payload.scenarios);
    assert.equal(JSON.parse(stub.calls[0].body).seed, 7, 'same seed -> common random numbers');
  } finally { stub.restore(); }
});

test('UT-09 compareScenarios: engine down -> 503', async () => {
  await resetDesBreaker();
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const res = await callController(compareScenarios, createReq({
      body: { scenarios: [{ countersOpen: 2 }, { countersOpen: 3 }] }, user: MANAGER,
    }));
    assert.equal(res.statusCode, 503);
  } finally { restore(); stub.restore(); }
});
