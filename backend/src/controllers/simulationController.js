const pool = require('../config/db');
const desClient = require('../services/desClient');

// ---------------------------------------------------------------------------
// What-if scenarios (FR-12, FR-13).
// ---------------------------------------------------------------------------
// The manager interview in Section 4.1 of the report asked for one specific
// thing: a way to test staffing changes without disrupting real service. That
// means this controller's job is not "proxy a request to Python" — it is to
// take a form with three numbers on it, fill in everything else from what the
// cafeteria is actually doing today, run it, and store the result so two
// scenarios can be compared next week.
// ---------------------------------------------------------------------------

const MAX_SCENARIO_NAME = 100;

/**
 * Parse and range-check the manager's form.
 *
 * Validation happens here as well as in the Python engine on purpose: the
 * engine's message is about model parameters, while this one can name the
 * field on the form the manager is looking at. Rejecting early also avoids
 * spending a 25-second timeout budget discovering that staffCount was blank.
 */
function parseScenario(body) {
  const errors = [];

  const scenarioName = String(body.scenarioName || '').trim();
  if (!scenarioName) errors.push('Give the scenario a name so you can find it again later.');
  if (scenarioName.length > MAX_SCENARIO_NAME) {
    errors.push(`Scenario name must be ${MAX_SCENARIO_NAME} characters or fewer.`);
  }

  const asNumber = (value, field, { min, max, required = true, fallback = null }) => {
    if (value === undefined || value === null || value === '') {
      if (required) errors.push(`${field} is required.`);
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      errors.push(`${field} must be a number.`);
      return fallback;
    }
    if (parsed < min || parsed > max) {
      errors.push(`${field} must be between ${min} and ${max}.`);
      return fallback;
    }
    return parsed;
  };

  const countersOpen = asNumber(body.countersOpen, 'Counters open', { min: 1, max: 20 });
  const staffCount = asNumber(body.staffCount, 'Staff count', { min: 1, max: 60 });
  const arrivalRatePerHour = asNumber(body.arrivalRatePerHour, 'Arrivals per hour', {
    min: 1,
    max: 3000,
  });

  // Optional refinements. A manager who only fills in the three required
  // fields gets a sensible run; one who wants to model "what if half of them
  // pre-order" can say so.
  const preorderShare = asNumber(body.preorderShare, 'Pre-order share', {
    min: 0,
    max: 1,
    required: false,
  });
  const replications = asNumber(body.replications, 'Replications', {
    min: 3,
    max: 200,
    required: false,
  });
  const horizonMinutes = asNumber(body.horizonMinutes, 'Break length in minutes', {
    min: 5,
    max: 600,
    required: false,
  });

  if (errors.length) {
    const error = new Error(errors.join(' '));
    error.status = 400;
    throw error;
  }

  return {
    scenarioName,
    parameters: {
      countersOpen,
      staffCount,
      arrivalRatePerHour,
      ...(preorderShare === null ? {} : { preorderShare }),
      ...(replications === null ? {} : { replications }),
      ...(horizonMinutes === null ? {} : { horizonMinutes }),
    },
  };
}

/**
 * Today's actual configuration, used to fill in whatever the manager left
 * blank and — more usefully — to show the scenario against the status quo.
 * "3 counters gives a 4-minute wait" is a fact; "3 counters gives a 4-minute
 * wait, against the 2 you have open now" is a decision.
 */
async function readCurrentConfiguration() {
  try {
    const [[row]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM counters WHERE is_open = TRUE)            AS openCounters,
         (SELECT COUNT(DISTINCT assigned_staff_id) FROM counters
            WHERE is_open = TRUE AND assigned_staff_id IS NOT NULL)      AS staffOnDuty,
         (SELECT COUNT(*) FROM orders
            WHERE created_at >= (NOW() - INTERVAL 1 HOUR))               AS ordersLastHour`
    );
    return {
      openCounters: Number(row.openCounters) || 0,
      staffOnDuty: Number(row.staffOnDuty) || 0,
      ordersLastHour: Number(row.ordersLastHour) || 0,
    };
  } catch (err) {
    // Context is a nice-to-have; never fail the simulation over it.
    console.warn('[simulations] Could not read current configuration:', err.message);
    return null;
  }
}

// POST /api/simulations — run and store a what-if scenario (FR-12)
async function runSimulation(req, res, next) {
  try {
    const { scenarioName, parameters } = parseScenario(req.body);
    const current = await readCurrentConfiguration();

    let results;
    try {
      results = await desClient.simulate(parameters);
    } catch (err) {
      if (err.name === 'DesEngineError') {
        // Two genuinely different failures, and conflating them is what makes
        // this feature frustrating to use: a bad parameter is the manager's to
        // fix (400), an engine that is not running is ours (503).
        if (!err.isUnavailable) {
          return res.status(400).json({ message: err.message });
        }
        return res.status(503).json({
          message: err.message,
          hint:
            'Start the simulation engine: open a terminal in des-engine/ and run ' +
            '"python app.py" (or use deploy/start-smart-cafeteria.bat, which starts it for you).',
          engine: desClient.status(),
        });
      }
      throw err;
    }

    // Persist so scenarios can be compared over time (FR-13). The stored
    // `parameters` are the ones the engine actually resolved, not the sparse
    // form values, so a scenario re-read in a month is reproducible.
    const storedParameters = { ...parameters, resolved: results.scenario || null };

    const [insert] = await pool.query(
      `INSERT INTO simulation_scenarios (created_by, scenario_name, parameters, results)
       VALUES (?, ?, ?, ?)`,
      [req.user.id, scenarioName, JSON.stringify(storedParameters), JSON.stringify(results)]
    );

    res.status(201).json({
      id: insert.insertId,
      scenarioName,
      parameters: storedParameters,
      results,
      currentConfiguration: current,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/simulations/compare — several configurations side by side.
//
// Not stored: this is an exploratory tool for the moment of deciding, and
// writing a row for every slider drag would bury the scenarios the manager
// actually cared about under dozens they did not.
async function compareScenarios(req, res, next) {
  try {
    const scenarios = Array.isArray(req.body.scenarios) ? req.body.scenarios : [];
    if (scenarios.length < 2) {
      return res.status(400).json({ message: 'Provide at least two scenarios to compare.' });
    }
    if (scenarios.length > 6) {
      return res.status(400).json({ message: 'You can compare at most six scenarios at once.' });
    }

    const results = await desClient.compare({
      scenarios,
      seed: req.body.seed,
      replications: req.body.replications,
    });
    res.json(results);
  } catch (err) {
    if (err.name === 'DesEngineError') {
      const status = err.isUnavailable ? 503 : 400;
      return res.status(status).json({ message: err.message, engine: desClient.status() });
    }
    next(err);
  }
}

// GET /api/simulations — history, most recent first (FR-13)
async function listSimulations(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 200);

    const [rows] = await pool.query(
      `SELECT s.id, s.scenario_name, s.parameters, s.results, s.created_at, u.full_name AS created_by_name
       FROM simulation_scenarios s
       LEFT JOIN users u ON u.id = s.created_by
       ORDER BY s.created_at DESC
       LIMIT ?`,
      [limit]
    );

    // Flatten the headline numbers out of the stored JSON so the dashboard can
    // render a comparison table without every client re-implementing the same
    // defensive digging through a nested blob.
    const summarised = rows.map((row) => {
      const results = typeof row.results === 'string' ? safeParse(row.results) : row.results;
      const parameters = typeof row.parameters === 'string' ? safeParse(row.parameters) : row.parameters;
      return {
        id: row.id,
        scenarioName: row.scenario_name,
        createdAt: row.created_at,
        createdByName: row.created_by_name,
        parameters,
        headline: results
          ? {
              avgWaitMinutes: results.avgWaitMinutes ?? null,
              p90WaitMinutes: results.p90WaitMinutes ?? null,
              maxQueueLength: results.maxQueueLength ?? null,
              counterUtilisationPercent: results.counterUtilisationPercent ?? null,
              balkRatePercent: results.balkRatePercent ?? null,
              rating: results.verdict ? results.verdict.rating : null,
            }
          : null,
        results,
      };
    });

    res.json(summarised);
  } catch (err) {
    next(err);
  }
}

// GET /api/simulations/engine — is the DES engine up? Lets the dashboard show
// "simulation unavailable" up front rather than after a failed submit.
async function getEngineStatus(req, res, next) {
  try {
    const health = await desClient.health();
    res.json({ ...health, breaker: desClient.status() });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/simulations/:id — tidy up the scenario list (manager/admin only)
async function deleteSimulation(req, res, next) {
  try {
    const [result] = await pool.query('DELETE FROM simulation_scenarios WHERE id = ?', [
      req.params.id,
    ]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Scenario not found.' });
    }
    res.json({ message: 'Scenario deleted.' });
  } catch (err) {
    next(err);
  }
}

function safeParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

module.exports = {
  runSimulation,
  compareScenarios,
  listSimulations,
  getEngineStatus,
  deleteSimulation,
};
