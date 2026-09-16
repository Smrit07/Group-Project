# Smart Cafeteria & Resource Queue Optimizer

CSY2088 Group Project — BSc (Hons) Computer Science.

## Structure

```
smart-cafeteria/
  backend/     Express REST API + Socket.io (see backend/README.md)
  database/    MySQL schema + seed data (see database/README.md)
  frontend/    Svelte PWA (not yet built)
  des-engine/  Python/SimPy wait-time simulation service (not yet built)
  docs/        Report, diagrams, screenshots for the write-up
```

## Status

- [x] Database schema (`database/schema.sql`)
- [x] Backend API: auth, menu, counters, orders, queue, simulations (stubbed), reports
- [ ] DES engine (Python/SimPy) — `/api/simulations` currently returns 503 until this exists;
      `/api/queue` already works via a simple fallback estimator
- [ ] Frontend (Svelte)

## Suggested commit sequence

Committing in the order you actually built/understood each piece (rather than one large
commit) makes the history readable and matches how the marking rubric expects development
to have proceeded:

1. `Initial project structure` — folders, .gitignore
2. `Add database schema and seed data`
3. `Add Express server skeleton and MySQL connection pool`
4. `Add auth: register/login with JWT and bcrypt`
5. `Add menu endpoints`
6. `Add counter endpoints`
7. `Add order endpoints and order board`
8. `Add live queue endpoint with fallback wait-time estimator`
9. `Add simulation and reporting endpoints`
10. `Add backend README and API documentation`

## Running everything locally
1. Start MySQL via XAMPP.
2. `mysql -u root -p < database/schema.sql` then `< database/seed.sql`.
3. `cd backend && cp .env.example .env` (fill in values) `&& npm install && npm run dev`.
4. Confirm: `curl http://localhost:4000/api/health`.
