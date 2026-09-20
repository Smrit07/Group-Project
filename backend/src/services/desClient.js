// ---------------------------------------------------------------------------
// Client for the Python/SimPy DES engine (see ../../../des-engine).
// ---------------------------------------------------------------------------
// Every call into the DES engine used to be an inline fetch() inside whichever
// controller needed it, each with its own timeout and its own idea of what to
// do when the engine was down. That is the shape that produces a system where
// the student queue banner hangs for ten seconds because the manager left a
// simulation running.
//
// This module is the single door. It adds three things the inline version
// could not have:
//
//   1. A circuit breaker. NFR-09 requires graceful degradation when the
//      prediction model is unavailable — but "degrade gracefully" implemented
//      as "try, wait for the timeout, then fall back" still costs every single
//      request the full timeout. Once the engine has failed a few times in a
//      row the breaker opens and subsequent calls fail instantly, so the
//      student's page stays fast while the engine is being restarted.
//
//   2. Per-call timeouts that reflect who is waiting. A student staring at a
//      queue banner gets 1.5s; a manager who clicked "run scenario" and
//      expects a progress state gets 25s.
//
//   3. Exactly one place that knows the engine's URL, auth header and JSON
//      shape, so moving the engine to another host is a one-line change.
// ---------------------------------------------------------------------------

const DES_ENGINE_URL = (process.env.DES_ENGINE_URL || 'http://127.0.0.1:5001').replace(/\/+$/, '');
const DES_API_KEY = process.env.DES_API_KEY || '';

// Timeout budgets, in milliseconds.
const TIMEOUTS = {
  estimate: Number(process.env.DES_ESTIMATE_TIMEOUT_MS || 1500),
  simulate: Number(process.env.DES_SIMULATE_TIMEOUT_MS || 25000),
  health: 1200,
};

// Circuit-breaker tuning. Three consecutive failures is deliberately
// forgiving: a single slow first call while Python imports SimPy should not
// take the feature offline for the whole break.
const FAILURE_THRESHOLD = Number(process.env.DES_FAILURE_THRESHOLD || 3);
const OPEN_DURATION_MS = Number(process.env.DES_BREAKER_COOLDOWN_MS || 20000);

const breaker = {
  consecutiveFailures: 0,
  openedAt: 0,
  lastError: null,
  lastSuccessAt: 0,
};

function isOpen() {
  if (breaker.openedAt === 0) return false;
  if (Date.now() - breaker.openedAt >= OPEN_DURATION_MS) {
    // Half-open: let exactly one request through to test the water. If it
    // fails, recordFailure() re-opens the breaker for another cooldown.
    breaker.openedAt = 0;
    breaker.consecutiveFailures = FAILURE_THRESHOLD - 1;
    return false;
  }
  return true;
}

function recordSuccess() {
  breaker.consecutiveFailures = 0;
  breaker.openedAt = 0;
  breaker.lastError = null;
  breaker.lastSuccessAt = Date.now();
}

function recordFailure(err) {
  breaker.consecutiveFailures += 1;
  breaker.lastError = err.message;
  if (breaker.consecutiveFailures >= FAILURE_THRESHOLD) {
    breaker.openedAt = Date.now();
    console.warn(
      `[des] Circuit breaker opened after ${breaker.consecutiveFailures} failures: ${err.message}`
    );
  }
}

/**
 * Raised when the engine is unreachable, times out, or answers with an error.
 * Carries `isUnavailable` so callers can tell "the engine is down" (fall back,
 * or return 503) apart from "the engine rejected your parameters" (a 400 that
 * the manager can fix by editing the form).
 */
class DesEngineError extends Error {
  constructor(message, { status = null, isUnavailable = true, detail = null } = {}) {
    super(message);
    this.name = 'DesEngineError';
    this.status = status;
    this.isUnavailable = isUnavailable;
    this.detail = detail;
  }
}

async function call(path, { method = 'POST', body, timeoutMs, skipBreaker = false } = {}) {
  if (!skipBreaker && isOpen()) {
    throw new DesEngineError(
      'The simulation engine is not responding and has been temporarily bypassed.',
      { isUnavailable: true, detail: breaker.lastError }
    );
  }

  const headers = { 'Content-Type': 'application/json' };
  if (DES_API_KEY) headers['X-DES-Key'] = DES_API_KEY;

  let response;
  try {
    response = await fetch(`${DES_ENGINE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Network-level failure: connection refused (engine not started), DNS,
    // or our own AbortSignal firing. All of these mean "unavailable".
    const message =
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? `The simulation engine did not respond within ${timeoutMs}ms.`
        : `Could not reach the simulation engine at ${DES_ENGINE_URL}.`;
    const wrapped = new DesEngineError(message, { isUnavailable: true, detail: err.message });
    recordFailure(wrapped);
    throw wrapped;
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // A 400 from the engine is a parameter problem, not an outage: the engine
    // is plainly alive, since it answered. Counting it as a breaker failure
    // would let a manager disable the whole feature by typing a bad number
    // three times.
    const isParameterError = response.status >= 400 && response.status < 500;
    const error = new DesEngineError(
      payload.message || `The simulation engine returned HTTP ${response.status}.`,
      { status: response.status, isUnavailable: !isParameterError, detail: payload.detail }
    );
    if (!isParameterError) recordFailure(error);
    else recordSuccess();
    throw error;
  }

  recordSuccess();
  return payload;
}

/**
 * Live wait estimate for the student queue banner.
 *
 * @param {{ queueLength: number, openCounters: number, staffCount?: number }} state
 * @returns {Promise<{ estimatedWaitMinutes: number|null, ... }>}
 */
async function estimate(state) {
  return call('/estimate', { body: state, timeoutMs: TIMEOUTS.estimate });
}

/**
 * Full what-if scenario for the manager dashboard.
 */
async function simulate(scenario) {
  return call('/simulate', { body: scenario, timeoutMs: TIMEOUTS.simulate });
}

/**
 * Several scenarios under common random numbers.
 */
async function compare(payload) {
  return call('/compare', { body: payload, timeoutMs: TIMEOUTS.simulate });
}

/**
 * Liveness check. Bypasses the breaker on purpose — the health endpoint's
 * whole job is to report the true current state, including "it's back".
 */
async function health() {
  try {
    const data = await call('/health', {
      method: 'GET',
      timeoutMs: TIMEOUTS.health,
      skipBreaker: true,
    });
    return { available: true, ...data };
  } catch (err) {
    return { available: false, message: err.message };
  }
}

/** Breaker state, surfaced on /api/health so a failure is visible, not silent. */
function status() {
  return {
    url: DES_ENGINE_URL,
    circuitOpen: isOpen(),
    consecutiveFailures: breaker.consecutiveFailures,
    lastError: breaker.lastError,
    lastSuccessAt: breaker.lastSuccessAt ? new Date(breaker.lastSuccessAt).toISOString() : null,
  };
}

module.exports = { estimate, simulate, compare, health, status, DesEngineError, DES_ENGINE_URL };
