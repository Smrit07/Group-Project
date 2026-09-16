const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  createOrder,
  getMyOrders,
  getOrderBoard,
  updateOrderStatus,
} = require('../controllers/orderController');

const router = express.Router();

router.post('/', requireAuth, requireRole('student'), createOrder);
router.get('/mine', requireAuth, requireRole('student'), getMyOrders);
router.get('/board', requireAuth, requireRole('staff', 'manager', 'admin'), getOrderBoard);
router.patch('/:id/status', requireAuth, requireRole('staff', 'manager', 'admin'), updateOrderStatus);

module.exports = router;
