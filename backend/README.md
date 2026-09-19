# Smart Cafeteria — Backend API

REST + WebSocket API for the Smart Cafeteria & Resource Queue Optimizer (CSY2088).

## Stack
- Node.js + Express (REST API)
- Socket.io (real-time updates: queue length, order status, counters)
- MySQL via `mysql2/promise` (connection pool)
- JWT (`jsonwebtoken`) for auth, `bcryptjs` for password hashing

## Setup

1. Start MySQL (via XAMPP Control Panel).
2. Create the database and tables:
   ```
   mysql -u root -p < ../database/schema.sql
   mysql -u root -p < ../database/seed.sql
   ```
3. Copy `.env.example` to `.env` and fill in your DB credentials and a JWT secret.
4. Install dependencies and run:
   ```
   npm install
   npm run dev
   ```
5. Check it's alive: `GET http://localhost:4000/api/health`

   The health response reports on **both** dependencies, not just itself. The
   two ways this app fails on a fresh machine are "XAMPP's MySQL isn't started"
   and "nobody started the DES engine", and this endpoint names which:

   ```json
   {
     "status": "ok",
     "database": { "connected": true, "version": "8.0.x" },
     "simulationEngine": { "available": true, "modelVersion": "2.0.0" }
   }
   ```

Demo login (from seed.sql), password for all: `Password123!`
- student@example.com
- staff@example.com
- manager@example.com
- admin@example.com

## API overview

| Method | Route | Role | Purpose | Maps to |
|---|---|---|---|---|
| POST | /api/auth/register | any | create account | FR-01 |
| POST | /api/auth/login | any | get a JWT | FR-01 |
| GET | /api/users/me | any (logged in) | your own profile | FR-18 |
| PATCH | /api/users/me | any (logged in) | update your name/password | FR-18 |
| GET | /api/users?role= | manager, admin | list users by role (e.g. for staff assignment) | NFR-10 |
| GET | /api/menu | any (logged in) | browse menu | FR-05 |
| POST/PUT/DELETE | /api/menu | manager, admin | manage menu | NFR-10 |
| GET | /api/counters | any | see open counters | FR-05 |
| PATCH | /api/counters/:id | staff, manager, admin | open/close counter | FR-11 |
| POST | /api/orders | student | place a pre-order | FR-06 |
| GET | /api/orders/mine | student | track own orders | FR-07 |
| GET | /api/orders/board | staff, manager, admin | live order board | FR-09 |
| PATCH | /api/orders/:id/status | staff, manager, admin | advance order status (state-machine checked) | FR-10 |
| POST | /api/orders/walk-in | staff, manager, admin | log a counter customer who did not use the app | FR-14, calibration |
| GET | /api/queue | any | live queue length + estimated wait | FR-02, FR-03, FR-04, FR-15 |
| GET | /api/queue/history | manager, admin | historical queue data | FR-13, FR-14 |
| GET | /api/queue/accuracy | manager, admin | predicted vs actual wait, mean absolute error | evaluation metric |
| POST | /api/simulations | manager, admin | run a what-if scenario | FR-12 |
| GET | /api/simulations | manager, admin | past scenario results | FR-13 |
| POST | /api/simulations/compare | manager, admin | up to 6 scenarios under common random numbers | FR-12 |
| GET | /api/simulations/engine | manager, admin | is the DES engine up? | NFR-09 |
| DELETE | /api/simulations/:id | manager, admin | remove a stored scenario | FR-13 |
| GET | /api/reports/summary?period= | manager, admin | aggregated KPIs only (daily/weekly/monthly/semester) | FR-13, FR-14, FR-17 |

Socket.io events emitted: `counters:updated`, `orders:new`, `orders:statusChanged` — the frontend
should listen for these instead of polling, per NFR-04.

## Talking to the DES engine

All calls to the Python/SimPy service go through `src/services/desClient.js` —
one module, not an inline `fetch` in each controller. It adds three things the
inline version could not have:

* **A circuit breaker.** NFR-09 asks for graceful degradation when the
  prediction model is unavailable. Implemented naively as "try, wait for the
  timeout, fall back", that still costs *every* request the full timeout. After
  three consecutive failures the breaker opens and calls fail instantly for 20
  seconds, so the student's page stays fast while the engine is restarted.
* **Timeouts that reflect who is waiting.** A student staring at the queue
  banner gets 1.5s; a manager who clicked "run scenario" gets 25s.
* **A distinction between "your parameters are wrong" (400, the manager's to
  fix) and "the engine is down" (503, ours).** Conflating those is what makes a
  simulation feature frustrating to use.

## Where calibration data comes from

Completing an order writes a row to `service_events`, measured from
`preparing_at` to `ready_at` — the interval a counter was actually occupied.

Deliberately *not* `created_at` to `completed_at`: that includes the queueing
before service and however long the student took to wander over and collect it.
Feeding that in as "service time" would inflate it badly and make the
simulation predict waits several times worse than reality.

Values under 5 seconds or over an hour are rejected, because they are
data-entry artefacts — a staff member batch-pressing buttons at the end of a
shift — rather than observations.

## Order status is a state machine

`received -> preparing -> ready -> completed`, with `cancelled` reachable from
the first two. Transitions are validated and the row is locked `FOR UPDATE`
during the change.

Allowing any status to be set from any other lets a mis-tap on the staff board
move a collected order back to "preparing", which corrupts both the live queue
count and every service time derived from the timestamps.

## Notes

- Passwords are hashed with bcrypt; only the hash is ever stored or returned.
- Order prices come from the database at insert time, never from the request
  body. A price posted by the browser is a price the student chose.
- Reports return aggregates only, never individual student orders (FR-17,
  NFR-06). The `v_peak_hour_performance` view has no `student_id` column at
  all, so the privacy rule holds even if a future endpoint forgets it.
- Queue snapshots are written at most once every 5 seconds regardless of
  traffic. Previously one row went in per page load, so twenty students with
  the page open wrote twenty identical rows a second — which both bloated the
  table and skewed every average computed from it.
