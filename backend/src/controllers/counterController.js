const pool = require('../config/db');

// GET /api/counters — anyone can see which counters are open (FR-05)
async function listCounters(req, res, next) {
  try {
    const [counters] = await pool.query(
      `SELECT c.id, c.name, c.is_open, c.assigned_staff_id, u.full_name AS staff_name
       FROM counters c
       LEFT JOIN users u ON u.id = c.assigned_staff_id
       ORDER BY c.name`
    );
    res.json(counters);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/counters/:id — staff/manager only (FR-11)
async function setCounterStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { isOpen, assignedStaffId } = req.body;

    if (isOpen === undefined) {
      return res.status(400).json({ message: 'isOpen (boolean) is required.' });
    }

    const [result] = await pool.query(
      'UPDATE counters SET is_open = ?, assigned_staff_id = COALESCE(?, assigned_staff_id) WHERE id = ?',
      [isOpen, assignedStaffId, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Counter not found.' });
    }

    // Let connected clients (student queue screen, staff board) know
    // immediately, per NFR-04 (updates without a page refresh).
    req.app.get('io').emit('counters:updated');

    res.json({ message: 'Counter status updated.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listCounters, setCounterStatus };
