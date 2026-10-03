# Smart Cafeteria & Resource Queue Optimizer

CSY2088 Group Project — BSc (Hons) Computer Science, NAMI College.
Group The OG: Smrit Chaulagain (leader), Subham Khadka, Abish Aryal,
Arpan Somnath Adhikari, Dhirendra Singh Khadka.

A Progressive Web Application that combines live cafeteria queue management
with Discrete Event Simulation. Students see estimated wait times and pre-order
meals; staff work an order board; managers get performance reports and can test
staffing changes before making them.

---

## Docker stack

| Service | Host access | Purpose |
|---|---|---|
| `app` | <http://localhost:4001/> | Svelte frontend, Express API, and Socket.io |
| `mysql` | `127.0.0.1:3307` | Persistent MySQL database |
| `adminer` | <http://localhost:8081/> | Browser-based database management |
| `des-engine` | <http://localhost:5002/health> | Wait-time prediction and what-if simulation |

## Run the full stack with Docker

Install and start [Docker Desktop](https://www.docker.com/products/docker-desktop/),
then run these commands from the project root:

```bash
docker compose up --build
```

Open <http://localhost:4001/>. The frontend is built into the Node image, and
Compose starts MySQL, the DES engine, and the API in dependency order. Check
<http://localhost:4001/api/health> for the API and database status. MySQL is
also available to local database tools at `127.0.0.1:3307`; the DES port is
internal to Docker.

To browse the Docker database in Safari, open <http://localhost:8081/>. Sign
in to Adminer with system `MySQL`, server `mysql`, username `root`, your
Compose MySQL root password, and database `smart_cafeteria`. Adminer is bound
to localhost only. Set `ADMINER_PORT` in the root `.env` file to change its
host port.

The app host port defaults to `4001`. Set `APP_PORT` in the root `.env` file
to choose a different available host port.

The first MySQL startup runs `database/schema.sql` and `database/seed.sql` and
stores data in the persistent `cafeteria_db_data` volume. Later starts keep the
existing database and do not rerun those scripts. Existing database data is
not overwritten or imported automatically.

The default database credentials in Compose (`root` / `rootpassword`) are for
local development only. For a fresh install, set `MYSQL_ROOT_PASSWORD`,
`DB_USER`, and `DB_PASSWORD` in a root `.env` file to use a separate app
account. MySQL creates that account only when initializing an empty volume.
Changing these values does not update credentials or create users in an
existing MySQL data directory.

Compose uses a local-only default for `JWT_SECRET` so demo login works without
loading `backend/.env`. Set a long, random `JWT_SECRET` in the root `.env` file
before using the app beyond a local demo. The root Compose `.env` and
`backend/.env` are separate files.

Stop the services with `Ctrl+C`, or run `docker compose down`. The database
volume is retained. To follow container logs, run `docker compose logs -f`.

The DES engine's host port is bound to localhost only. The Node backend uses
the internal Compose address and enforces role checks for app simulation
requests.

Demo accounts use the password `Password123!`: `student@example.com`,
`staff@example.com`, `manager@example.com`, and `admin@example.com`.

## Docker workflow

Rebuild after code changes with `docker compose up --build -d`; follow output
with `docker compose logs -f`. Stop containers with `docker compose down`.
Database data remains in `cafeteria_db_data` when containers stop.

---

## Project structure

```
smart-cafeteria-v2/
  backend/      Express REST API + Socket.io       (Node, port 4000)
  des-engine/   SimPy discrete-event simulation    (Python/Flask, port 5001)
  frontend/     Svelte PWA                         (built into the app image)
  database/     schema.sql, seed.sql, migrations   (initialized by MySQL)
  Dockerfile    frontend build and Node app image
  docker-compose.yml  application services
```

Each folder has its own README with the detail.

---

## How the wait-time estimate works

This is the part most worth being able to explain in the viva.

1. The student's browser calls `GET /api/queue`.
2. The backend counts orders in `received` or `preparing`, and open counters.
3. It sends both to the DES engine's `/estimate`, which seeds a SimPy model
   with those students already in the queue and runs 8 short replications —
   answering "if you joined the back of this line now, how long until you are
   served?" rather than a generic steady-state average.
4. If the engine does not answer within 1.5 seconds, the backend falls back to
   `queue / counters x average service time` and labels the result
   `source: "live_count"`. The banner then says *approximate — simulation
   offline*. This is NFR-09, and the labelling matters: a student should know
   when the number is simulated and when it is arithmetic.
5. After three consecutive failures a circuit breaker opens and the engine is
   skipped entirely for 20 seconds, so an engine that is down costs one slow
   request rather than every request.
6. Every figure is returned with `isEstimate: true` and rendered with the word
   "estimate" — FR-04 requires that these are never presented as guaranteed
   times.

The model calibrates itself from real data as the cafeteria runs. Every
completed order writes its measured service time to `service_events`, and the
engine re-fits its lognormal service-time distribution from that table every
ten minutes. That closes the weakness Section 7.1 of the final report admits
to — a model calibrated from a small hand-timed sample — without anyone
standing in the cafeteria with a stopwatch again.

---

## Troubleshooting

**API or database is unavailable:** run `docker compose ps` and
`docker compose logs -f app mysql des-engine`.

**Cannot open MySQL in Safari:** MySQL's port `3307` is not a web page. Use
Adminer at <http://localhost:8081/>; sign in with server `mysql`, system
`MySQL`, and your configured database credentials.

**`/api/simulations` returns 503:** check that the `des-engine` service is
healthy with `docker compose ps` and inspect its logs.

---

## Known gaps

- **FR-16** (a wait-time reminder pushed before the break) is not built. It is
  a "Could" in the MoSCoW prioritisation and was deliberately deferred; the
  final report says so.
- **Bootstrap 5** is named in the technology stack tables in both the proposal
  and the final report, but the frontend uses hand-written CSS with a design
  token system in `frontend/src/lib/styles.css`. Either amend the tables or
  rework the styling before submission — a marker comparing the two will
  notice.
- The 14 days of history in `seed.sql` are **generated, not measured**. Every
  `service_events` row carries `source = 'simulated'` so this cannot be
  mistaken for real cafeteria data. Set `DES_USE_DB_CALIBRATION=false` in
  `des-engine/.env` to have the model ignore it.
