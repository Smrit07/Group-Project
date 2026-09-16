const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getLiveQueue, getQueueHistory } = require('../controllers/queueController');

const router = express.Router();

router.get('/', getLiveQueue); // FR-15: viewable without placing an order
router.get('/history', requireAuth, requireRole('manager', 'admin'), getQueueHistory);

module.exports = router;
