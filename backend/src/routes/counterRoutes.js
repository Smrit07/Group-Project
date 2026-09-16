const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { listCounters, setCounterStatus } = require('../controllers/counterController');

const router = express.Router();

router.get('/', listCounters);
router.patch('/:id', requireAuth, requireRole('staff', 'manager', 'admin'), setCounterStatus);

module.exports = router;
