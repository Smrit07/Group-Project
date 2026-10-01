'use strict';
/**
 * UT-02  checkRole(token, required) - student token on a staff endpoint -> 403
 *
 * Requirements: FR-01, FR-17, FR-18, NFR-05
 *
 * Covers the real middleware in src/middleware/auth.js (requireAuth + requireRole)
 * and then sweeps EVERY route in src/routes/* to prove nothing was left unprotected.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  useFakeDb, load, createReq, runChain, signToken, bearer, backendRequire,
} = require('../helpers/setup');

useFakeDb(); // route files import controllers, which import the DB pool
const { requireAuth, requireRole } = load('src/middleware/auth.js');
const jwt = backendRequire('jsonwebtoken');

// ------------------------------------------------------------------ the core UT-02 case
test('UT-02 checkRole: student token on a staff endpoint -> 403 permission error', async () => {
  const token = signToken({ role: 'student' });
  const req = createReq({ headers: bearer(token) });

  const { res, reachedHandler } = await runChain(
    [requireAuth, requireRole('staff', 'manager', 'admin')], // same guard as PATCH /api/counters/:id
    req
  );

  assert.equal(reachedHandler, false, 'handler must not run');
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /permission/i);
});

test('UT-02 checkRole: staff, manager and admin tokens ARE allowed on a staff endpoint', async () => {
  for (const role of ['staff', 'manager', 'admin']) {
    const req = createReq({ headers: bearer(signToken({ role })) });
    const { reachedHandler } = await runChain([requireAuth, requireRole('staff', 'manager', 'admin')], req);
    assert.equal(reachedHandler, true, `${role} should be allowed`);
    assert.equal(req.user.role, role, 'decoded user is attached to req.user');
  }
});

test('UT-02 checkRole: staff token on a manager-only endpoint -> 403', async () => {
  const req = createReq({ headers: bearer(signToken({ role: 'staff' })) });
  const { res, reachedHandler } = await runChain([requireAuth, requireRole('manager', 'admin')], req);
  assert.equal(reachedHandler, false);
  assert.equal(res.statusCode, 403);
});

// ------------------------------------------------------------------ authentication failures
test('UT-02 requireAuth: no Authorization header -> 401', async () => {
  const { res, reachedHandler } = await runChain([requireAuth], createReq());
  assert.equal(reachedHandler, false);
  assert.equal(res.statusCode, 401);
});

test('UT-02 requireAuth: wrong scheme (not "Bearer") -> 401', async () => {
  const token = signToken({ role: 'admin' });
  const req = createReq({ headers: { authorization: `Token ${token}` } });
  const { res } = await runChain([requireAuth], req);
  assert.equal(res.statusCode, 401);
});

test('UT-02 requireAuth: token signed with a different secret (forged) -> 401', async () => {
  const forged = signToken({ role: 'admin' }, { secret: 'attacker-secret' });
  const { res, reachedHandler } = await runChain([requireAuth], createReq({ headers: bearer(forged) }));
  assert.equal(reachedHandler, false);
  assert.equal(res.statusCode, 401);
});

test('UT-02 requireAuth: expired token -> 401', async () => {
  const expired = signToken({ role: 'staff' }, { expiresIn: -60 });
  const { res, reachedHandler } = await runChain([requireAuth], createReq({ headers: bearer(expired) }));
  assert.equal(reachedHandler, false);
  assert.equal(res.statusCode, 401);
});

test('UT-02 requireAuth: tampered payload (role edited to admin) -> 401', async () => {
  const [header, , signature] = signToken({ role: 'student' }).split('.');
  const evilPayload = Buffer.from(JSON.stringify({ id: 1, role: 'admin' })).toString('base64url');
  const tampered = `${header}.${evilPayload}.${signature}`;
  const { res } = await runChain([requireAuth], createReq({ headers: bearer(tampered) }));
  assert.equal(res.statusCode, 401);
});

// ------------------------------------------------------------------ sweep every route
// route file (in backend/src/routes) -> URL prefix it is mounted on in server.js
const MOUNTS = {
  authRoutes: '/api/auth',
  userRoutes: '/api/users',
  menuRoutes: '/api/menu',
  counterRoutes: '/api/counters',
  orderRoutes: '/api/orders',
  queueRoutes: '/api/queue',
  simulationRoutes: '/api/simulations',
  reportRoutes: '/api/reports',
};

/** Routes that are intentionally open to anyone (no login). */
const PUBLIC_ROUTES = new Set([
  'POST /api/auth/register',
  'POST /api/auth/login',
  'GET /api/queue/',      // FR-15: wait time visible without logging in
  'GET /api/menu/',       // FR-05
  'GET /api/counters/',   // FR-05
]);

/** Routes a *student* is allowed to use once logged in. */
const STUDENT_ROUTES = new Set([
  'POST /api/orders/',
  'GET /api/orders/mine',
  'GET /api/users/me',
  'PATCH /api/users/me',
]);

function collectRoutes() {
  const routes = [];
  for (const [file, mount] of Object.entries(MOUNTS)) {
    const router = load(`src/routes/${file}.js`);
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const handlers = layer.route.stack.map((l) => l.handle);
      for (const method of Object.keys(layer.route.methods)) {
        routes.push({ key: `${method.toUpperCase()} ${mount}${layer.route.path}`, handlers });
      }
    }
  }
  return routes;
}

test('UT-02 sweep: every route is either deliberately public or requires a valid token', () => {
  const routes = collectRoutes();
  assert.ok(routes.length >= 20, `expected to find the whole API, found ${routes.length} routes`);

  const unprotected = routes.filter((r) => !PUBLIC_ROUTES.has(r.key) && r.handlers[0] !== requireAuth);
  assert.deepEqual(
    unprotected.map((r) => r.key),
    [],
    'these routes are reachable without logging in'
  );
});

test('UT-02 sweep: a student token is rejected (403) on every route except the student ones', async () => {
  const studentToken = signToken({ role: 'student' });
  const checked = [];

  for (const route of collectRoutes()) {
    if (PUBLIC_ROUTES.has(route.key) || STUDENT_ROUTES.has(route.key)) continue;

    const guards = route.handlers.slice(0, -1); // everything before the controller itself
    const { res, reachedHandler } = await runChain(guards, createReq({ headers: bearer(studentToken) }));

    assert.equal(reachedHandler, false, `${route.key} let a student through`);
    assert.equal(res.statusCode, 403, `${route.key} should answer 403 to a student`);
    checked.push(route.key);
  }
  assert.ok(checked.length >= 10, `only ${checked.length} routes were checked`);
});

test('UT-02 sweep: student-only routes (placing/viewing own orders) reject staff, manager and admin', async () => {
  const studentOnly = ['POST /api/orders/', 'GET /api/orders/mine'];
  const routes = collectRoutes().filter((r) => studentOnly.includes(r.key));
  assert.equal(routes.length, 2);

  for (const route of routes) {
    for (const role of ['staff', 'manager', 'admin']) {
      const guards = route.handlers.slice(0, -1);
      const { res } = await runChain(guards, createReq({ headers: bearer(signToken({ role })) }));
      assert.equal(res.statusCode, 403, `${route.key} should reject ${role}`);
    }
  }
});

test('UT-02 sanity: tokens issued by the app carry the role claim the middleware reads', () => {
  const decoded = jwt.verify(signToken({ id: 5, role: 'manager' }), process.env.JWT_SECRET);
  assert.equal(decoded.role, 'manager');
  assert.equal(decoded.id, 5);
});
