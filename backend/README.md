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
5. Check it's alive: `GET http://localhost:4000/api/health` → `{"status":"ok"}`

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
| GET | /api/menu | any (logged in) | browse menu | FR-05 |
| POST/PUT/DELETE | /api/menu | manager, admin | manage menu | NFR-10 |
| GET | /api/counters | any | see open counters | FR-05 |
| PATCH | /api/counters/:id | staff, manager, admin | open/close counter | FR-11 |
| POST | /api/orders | student | place a pre-order | FR-06 |
| GET | /api/orders/mine | student | track own orders | FR-07 |
| GET | /api/orders/board | staff, manager, admin | live order board | FR-09 |
| PATCH | /api/orders/:id/status | staff, manager, admin | update order status | FR-10 |
| GET | /api/queue | any | live queue length + estimated wait | FR-02, FR-03, FR-04, FR-15 |
| GET | /api/queue/history | manager, admin | historical queue data | FR-13, FR-14 |
| POST | /api/simulations | manager, admin | run a what-if scenario | FR-12 |
| GET | /api/simulations | manager, admin | past scenario results | FR-13 |
| GET | /api/reports/summary | manager, admin | aggregated KPIs only | FR-13, FR-14, FR-17 |

Socket.io events emitted: `counters:updated`, `orders:new`, `orders:statusChanged` — the frontend
should listen for these instead of polling, per NFR-04.

## Notes

- `POST /api/simulations` calls a Python/SimPy DES service at `DES_ENGINE_URL` (default
  `http://localhost:5001`). That service is a separate, not-yet-built piece — until it exists,
  simulation requests return a 503 explaining that, while `/api/queue` still works using the
  simple fallback formula in `src/utils/waitTimeEstimator.js` (this satisfies NFR-09).
- Passwords are hashed with bcrypt; never store or log plain-text passwords.
- All role checks happen server-side in `src/middleware/auth.js`, not just hidden in the UI.
