const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { runSimulation, listSimulations } = require('../controllers/simulationController');

const router = express.Router();

router.post('/', requireAuth, requireRole('manager', 'admin'), runSimulation);
router.get('/', requireAuth, requireRole('manager', 'admin'), listSimulations);

module.exports = router;
