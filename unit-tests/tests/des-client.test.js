'use strict';
/**
 * Circuit breaker + timeout behaviour of src/services/desClient.js
 * (report section 4.4 lists "circuit breaker" as a unit-tested item; IT-07 covers it end to end).
 *
 * Requirements: NFR-09 (graceful degradation), NFR-03 (stay fast)
 */
// The breaker/timeout settings are read when the module loads, so set them FIRST.
process.env.DES_FAILURE_THRESHOLD = '3';
process.env.DES_BREAKER_COOLDOWN_MS = '80';
process.env.DES_API_KEY = 'secret-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, stubFetch, engineReturns, engineDown, silenceConsole } = require('../helpers/setup');

const desClient = load('src/services/desClient.js');
const { DesEngineError } = desClient;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const estimate = () => desClient.estimate({ queueLength: 4, openCounters: 2 });

test('breaker: stays closed for the first 2 failures, opens on the 3rd', async () => {
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    for (let i = 1; i <= 2; i += 1) {
      await assert.rejects(estimate, DesEngineError);
      assert.equal(desClient.status().circuitOpen, false, `still closed after ${i} failure(s)`);
    }
    await assert.rejects(estimate, DesEngineError);
    assert.equal(desClient.status().circuitOpen, true, 'open after 3 failures');
    assert.equal(stub.calls.length, 3);
  } finally { restore(); stub.restore(); }
});

test('breaker: while open, calls fail instantly WITHOUT contacting the engine', async () => {
  // breaker is still open from the previous test (cooldown 80 ms - run immediately)
  const stub = stubFetch(engineReturns({ estimatedWaitMinutes: 1 }));
  try {
    await assert.rejects(estimate, (err) => {
      assert.ok(err instanceof DesEngineError);
      assert.equal(err.isUnavailable, true);
      assert.match(err.message, /temporarily bypassed/i);
      return true;
    });
    assert.equal(stub.calls.length, 0, 'fetch must not be called while the breaker is open');
  } finally { stub.restore(); }
});

test('breaker: half-opens after the cooldown and closes again on success', async () => {
  await sleep(120);
  const stub = stubFetch(engineReturns({ estimatedWaitMinutes: 3.2 }));
  try {
    const result = await estimate();
    assert.equal(result.estimatedWaitMinutes, 3.2);
    assert.equal(stub.calls.length, 1, 'one trial request let through');
    assert.equal(desClient.status().circuitOpen, false);
    assert.equal(desClient.status().consecutiveFailures, 0);
  } finally { stub.restore(); }
});

test('breaker: a success in between resets the failure count', async () => {
  const restore = silenceConsole();
  try {
    let stub = stubFetch(engineDown());
    await assert.rejects(estimate); await assert.rejects(estimate);
    stub.restore();

    stub = stubFetch(engineReturns({ estimatedWaitMinutes: 1 }));
    await estimate();
    stub.restore();

    stub = stubFetch(engineDown());
    await assert.rejects(estimate); await assert.rejects(estimate);
    stub.restore();

    assert.equal(desClient.status().circuitOpen, false, '2 + success + 2 is not 3 in a row');
  } finally { restore(); }
});

test('breaker: a parameter error (HTTP 400) is NOT an outage and never opens the breaker', async () => {
  const stub = stubFetch(engineReturns({ message: 'bad number' }, 400));
  try {
    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(estimate, (err) => {
        assert.equal(err.isUnavailable, false);
        assert.equal(err.status, 400);
        assert.equal(err.message, 'bad number');
        return true;
      });
    }
    assert.equal(desClient.status().circuitOpen, false);
  } finally { stub.restore(); }
});

test('breaker: a server error (HTTP 500) counts as unavailable', async () => {
  const stub = stubFetch(engineReturns({}, 500));
  const restore = silenceConsole();
  try {
    await assert.rejects(estimate, (err) => {
      assert.equal(err.isUnavailable, true);
      assert.equal(err.status, 500);
      return true;
    });
  } finally { restore(); stub.restore(); }
});

test('timeout: a stalled engine is reported as "did not respond within 1500ms"', async () => {
  await sleep(120); // let any open breaker cool down
  const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  const stub = stubFetch(async () => { throw timeout; });
  const restore = silenceConsole();
  try {
    await assert.rejects(estimate, /did not respond within 1500ms/);
  } finally { restore(); stub.restore(); }
});

test('request: sends JSON to /estimate with the API key header and a timeout signal', async () => {
  await sleep(120);
  const stub = stubFetch(engineReturns({ estimatedWaitMinutes: 2 }));
  try {
    await desClient.estimate({ queueLength: 9, openCounters: 3 });
    const [call] = stub.calls;
    assert.match(call.url, /\/estimate$/);
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.headers['X-DES-Key'], 'secret-key');
    assert.deepEqual(JSON.parse(call.body), { queueLength: 9, openCounters: 3 });
  } finally { stub.restore(); }
});

test('health: reports available=true / available=false and never throws', async () => {
  let stub = stubFetch(engineReturns({ status: 'ok', modelVersion: 'x' }));
  assert.equal((await desClient.health()).available, true);
  stub.restore();

  stub = stubFetch(engineDown());
  const result = await desClient.health();
  stub.restore();
  assert.equal(result.available, false);
  assert.ok(result.message);
});
