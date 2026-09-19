const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  runSimulation,
  compareScenarios,
  listSimulations,
  getEngineStatus,
  deleteSimulation,
} = require('../controllers/simulationController');

const router = express.Router();

// Every route here is manager/admin only. Simulation exposes staffing and
// capacity information that FR-17 keeps away from students, and running one is
// expensive enough that it should not be open to anyone with a login.
router.get('/engine', requireAuth, requireRole('manager', 'admin'), getEngineStatus);
router.post('/compare', requireAuth, requireRole('manager', 'admin'), compareScenarios);
router.post('/', requireAuth, requireRole('manager', 'admin'), runSimulation);
router.get('/', requireAuth, requireRole('manager', 'admin'), listSimulations);
router.delete('/:id', requireAuth, requireRole('manager', 'admin'), deleteSimulation);

module.exports = router;
