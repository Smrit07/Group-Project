const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  listMenu,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
} = require('../controllers/menuController');

const router = express.Router();

router.get('/', listMenu); // public within the app — any logged-in role can browse
router.post('/', requireAuth, requireRole('manager', 'admin'), createMenuItem);
router.put('/:id', requireAuth, requireRole('manager', 'admin'), updateMenuItem);
router.delete('/:id', requireAuth, requireRole('manager', 'admin'), deleteMenuItem);

module.exports = router;
