const pool = require('../config/db');

const DES_ENGINE_URL = process.env.DES_ENGINE_URL || 'http://localhost:5001';

// POST /api/simulations — manager/admin runs a what-if scenario (FR-12)
// body: { scenarioName, countersOpen, staffCount, arrivalRatePerHour }
async function runSimulation(req, res, next) {
  try {
    const { scenarioName, countersOpen, staffCount, arrivalRatePerHour } = req.body;

    if (!scenarioName || !countersOpen || !staffCount || !arrivalRatePerHour) {
      return res.status(400).json({
        message: 'scenarioName, countersOpen, staffCount and arrivalRatePerHour are required.',
      });
    }

    const parameters = { countersOpen, staffCount, arrivalRatePerHour };
    let results;

    try {
      const response = await fetch(`${DES_ENGINE_URL}/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parameters),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('DES engine returned a non-OK status');
      results = await response.json();
    } catch (desError) {
      return res.status(503).json({
        message: 'The simulation engine is not reachable. Make sure des-engine/app.py is running.',
      });
    }

    const [insertResult] = await pool.query(
      'INSERT INTO simulation_scenarios (created_by, scenario_name, parameters, results) VALUES (?, ?, ?, ?)',
      [req.user.id, scenarioName, JSON.stringify(parameters), JSON.stringify(results)]
    );

    res.status(201).json({ id: insertResult.insertId, scenarioName, parameters, results });
  } catch (err) {
    next(err);
  }
}

// GET /api/simulations — history of past scenarios, for comparison (FR-13)
async function listSimulations(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT id, scenario_name, parameters, results, created_at
       FROM simulation_scenarios
       ORDER BY created_at DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { runSimulation, listSimulations };
