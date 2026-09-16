const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getSummary } = require('../controllers/reportController');

const router = express.Router();

router.get('/summary', requireAuth, requireRole('manager', 'admin'), getSummary);

module.exports = router;
