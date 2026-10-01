'use strict';
/**
 * UT-01  login(role)        - valid credentials for each of the 4 roles
 * UT-12  hashPassword(pw)   - bcrypt hash, not reversible
 *
 * Requirements: FR-01, NFR-05
 *
 * Note on UT-01: the "redirect to the role-specific screen" itself happens in the
 * Svelte frontend (App.svelte switches on session.user.role). What the backend must
 * guarantee - and what is tested here - is that login returns the correct role,
 * both in the response body and inside the signed JWT.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { useFakeDb, load, backendRequire, createReq, callController } = require('../helpers/setup');

const db = useFakeDb();
const bcrypt = backendRequire('bcryptjs');
const jwt = backendRequire('jsonwebtoken');
const { login, register } = load('src/controllers/authController.js');

const PASSWORD = 'Passw0rd!';
const ROLES = ['student', 'staff', 'manager', 'admin'];

/** A users table with one account per role. Hash uses 4 rounds so the tests stay fast. */
const users = ROLES.map((role, i) => ({
  id: i + 1,
  full_name: `Test ${role}`,
  email: `${role}@nami.test`,
  password_hash: bcrypt.hashSync(PASSWORD, 4),
  role,
}));

db.poolHandler = async (sql, params) => {
  if (/FROM users WHERE email/.test(sql)) {
    return [users.filter((u) => u.email === params[0])];
  }
  if (/INSERT INTO users/.test(sql)) return [{ insertId: 99 }];
  return [[]];
};

// ------------------------------------------------------------------ UT-01
test('UT-01 login: each of the 4 roles gets its own role back (body + JWT)', async () => {
  for (const role of ROLES) {
    const req = createReq({ body: { email: `${role}@nami.test`, password: PASSWORD } });
    const res = await callController(login, req);

    assert.equal(res.statusCode, 200, `${role}: should log in`);
    assert.equal(res.body.user.role, role, `${role}: role in response body`);
    assert.equal(res.body.user.email, `${role}@nami.test`);

    const payload = jwt.verify(res.body.token, process.env.JWT_SECRET);
    assert.equal(payload.role, role, `${role}: role inside the token`);
    assert.equal(payload.email, `${role}@nami.test`);
  }
});

test('UT-01 login: response never leaks the password hash', async () => {
  const req = createReq({ body: { email: 'student@nami.test', password: PASSWORD } });
  const res = await callController(login, req);
  const json = JSON.stringify(res.body);
  assert.ok(!json.includes('password'), 'no password field in response');
  assert.ok(!json.includes(users[0].password_hash), 'hash not in response');
});

test('UT-01 login: wrong password and unknown email give the same 401 (no account enumeration)', async () => {
  const wrongPw = await callController(login, createReq({ body: { email: 'student@nami.test', password: 'nope' } }));
  const unknown = await callController(login, createReq({ body: { email: 'ghost@nami.test', password: PASSWORD } }));

  assert.equal(wrongPw.statusCode, 401);
  assert.equal(unknown.statusCode, 401);
  assert.equal(wrongPw.body.message, unknown.body.message);
});

test('UT-01 login: missing email or password -> 400', async () => {
  const noPw = await callController(login, createReq({ body: { email: 'student@nami.test' } }));
  const noEmail = await callController(login, createReq({ body: { password: PASSWORD } }));
  assert.equal(noPw.statusCode, 400);
  assert.equal(noEmail.statusCode, 400);
});

// ------------------------------------------------------------------ UT-12
test('UT-12 hashPassword: registration stores a bcrypt hash, never the plain password', async () => {
  db.reset();
  const req = createReq({
    body: { fullName: 'New Student', email: 'new@nami.test', password: 'MySecret123' },
  });
  const res = await callController(register, req);
  assert.equal(res.statusCode, 201);

  const insert = db.poolCalls.find((c) => /INSERT INTO users/.test(c.sql));
  assert.ok(insert, 'an INSERT INTO users was issued');

  const [, , storedHash] = insert.params; // (full_name, email, password_hash, role)
  assert.notEqual(storedHash, 'MySecret123', 'plain text must not be stored');
  assert.match(storedHash, /^\$2[aby]\$\d{2}\$.{53}$/, 'looks like a bcrypt hash');
  assert.equal(bcrypt.compareSync('MySecret123', storedHash), true, 'hash verifies the right password');
  assert.equal(bcrypt.compareSync('WrongPassword', storedHash), false, 'hash rejects a wrong password');
});

test('UT-12 hashPassword: same password hashed twice gives different hashes (salted)', async () => {
  const hashes = [];
  for (const email of ['a@nami.test', 'b@nami.test']) {
    db.reset();
    await callController(register, createReq({ body: { fullName: 'X', email, password: 'SamePassword1' } }));
    hashes.push(db.poolCalls.find((c) => /INSERT INTO users/.test(c.sql)).params[2]);
  }
  assert.notEqual(hashes[0], hashes[1]);
});

test('UT-12 register: response contains no password or hash', async () => {
  const res = await callController(
    register,
    createReq({ body: { fullName: 'Safe', email: 'safe@nami.test', password: 'MySecret123' } })
  );
  const json = JSON.stringify(res.body);
  assert.ok(!json.includes('MySecret123'));
  assert.ok(!/\$2[aby]\$/.test(json), 'no hash in response');
});

test('UT-12 register: validation (missing fields 400, bad role 400, duplicate email 409)', async () => {
  const missing = await callController(register, createReq({ body: { email: 'x@nami.test' } }));
  assert.equal(missing.statusCode, 400);

  const badRole = await callController(
    register,
    createReq({ body: { fullName: 'X', email: 'x@nami.test', password: 'pw', role: 'superuser' } })
  );
  assert.equal(badRole.statusCode, 400);

  const duplicate = await callController(
    register,
    createReq({ body: { fullName: 'X', email: 'student@nami.test', password: 'pw' } })
  );
  assert.equal(duplicate.statusCode, 409);
});
