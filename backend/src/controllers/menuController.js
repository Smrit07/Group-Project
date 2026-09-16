const pool = require('../config/db');

// GET /api/menu — everyone can view today's available menu (FR-05)
async function listMenu(req, res, next) {
  try {
    const [items] = await pool.query(
      'SELECT id, name, description, price, is_available FROM menu_items ORDER BY name'
    );
    res.json(items);
  } catch (err) {
    next(err);
  }
}

// POST /api/menu — manager/admin only
async function createMenuItem(req, res, next) {
  try {
    const { name, description, price, isAvailable = true } = req.body;
    if (!name || price === undefined) {
      return res.status(400).json({ message: 'name and price are required.' });
    }

    const [result] = await pool.query(
      'INSERT INTO menu_items (name, description, price, is_available) VALUES (?, ?, ?, ?)',
      [name, description || null, price, isAvailable]
    );

    res.status(201).json({ id: result.insertId, name, description, price, isAvailable });
  } catch (err) {
    next(err);
  }
}

// PUT /api/menu/:id — manager/admin only (NFR-10: editable without code changes)
async function updateMenuItem(req, res, next) {
  try {
    const { id } = req.params;
    const { name, description, price, isAvailable } = req.body;

    const [result] = await pool.query(
      `UPDATE menu_items
       SET name = COALESCE(?, name),
           description = COALESCE(?, description),
           price = COALESCE(?, price),
           is_available = COALESCE(?, is_available)
       WHERE id = ?`,
      [name, description, price, isAvailable, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Menu item not found.' });
    }
    res.json({ message: 'Menu item updated.' });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/menu/:id — manager/admin only
async function deleteMenuItem(req, res, next) {
  try {
    const { id } = req.params;
    const [result] = await pool.query('DELETE FROM menu_items WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Menu item not found.' });
    }
    res.json({ message: 'Menu item deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listMenu, createMenuItem, updateMenuItem, deleteMenuItem };
