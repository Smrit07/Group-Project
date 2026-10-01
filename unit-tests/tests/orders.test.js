'use strict';
/**
 * UT-05  placeOrder(student, items)     - valid items, student logged in -> status "received" + pickup estimate
 * UT-06  updateOrderStatus(id, next)    - received -> preparing -> status updated, preparing_at set
 * UT-07  updateOrderStatus(id, next)    - completed -> preparing (illegal) -> rejected by the state machine
 *
 * Requirements: FR-06, FR-07, FR-08, FR-10
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  useFakeDb, load, createReq, callController, liveStateFromSql,
  stubFetch, engineReturns, engineDown, resetDesBreaker, silenceConsole,
} = require('../helpers/setup');

const db = useFakeDb();
const { createOrder, updateOrderStatus } = load('src/controllers/orderController.js');

const STUDENT = { id: 7, role: 'student', email: 'student@nami.test' };

// ====================================================================== UT-05 placeOrder
const MENU = [
  { id: 1, name: 'Momo', price: 150, is_available: 1 },
  { id: 2, name: 'Milk Tea', price: 80, is_available: 1 },
  { id: 3, name: 'Chowmein', price: 120, is_available: 0 }, // sold out
];

/** Fake DB for the order-placement transaction. */
function seedOrderPlacement({ orders = [], counters = [{ is_open: true }, { is_open: true }] } = {}) {
  db.reset();
  const inserted = { order: null, items: null };
  db.txHandler = async (sql, params) => {
    if (/FROM menu_items/.test(sql)) return [MENU.filter((m) => params.includes(m.id))];
    if (/AS queueLength/.test(sql)) return [[liveStateFromSql(sql, { orders, counters })]];
    if (/INSERT INTO orders/.test(sql)) { inserted.order = { sql, params }; return [{ insertId: 42 }]; }
    if (/INSERT INTO order_items/.test(sql)) { inserted.items = { sql, params }; return [{ affectedRows: 1 }]; }
    return [[]];
  };
  return inserted;
}

async function place(items, user = STUDENT) {
  const req = createReq({ body: { items }, user });
  const res = await callController(createOrder, req);
  return { res, req };
}

test('UT-05 placeOrder: valid items -> status "received" plus a pickup estimate (engine down, fallback formula)', async () => {
  const inserted = seedOrderPlacement({
    orders: [{ status: 'received' }, { status: 'preparing' }], // 2 ahead in the queue
  });
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const before = Date.now();
    const { res } = await place([{ menuItemId: 1, quantity: 2 }, { menuItemId: 2, quantity: 1 }]);

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.orderId, 42);
    assert.equal(res.body.status, 'received');
    assert.equal(res.body.isEstimate, true, 'FR-04: pickup time is an estimate');
    assert.equal(res.body.estimatedWaitMinutes, 2.5); // 2 ahead / 2 counters * 2.5 min
    assert.ok(res.body.estimatedPickupTime instanceof Date);
    assert.ok(res.body.estimatedPickupTime.getTime() > before, 'pickup estimate is in the future');

    assert.equal(inserted.order.params[0], STUDENT.id, 'order belongs to the logged-in student');
    assert.match(inserted.order.sql, /'received'/, 'inserted with status received');
  } finally { restore(); stub.restore(); }
});

test('UT-05 placeOrder: pickup estimate comes from the DES engine when it is available', async () => {
  await resetDesBreaker();
  seedOrderPlacement();
  const stub = stubFetch(engineReturns({ estimatedWaitMinutes: 6.5, confidence: 'high' }));
  try {
    const { res } = await place([{ menuItemId: 1, quantity: 1 }]);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.estimatedWaitMinutes, 6.5);
    assert.ok(res.body.estimatedPickupTime instanceof Date);
  } finally { stub.restore(); }
});

test('UT-05 placeOrder: total is calculated from DATABASE prices, never from the client', async () => {
  seedOrderPlacement();
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    // The browser claims everything costs Rs 1.
    const { res } = await place([
      { menuItemId: 1, quantity: 2, price: 1 },
      { menuItemId: 2, quantity: 1, price: 1 },
    ]);
    assert.equal(res.body.totalAmount, 2 * 150 + 1 * 80);
  } finally { restore(); stub.restore(); }
});

test('UT-05 placeOrder: committed in one transaction and the staff board is notified live (NFR-04)', async () => {
  seedOrderPlacement();
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const { res, req } = await place([{ menuItemId: 2, quantity: 1 }]);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(db.tx, { began: 1, committed: 1, rolledBack: 0, released: 1 });
    assert.deepEqual(req.emitted, [{ event: 'orders:new', payload: { orderId: 42, studentId: STUDENT.id } }]);
  } finally { restore(); stub.restore(); }
});

test('UT-05 placeOrder: duplicate lines for the same item are merged into one line', async () => {
  const inserted = seedOrderPlacement();
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const { res } = await place([{ menuItemId: 2, quantity: 1 }, { menuItemId: 2, quantity: 1 }]);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.totalAmount, 160);
    // single (order_id, menu_item_id, quantity, unit_price) tuple
    assert.deepEqual(inserted.items.params, [42, 2, 2, 80]);
  } finally { restore(); stub.restore(); }
});

test('UT-05 placeOrder: no counters open -> order still accepted, but no pickup time is invented', async () => {
  seedOrderPlacement({ counters: [{ is_open: false }] });
  const stub = stubFetch(engineDown());
  const restore = silenceConsole();
  try {
    const { res } = await place([{ menuItemId: 1, quantity: 1 }]);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.status, 'received');
    assert.equal(res.body.estimatedPickupTime, null);
  } finally { restore(); stub.restore(); }
});

test('UT-05 placeOrder: rejects bad input with 400 before touching the database', async () => {
  const bad = [
    [],                                                        // empty
    'momo',                                                    // not an array
    [{ menuItemId: 'abc', quantity: 1 }],                      // bad id
    [{ menuItemId: -3, quantity: 1 }],                         // negative id
    [{ menuItemId: 1, quantity: 0 }],                          // quantity too low
    [{ menuItemId: 1, quantity: 21 }],                         // quantity too high
    [{ menuItemId: 1, quantity: 1.5 }],                        // not whole
    Array.from({ length: 21 }, (_, i) => ({ menuItemId: i + 1, quantity: 1 })), // > 20 lines
  ];
  for (const items of bad) {
    seedOrderPlacement();
    const { res } = await place(items);
    assert.equal(res.statusCode, 400, `should reject ${JSON.stringify(items).slice(0, 60)}`);
    assert.equal(db.tx.began, 0, 'no transaction opened for invalid input');
  }
});

test('UT-05 placeOrder: sold-out item -> 409, rolled back, nothing inserted', async () => {
  const inserted = seedOrderPlacement();
  const { res } = await place([{ menuItemId: 1, quantity: 1 }, { menuItemId: 3, quantity: 1 }]);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /Chowmein/);
  assert.equal(db.tx.rolledBack, 1);
  assert.equal(db.tx.committed, 0);
  assert.equal(inserted.order, null);
});

test('UT-05 placeOrder: unknown menu item -> 400 and rolled back', async () => {
  const inserted = seedOrderPlacement();
  const { res } = await place([{ menuItemId: 999, quantity: 1 }]);
  assert.equal(res.statusCode, 400);
  assert.equal(db.tx.rolledBack, 1);
  assert.equal(inserted.order, null);
});

test('UT-05 placeOrder: database failure -> rolled back, connection released, generic 500 (no SQL leaked)', async () => {
  seedOrderPlacement();
  db.txHandler = async (sql) => {
    if (/FROM menu_items/.test(sql)) throw new Error('ER_SECRET: table menu_items exploded');
    return [[]];
  };
  const { res } = await place([{ menuItemId: 1, quantity: 1 }]);
  assert.equal(res.statusCode, 500);
  assert.ok(!/ER_SECRET|exploded/.test(JSON.stringify(res.body)), 'internal error text must not reach the client');
  assert.equal(db.tx.rolledBack, 1);
  assert.equal(db.tx.released, 1);
});

// ====================================================================== UT-06 / UT-07 status machine
/** Fake DB holding one order in the given status. Returns the log of UPDATE statements. */
function seedOrder(status, extra = {}) {
  db.reset();
  const updates = [];
  const serviceEvents = [];
  db.txHandler = async (sql, params) => {
    if (/FROM orders WHERE id = \? FOR UPDATE/.test(sql)) {
      return [[{ id: 10, status, student_id: 3, counter_id: null, is_preorder: 1, ...extra }]];
    }
    if (/^\s*UPDATE orders/.test(sql)) { updates.push({ sql, params }); return [{ affectedRows: 1 }]; }
    if (/INSERT INTO service_events/.test(sql)) { serviceEvents.push({ sql, params }); return [{ affectedRows: 1 }]; }
    return [[]];
  };
  return { updates, serviceEvents };
}

async function changeStatus(id, status, extraBody = {}) {
  const req = createReq({ params: { id: String(id) }, body: { status, ...extraBody }, user: { id: 1, role: 'staff' } });
  const res = await callController(updateOrderStatus, req);
  return { res, req };
}

// ------------------------------------------------------------------ UT-06
test('UT-06 updateOrderStatus: received -> preparing updates the status and sets preparing_at', async () => {
  const { updates } = seedOrder('received');
  const { res } = await changeStatus(10, 'preparing');

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'preparing');
  assert.equal(res.body.previousStatus, 'received');

  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /preparing_at = COALESCE\(preparing_at, NOW\(\)\)/);
  assert.equal(updates[0].params[0], 'preparing');
  assert.equal(updates[0].params.at(-1), 10, 'only this order is updated');
  assert.deepEqual(db.tx, { began: 1, committed: 1, rolledBack: 0, released: 1 });
});

test('UT-06 updateOrderStatus: broadcasts the change with the student id so "ready" notifies them (FR-08)', async () => {
  seedOrder('preparing');
  const { req } = await changeStatus(10, 'ready');
  assert.deepEqual(req.emitted, [
    { event: 'orders:statusChanged', payload: { orderId: 10, status: 'ready', studentId: 3 } },
  ]);
});

test('UT-06 updateOrderStatus: each step stamps its own timestamp column', async () => {
  const stamps = { preparing: 'preparing_at', ready: 'ready_at', completed: 'completed_at' };
  const from = { preparing: 'received', ready: 'preparing', completed: 'ready' };
  for (const [next, column] of Object.entries(stamps)) {
    const { updates } = seedOrder(from[next]);
    const { res } = await changeStatus(10, next);
    assert.equal(res.statusCode, 200, `${from[next]} -> ${next}`);
    assert.match(updates[0].sql, new RegExp(`${column} = COALESCE\\(${column}, NOW\\(\\)\\)`));
  }
});

test('UT-06 updateOrderStatus: completing an order records a service_events calibration row', async () => {
  const { serviceEvents } = seedOrder('ready');
  const { res } = await changeStatus(10, 'completed');
  assert.equal(res.statusCode, 200);
  assert.equal(serviceEvents.length, 1);
  assert.match(serviceEvents[0].sql, /BETWEEN 5 AND 3600/, 'implausible service times are filtered out');
  assert.deepEqual(serviceEvents[0].params, [10]);
});

test('UT-06 updateOrderStatus: a counter can be assigned while advancing', async () => {
  const { updates } = seedOrder('received');
  await changeStatus(10, 'preparing', { counterId: 2 });
  assert.match(updates[0].sql, /counter_id = \?/);
  assert.deepEqual(updates[0].params, ['preparing', 2, 10]);
});

test('UT-06 updateOrderStatus: setting the status it already has is a harmless no-op', async () => {
  const { updates } = seedOrder('preparing');
  const { res, req } = await changeStatus(10, 'preparing');
  assert.equal(res.statusCode, 200);
  assert.match(res.body.message, /already/i);
  assert.equal(updates.length, 0);
  assert.equal(req.emitted.length, 0, 'no duplicate notification');
});

test('UT-06 updateOrderStatus: received -> cancelled and preparing -> cancelled are allowed', async () => {
  for (const from of ['received', 'preparing']) {
    seedOrder(from);
    const { res } = await changeStatus(10, 'cancelled');
    assert.equal(res.statusCode, 200, `${from} -> cancelled`);
  }
});

// ------------------------------------------------------------------ UT-07
test('UT-07 updateOrderStatus: completed -> preparing is rejected (409) by the state machine', async () => {
  const { updates } = seedOrder('completed');
  const { res, req } = await changeStatus(10, 'preparing');

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /cannot move/i);
  assert.equal(updates.length, 0, 'database row untouched');
  assert.equal(req.emitted.length, 0, 'nobody is notified of an illegal change');
  assert.deepEqual(db.tx, { began: 1, committed: 0, rolledBack: 1, released: 1 });
});

test('UT-07 updateOrderStatus: the full 5x5 transition matrix behaves exactly as specified', async () => {
  const STATUSES = ['received', 'preparing', 'ready', 'completed', 'cancelled'];
  // Written independently from the code: received -> preparing -> ready -> completed,
  // and an order may be cancelled until it is ready.
  const LEGAL = new Set([
    'received>preparing', 'received>cancelled',
    'preparing>ready', 'preparing>cancelled',
    'ready>completed',
  ]);

  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const { updates } = seedOrder(from);
      const { res } = await changeStatus(10, to);

      if (from === to) {
        assert.equal(res.statusCode, 200, `${from} -> ${to} (same state) should be a no-op`);
        assert.equal(updates.length, 0);
      } else if (LEGAL.has(`${from}>${to}`)) {
        assert.equal(res.statusCode, 200, `${from} -> ${to} should be allowed`);
        assert.equal(updates.length, 1);
      } else {
        assert.equal(res.statusCode, 409, `${from} -> ${to} should be rejected`);
        assert.equal(updates.length, 0, `${from} -> ${to} must not write`);
      }
    }
  }
});

test('UT-07 updateOrderStatus: finished orders list no next step in the error message', async () => {
  seedOrder('completed');
  const { res } = await changeStatus(10, 'received');
  assert.match(res.body.message, /finished/i);

  seedOrder('received');
  const skip = await changeStatus(10, 'ready');
  assert.match(skip.res.body.message, /preparing/, 'tells staff the valid next step');
});

test('UT-07 updateOrderStatus: invalid input -> 400 / 404 and nothing is written', async () => {
  seedOrder('received');
  const badStatus = await changeStatus(10, 'banana');
  assert.equal(badStatus.res.statusCode, 400);

  const badId = await changeStatus('abc', 'preparing');
  assert.equal(badId.res.statusCode, 400);

  const negativeId = await changeStatus(-4, 'preparing');
  assert.equal(negativeId.res.statusCode, 400);

  // order that does not exist
  db.reset();
  db.txHandler = async () => [[undefined]];
  const missing = await changeStatus(999, 'preparing');
  assert.equal(missing.res.statusCode, 404);
  assert.equal(db.tx.rolledBack, 1);
});
