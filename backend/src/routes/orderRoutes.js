const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  createOrder,
  getMyOrders,
  getOrderBoard,
  updateOrderStatus,
  recordWalkIn,
} = require('../controllers/orderController');

const router = express.Router();

router.post('/', requireAuth, requireRole('student'), createOrder);
router.get('/mine', requireAuth, requireRole('student'), getMyOrders);
router.get('/board', requireAuth, requireRole('staff', 'manager', 'admin'), getOrderBoard);
router.patch('/:id/status', requireAuth, requireRole('staff', 'manager', 'admin'), updateOrderStatus);

// Staff log a counter customer who did not order through the app. This is what
// keeps the "pre-order adoption" metric honest and gives the DES model the
// slower walk-in service times that actually drive the queue.
router.post('/walk-in', requireAuth, requireRole('staff', 'manager', 'admin'), recordWalkIn);

module.exports = router;
