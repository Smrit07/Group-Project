const bcrypt = require('bcryptjs');
const pool = require('../config/db');

// GET /api/users/me — FR-18: a profile limited to the user's own basic
// account details (never another user's data, enforced by req.user.id
// coming from the verified JWT, not from a client-supplied id).
async function getMe(req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT id, full_name, email, role, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Account not found.' });
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/users/me — update your own name and/or password.
// Changing a password requires the current one, so a stolen/left-open
// session token alone can't be used to lock the real owner out.
async function updateMe(req, res, next) {
  try {
    const { fullName, currentPassword, newPassword } = req.body;

    if (fullName) {
      await pool.query('UPDATE users SET full_name = ? WHERE id = ?', [fullName, req.user.id]);
    }

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ message: 'currentPassword is required to set a new password.' });
      }
      const [rows] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
      const matches = await bcrypt.compare(currentPassword, rows[0].password_hash);
      if (!matches) {
        return res.status(401).json({ message: 'Current password is incorrect.' });
      }
      const newHash = await bcrypt.hash(newPassword, 10);
      await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);
    }

    const [updated] = await pool.query(
      'SELECT id, full_name, email, role, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    res.json(updated[0]);
  } catch (err) {
    next(err);
  }
}

// GET /api/users?role=staff — manager/admin only. Used to populate the
// "assign staff to counter" dropdown (NFR-10: staff on duty shall be
// updatable by an administrator without changing program code).
async function listUsers(req, res, next) {
  try {
    const { role } = req.query;
    const allowedRoles = ['student', 'staff', 'manager', 'admin'];
    if (role && !allowedRoles.includes(role)) {
      return res.status(400).json({ message: `role must be one of: ${allowedRoles.join(', ')}` });
    }

    const [rows] = role
      ? await pool.query('SELECT id, full_name, role FROM users WHERE role = ? ORDER BY full_name', [role])
      : await pool.query('SELECT id, full_name, role FROM users ORDER BY full_name');

    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { getMe, updateMe, listUsers };
