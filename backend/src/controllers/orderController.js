const pool = require('../config/db');
const { estimateWaitMinutes } = require('../utils/waitTimeEstimator');

const VALID_STATUSES = ['received', 'preparing', 'ready', 'completed'];

// POST /api/orders — a student places a pre-order (FR-06)
// body: { items: [{ menuItemId, quantity }] }
async function createOrder(req, res, next) {
  const connection = await pool.getConnection();
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'items must be a non-empty array.' });
    }

    await connection.beginTransaction();

    // Look up current prices server-side — never trust a price sent by the client.
    const menuItemIds = items.map((i) => i.menuItemId);
    const [menuRows] = await connection.query(
      `SELECT id, price, is_available FROM menu_items WHERE id IN (${menuItemIds.map(() => '?').join(',')})`,
      menuItemIds
    );
    const menuById = Object.fromEntries(menuRows.map((row) => [row.id, row]));

    for (const item of items) {
      const menuItem = menuById[item.menuItemId];
      if (!menuItem || !menuItem.is_available) {
        await connection.rollback();
        return res.status(400).json({ message: `Menu item ${item.menuItemId} is not available.` });
      }
    }

    const [openCountersRows] = await connection.query(
      'SELECT COUNT(*) AS openCounters FROM counters WHERE is_open = TRUE'
    );
    const [queueRows] = await connection.query(
      "SELECT COUNT(*) AS queueLength FROM orders WHERE status IN ('received', 'preparing')"
    );
    const waitMinutes = estimateWaitMinutes(
      queueRows[0].queueLength,
      openCountersRows[0].openCounters
    );
    const estimatedPickup = waitMinutes
      ? new Date(Date.now() + waitMinutes * 60 * 1000)
      : null;

    const [orderResult] = await connection.query(
      'INSERT INTO orders (student_id, status, estimated_pickup_time) VALUES (?, ?, ?)',
      [req.user.id, 'received', estimatedPickup]
    );
    const orderId = orderResult.insertId;

    for (const item of items) {
      const menuItem = menuById[item.menuItemId];
      await connection.query(
        'INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES (?, ?, ?, ?)',
        [orderId, item.menuItemId, item.quantity || 1, menuItem.price]
      );
    }

    await connection.commit();

    // Push to the staff order board in real time (NFR-04).
    req.app.get('io').emit('orders:new', { orderId });

    res.status(201).json({ orderId, status: 'received', estimatedPickupTime: estimatedPickup });
  } catch (err) {
    await connection.rollback();
    next(err);
  } finally {
    connection.release();
  }
}

// GET /api/orders/mine — a student's own order history/status (FR-07, NFR-05)
async function getMyOrders(req, res, next) {
  try {
    const [orders] = await pool.query(
      `SELECT o.id, o.status, o.estimated_pickup_time, o.created_at
       FROM orders o
       WHERE o.student_id = ?
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );

    // Attach line items for each order.
    for (const order of orders) {
      const [items] = await pool.query(
        `SELECT mi.name, oi.quantity, oi.unit_price
         FROM order_items oi
         JOIN menu_items mi ON mi.id = oi.menu_item_id
         WHERE oi.order_id = ?`,
        [order.id]
      );
      order.items = items;
    }

    res.json(orders);
  } catch (err) {
    next(err);
  }
}

// GET /api/orders/board — staff order board: all active orders (FR-09)
async function getOrderBoard(req, res, next) {
  try {
    const [orders] = await pool.query(
      `SELECT o.id, o.status, o.counter_id, o.created_at, u.full_name AS student_name
       FROM orders o
       JOIN users u ON u.id = o.student_id
       WHERE o.status IN ('received', 'preparing', 'ready')
       ORDER BY o.created_at ASC`
    );
    res.json(orders);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/orders/:id/status — staff/manager updates order status (FR-10)
async function updateOrderStatus(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const [result] = await pool.query('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Order not found.' });
    }

    // Notify the student's client the moment it's ready (FR-08) and
    // refresh the staff board for everyone else (NFR-04).
    req.app.get('io').emit('orders:statusChanged', { orderId: Number(id), status });

    res.json({ message: 'Order status updated.', orderId: Number(id), status });
  } catch (err) {
    next(err);
  }
}

module.exports = { createOrder, getMyOrders, getOrderBoard, updateOrderStatus };
