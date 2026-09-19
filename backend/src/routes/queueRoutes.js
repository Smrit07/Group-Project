const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  getLiveQueue,
  getQueueHistory,
  getPredictionAccuracy,
} = require('../controllers/queueController');

const router = express.Router();

// Public: FR-15 requires the live queue to be viewable without placing an
// order — and, in practice, without logging in, since the whole point is to
// check before you walk over.
router.get('/', getLiveQueue);

// Historical data is management reporting, so it is role-restricted.
router.get('/history', requireAuth, requireRole('manager', 'admin'), getQueueHistory);
router.get('/accuracy', requireAuth, requireRole('manager', 'admin'), getPredictionAccuracy);

module.exports = router;
