const pool = require('../config/db');
const desClient = require('../services/desClient');
const { estimateWaitMinutes } = require('../utils/waitTimeEstimator');

// ---------------------------------------------------------------------------
// Orders: placement, tracking, the staff board, and status transitions.
// (FR-06 to FR-10)
// ---------------------------------------------------------------------------
// Beyond the CRUD, this controller is where the system earns its own
// calibration data. Every status change writes a timestamp, and completing an
// order writes a row to `service_events`. That is what closes the gap the
// final report admits to in Section 7.1 — a DES model calibrated from a
// handful of stopwatch readings — without anyone having to stand in the
// cafeteria with a clipboard again.
// ---------------------------------------------------------------------------

const VALID_STATUSES = ['received', 'preparing', 'ready', 'completed', 'cancelled'];

// An order status is a state machine, not a free-form string. Allowing any
// value to be set from any other lets a mis-tap on the staff board move a
// collected order back to "preparing", which corrupts both the queue count and
// every service time derived from the timestamps.
const ALLOWED_TRANSITIONS = {
  received: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed'],
  completed: [],
  cancelled: [],
};

// Which column records each transition. Nullable columns, written once, rather
// than relying on updated_at — which is overwritten at every change, so by the
// time an order is completed the moment it entered preparation is gone.
const TRANSITION_TIMESTAMPS = {
  preparing: 'preparing_at',
  ready: 'ready_at',
  completed: 'completed_at',
};

// ---------------------------------------------------------------------------
// Placing an order
// ---------------------------------------------------------------------------

// POST /api/orders — a student places a pre-order (
// body: { items: [{ menuItemId, quantity }] }
async function createOrder(req, res, next) {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'items must be a non-empty array.' });
  }
  if (items.length > 20) {
    return res.status(400).json({ message: 'An order cannot contain more than 20 line items.' });
  }

  // Normalise and validate quantities before opening a transaction, so a malformed request never holds a connection.
  const normalised = [];
  for (const item of items) {
    const menuItemId = Number(item.menuItemId);
    const quantity = Number(item.quantity ?? 1);
    if (!Number.isInteger(menuItemId) || menuItemId <= 0) {
      return res.status(400).json({ message: 'Each item needs a valid menuItemId.' });
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      return res.status(400).json({ message: 'Each quantity must be a whole number from 1 to 20.' });
    }
    normalised.push({ menuItemId, quantity });
  }

  // Merge duplicate lines: two separate "1 x Milk Tea" entries should become
  // one line of 2, or the order board shows the same item twice and the staff
  // member has to add them up in their head.
  const merged = new Map();
  for (const item of normalised) {
    merged.set(item.menuItemId, (merged.get(item.menuItemId) || 0) + item.quantity);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const menuItemIds = [...merged.keys()];
    const placeholders = menuItemIds.map(() => '?').join(',');
    // FOR UPDATE: locks the menu rows for the life of the transaction, so an
    // admin marking an item unavailable mid-checkout cannot interleave between
    // the availability check and the insert.
    const [menuRows] = await connection.query(
      `SELECT id, name, price, is_available FROM menu_items WHERE id IN (${placeholders}) FOR UPDATE`,
      menuItemIds
    );
    const menuById = new Map(menuRows.map((row) => [row.id, row]));

    for (const menuItemId of menuItemIds) {
      const menuItem = menuById.get(menuItemId);
      if (!menuItem) {
        await connection.rollback();
        return res.status(400).json({ message: `Menu item ${menuItemId} does not exist.` });
      }
      if (!menuItem.is_available) {
        await connection.rollback();
        return res
          .status(409)
          .json({ message: `"${menuItem.name}" has just sold out — please remove it and try again.` });
      }
    }

    // Prices come from the database, never from the client. A price posted by
    // the browser is a price the student chose.
    let totalAmount = 0;
    for (const [menuItemId, quantity] of merged) {
      totalAmount += Number(menuById.get(menuItemId).price) * quantity;
    }

    const [[state]] = await connection.query(
      `SELECT
         (SELECT COUNT(*) FROM orders   WHERE status IN ('received', 'preparing')) AS queueLength,
         (SELECT COUNT(*) FROM counters WHERE is_open = TRUE)                      AS openCounters`
    );

    const waitMinutes = await predictWaitMinutes(state);
    const estimatedPickup = waitMinutes === null ? null : new Date(Date.now() + waitMinutes * 60000);

    const [orderResult] = await connection.query(
      `INSERT INTO orders (student_id, status, is_preorder, total_amount, estimated_pickup_time)
       VALUES (?, 'received', TRUE, ?, ?)`,
      [req.user.id, totalAmount.toFixed(2), estimatedPickup]
    );
    const orderId = orderResult.insertId;

    // One multi-row INSERT rather than one per line: a four-item order was
    // previously four round trips inside an open transaction.
    const itemValues = [];
    const itemParams = [];
    for (const [menuItemId, quantity] of merged) {
      itemValues.push('(?, ?, ?, ?)');
      itemParams.push(orderId, menuItemId, quantity, menuById.get(menuItemId).price);
    }
    await connection.query(
      `INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price)
       VALUES ${itemValues.join(', ')}`,
      itemParams
    );

    await connection.commit();

    // Push to the staff order board in real time (NFR-04).
    req.app.get('io').emit('orders:new', { orderId, studentId: req.user.id });

    res.status(201).json({
      orderId,
      status: 'received',
      totalAmount: Number(totalAmount.toFixed(2)),
      estimatedPickupTime: estimatedPickup,
      estimatedWaitMinutes: waitMinutes,
      isEstimate: true, // FR-04
    });
  } catch (err) {
    await connection.rollback().catch(() => {});
    next(err);
  } finally {
    connection.release();
  }
}

/**
 * Best available wait prediction, DES first.
 *
 * The estimated pickup time a student is shown at checkout is the promise the
 * system is making, so it should come from the same model as the banner they
 * looked at thirty seconds earlier. Falling back silently to the crude formula
 * is fine; falling back to a *different* number than the banner showed is not,
 * which is why both paths go through the same client and the same estimator.
 */
async function predictWaitMinutes(state) {
  const queueLength = Number(state.queueLength) || 0;
  const openCounters = Number(state.openCounters) || 0;

  try {
    const result = await desClient.estimate({ queueLength, openCounters });
    if (result && result.estimatedWaitMinutes !== undefined) {
      return result.estimatedWaitMinutes;
    }
  } catch {
    // Engine unavailable — the circuit breaker in desClient has already
    // logged it; fall through to the arithmetic estimate (NFR-09).
  }
  return estimateWaitMinutes(queueLength, openCounters);
}

// ---------------------------------------------------------------------------
// Reading orders
// ---------------------------------------------------------------------------

/** Attach line items to a set of orders in one query instead of one each. */
async function attachItems(orders) {
  if (orders.length === 0) return orders;

  const ids = orders.map((order) => order.id);
  const [items] = await pool.query(
    `SELECT oi.order_id, mi.name, oi.quantity, oi.unit_price
     FROM order_items oi
     JOIN menu_items mi ON mi.id = oi.menu_item_id
     WHERE oi.order_id IN (${ids.map(() => '?').join(',')})
     ORDER BY oi.id`,
    ids
  );

  const byOrder = new Map(ids.map((id) => [id, []]));
  for (const item of items) {
    byOrder.get(item.order_id).push({
      name: item.name,
      quantity: item.quantity,
      unit_price: item.unit_price,
    });
  }
  for (const order of orders) {
    order.items = byOrder.get(order.id) || [];
  }
  return orders;
}

// GET /api/orders/mine — a student's own orders (FR-07, NFR-05)
// Never returns anyone else's order, at any role: a student's history is the
// one thing FR-17 and NFR-06 are most explicit about.
async function getMyOrders(req, res, next) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);

    const [orders] = await pool.query(
      `SELECT o.id, o.status, o.is_preorder, o.total_amount, o.estimated_pickup_time,
              o.preparing_at, o.ready_at, o.completed_at, o.created_at,
              c.name AS counter_name
       FROM orders o
       LEFT JOIN counters c ON c.id = o.counter_id
       WHERE o.student_id = ?
       ORDER BY o.created_at DESC
       LIMIT ?`,
      [req.user.id, limit]
    );

    res.json(await attachItems(orders));
  } catch (err) {
    next(err);
  }
}

// GET /api/orders/board — the staff order board (FR-09)
// Ordered by arrival time, as the staff interview in Section 4.1 asked for:
// first in, first served, with no way for the board to reorder itself under a
// staff member mid-shift.
async function getOrderBoard(req, res, next) {
  try {
    const [orders] = await pool.query(
      `SELECT o.id, o.status, o.counter_id, o.is_preorder, o.total_amount,
              o.created_at, o.preparing_at, o.ready_at,
              u.full_name AS student_name,
              c.name AS counter_name,
              TIMESTAMPDIFF(SECOND, o.created_at, NOW()) AS age_seconds
       FROM orders o
       JOIN users u ON u.id = o.student_id
       LEFT JOIN counters c ON c.id = o.counter_id
       WHERE o.status IN ('received', 'preparing', 'ready')
       ORDER BY o.created_at ASC`
    );

    res.json(await attachItems(orders));
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

// PATCH /api/orders/:id/status — staff/manager advances an order (FR-10)
async function updateOrderStatus(req, res, next) {
  const orderId = Number(req.params.id);
  const status = req.body.status;
  const counterId = req.body.counterId === undefined ? null : Number(req.body.counterId);

  if (!Number.isInteger(orderId) || orderId <= 0) {
    return res.status(400).json({ message: 'Invalid order id.' });
  }
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ message: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Lock the row: two staff members tapping "Ready" on the same order at the
    // same moment would otherwise both succeed, and both write a ready_at.
    const [[order]] = await connection.query(
      'SELECT id, status, student_id, counter_id, is_preorder, preparing_at, ready_at FROM orders WHERE id = ? FOR UPDATE',
      [orderId]
    );

    if (!order) {
      await connection.rollback();
      return res.status(404).json({ message: 'Order not found.' });
    }

    if (order.status === status) {
      await connection.rollback();
      return res.json({ message: 'Order was already in that state.', orderId, status });
    }

    const allowed = ALLOWED_TRANSITIONS[order.status] || [];
    if (!allowed.includes(status)) {
      await connection.rollback();
      return res.status(409).json({
        message:
          `An order that is "${order.status}" cannot move to "${status}". ` +
          (allowed.length ? `Valid next steps: ${allowed.join(', ')}.` : 'This order is finished.'),
      });
    }

    const timestampColumn = TRANSITION_TIMESTAMPS[status];
    const sets = ['status = ?'];
    const params = [status];

    if (timestampColumn) {
      // COALESCE so a replayed transition never rewrites history.
      sets.push(`${timestampColumn} = COALESCE(${timestampColumn}, NOW())`);
    }
    if (Number.isInteger(counterId) && counterId > 0) {
      sets.push('counter_id = ?');
      params.push(counterId);
    }

    params.push(orderId);
    await connection.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, params);

    // Completing an order is the moment its true service time is known, so
    // that is when the calibration sample gets a row. Derived inside the same
    // transaction as the status change, so the two can never disagree.
    if (status === 'completed') {
      await recordServiceEvent(connection, orderId);
    }

    await connection.commit();

    // FR-08 (ready notification) and NFR-04 (no page refresh). studentId is
    // included so the client can tell "my order" from "an order" without a
    // second request.
    req.app.get('io').emit('orders:statusChanged', {
      orderId,
      status,
      studentId: order.student_id,
    });

    res.json({ message: 'Order status updated.', orderId, status, previousStatus: order.status });
  } catch (err) {
    await connection.rollback().catch(() => {});
    next(err);
  } finally {
    connection.release();
  }
}

/**
 * Write one row to the DES calibration sample.
 *
 * Service time is measured from `preparing_at` to `ready_at` — the interval a
 * counter was actually occupied by this order. Deliberately NOT created_at to
 * completed_at, which includes both the queueing before service and however
 * long the student took to wander over and collect it; feeding that into the
 * model as "service time" would inflate it badly and make the simulation
 * predict waits several times worse than reality.
 */
async function recordServiceEvent(connection, orderId) {
  try {
    await connection.query(
      `INSERT INTO service_events (order_id, counter_id, is_pickup, service_seconds, source)
       SELECT o.id,
              o.counter_id,
              o.is_preorder,
              TIMESTAMPDIFF(SECOND, o.preparing_at, o.ready_at),
              'system'
       FROM orders o
       WHERE o.id = ?
         AND o.preparing_at IS NOT NULL
         AND o.ready_at IS NOT NULL
         -- Guard against clock skew and against staff who batch-press the
         -- buttons at the end of a shift: a "service" under 5 seconds or over
         -- an hour is a data-entry artefact, not an observation, and letting
         -- it into the sample would distort the fitted distribution.
         AND TIMESTAMPDIFF(SECOND, o.preparing_at, o.ready_at) BETWEEN 5 AND 3600`,
      [orderId]
    );
  } catch (err) {
    // Calibration data is valuable but not worth failing a staff member's tap
    // over. Log loudly; the order still completes.
    console.warn(`[orders] Could not record service event for order ${orderId}:`, err.message);
  }
}

// POST /api/orders/walk-in — staff log a customer served at the counter with
// no app order (manager/staff only).
//
// Without this, `is_preorder` is always true and the reported "pre-order
// adoption" metric from Section 6.3 is a meaningless 100%. It also gives the
// DES model walk-in service times, which are the slow ones that actually drive
// the queue.
async function recordWalkIn(req, res, next) {
  try {
    const serviceSeconds = Number(req.body.serviceSeconds);
    const counterId = req.body.counterId ? Number(req.body.counterId) : null;
    const queueOnArrival = req.body.queueOnArrival === undefined ? null : Number(req.body.queueOnArrival);

    if (!Number.isFinite(serviceSeconds) || serviceSeconds < 5 || serviceSeconds > 3600) {
      return res
        .status(400)
        .json({ message: 'serviceSeconds must be a number between 5 and 3600.' });
    }

    const [result] = await pool.query(
      `INSERT INTO service_events (counter_id, is_pickup, service_seconds, queue_on_arrival, source)
       VALUES (?, FALSE, ?, ?, 'manual_observation')`,
      [counterId, serviceSeconds, queueOnArrival]
    );

    res.status(201).json({ id: result.insertId, message: 'Observation recorded.' });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createOrder,
  getMyOrders,
  getOrderBoard,
  updateOrderStatus,
  recordWalkIn,
  VALID_STATUSES,
};
