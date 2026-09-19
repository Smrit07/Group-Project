const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getMe, updateMe, listUsers } = require('../controllers/userController');

const router = express.Router();

router.get('/me', requireAuth, getMe);
router.patch('/me', requireAuth, updateMe);
router.get('/', requireAuth, requireRole('manager', 'admin'), listUsers);

module.exports = router;
