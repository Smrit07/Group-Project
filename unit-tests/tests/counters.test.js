'use strict';
/**
 * UT-08  toggleCounter(id, open) - close counter 2 -> counter closed; reflected on all screens
 *
 * Requirements: FR-05, FR-11, NFR-04
 * "Reflected on all screens" = the controller broadcasts over Socket.io so every connected
 * student / staff / management screen refreshes without a page reload.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { useFakeDb, load, createReq, callController } = require('../helpers/setup');

const db = useFakeDb();
const { setCounterStatus, listCounters } = load('src/controllers/counterController.js');

const staffUser = { id: 11, role: 'staff' };

test('UT-08 toggleCounter: closing counter 2 writes is_open = false for counter 2 only', async () => {
  db.reset();
  db.poolHandler = async () => [{ affectedRows: 1 }];

  const req = createReq({ params: { id: '2' }, body: { isOpen: false }, user: staffUser });
  const res = await callController(setCounterStatus, req);

  assert.equal(res.statusCode, 200);
  assert.equal(db.poolCalls.length, 1);
  const { sql, params } = db.poolCalls[0];
  assert.match(sql, /UPDATE counters SET is_open = \?/);
  assert.match(sql, /WHERE id = \?/, 'scoped to a single counter');
  assert.equal(params[0], false);
  assert.equal(params.at(-1), '2');
});

test('UT-08 toggleCounter: change is broadcast to all connected screens (counters:updated)', async () => {
  db.reset();
  db.poolHandler = async () => [{ affectedRows: 1 }];

  const req = createReq({ params: { id: '2' }, body: { isOpen: false }, user: staffUser });
  await callController(setCounterStatus, req);

  assert.deepEqual(req.emitted, [{ event: 'counters:updated', payload: undefined }]);
});

test('UT-08 toggleCounter: reopening a counter and assigning a staff member', async () => {
  db.reset();
  db.poolHandler = async () => [{ affectedRows: 1 }];

  const req = createReq({ params: { id: '3' }, body: { isOpen: true, assignedStaffId: 11 }, user: staffUser });
  const res = await callController(setCounterStatus, req);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(db.poolCalls[0].params, [true, 11, '3']);
  assert.equal(req.emitted.length, 1);
});

test('UT-08 toggleCounter: unknown counter -> 404 and nothing is broadcast', async () => {
  db.reset();
  db.poolHandler = async () => [{ affectedRows: 0 }];

  const req = createReq({ params: { id: '999' }, body: { isOpen: false }, user: staffUser });
  const res = await callController(setCounterStatus, req);

  assert.equal(res.statusCode, 404);
  assert.equal(req.emitted.length, 0);
});

test('UT-08 toggleCounter: missing isOpen -> 400 and the database is not touched', async () => {
  db.reset();
  const req = createReq({ params: { id: '2' }, body: {}, user: staffUser });
  const res = await callController(setCounterStatus, req);

  assert.equal(res.statusCode, 400);
  assert.equal(db.poolCalls.length, 0);
  assert.equal(req.emitted.length, 0);
});

test('UT-08 listCounters: returns every counter with its open/closed state (FR-05)', async () => {
  db.reset();
  const rows = [
    { id: 1, name: 'Counter 1', is_open: 1, assigned_staff_id: 11, staff_name: 'Sita' },
    { id: 2, name: 'Counter 2', is_open: 0, assigned_staff_id: null, staff_name: null },
  ];
  db.poolHandler = async () => [rows];

  const res = await callController(listCounters, createReq());
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, rows);
});
