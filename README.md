# Smart Cafeteria & Resource Queue Optimizer

CSY2088 Group Project — BSc (Hons) Computer Science, NAMI College.
Group The OG: Smrit Chaulagain (leader), Subham Khadka, Abish Aryal,
Arpan Somnath Adhikari, Dhirendra Singh Khadka.

A Progressive Web Application that combines live cafeteria queue management
with Discrete Event Simulation. Students see estimated wait times and pre-order
meals; staff work an order board; managers get performance reports and can test
staffing changes before making them.

---

## What runs where

XAMPP is Apache + MySQL + PHP. It cannot execute a Node or Python program, so
it does not run the whole stack by itself. What it provides is the database and
the web server in front of everything — which is exactly what the report
describes ("MySQL hosted via XAMPP during development"). Four processes in
total:

| Process | Port | Started by | What it does |
|---|---|---|---|
| Apache (XAMPP) | 80 | XAMPP Control Panel | Serves the built PWA, proxies `/api` and `/socket.io` to Node |
| MySQL (XAMPP) | 3306 | XAMPP Control Panel | All persistent data |
| Express API + Socket.io | 4000 | `deploy\start-smart-cafeteria.bat` | REST API, JWT auth, live updates |
| SimPy DES engine | 5001 | `deploy\start-smart-cafeteria.bat` | Wait-time prediction and what-if simulation |

```
Browser --80--> Apache --+-- static files (frontend/dist in htdocs)
                         +--proxy--> Node :4000 --+--> MySQL :3306
                                                  +--> Python DES :5001
```

The DES engine is deliberately not exposed through Apache. It has no
authentication of its own; the role check that keeps simulation away from
students lives in the Node backend, so the engine stays bound to `127.0.0.1`.

---

## Setup (Windows + XAMPP), start to finish

You need XAMPP, [Node.js LTS](https://nodejs.org) and
[Python 3.10+](https://python.org) (tick **Add python.exe to PATH** during the
Python installer).

### 1. Database

Start **Apache** and **MySQL** from the XAMPP Control Panel, then open
<http://localhost/phpmyadmin>.

Go to the **SQL** tab and run, in this order:

1. `database/schema.sql` — creates the database and every table
2. `database/seed.sql` — demo accounts, menu, and 14 days of history

> Already have a `smart_cafeteria` database from an earlier version? Run
> `database/migration_2026_10_des.sql` instead of `schema.sql`. It adds the new
> columns, the `service_events` table and the reporting views without touching
> your data, and it is safe to run more than once.

Or from a terminal, if `mysql` is on your PATH:

```
mysql -u root < database\schema.sql
mysql -u root < database\seed.sql
```

### 2. Start the API and the simulation engine

Double-click **`deploy\start-smart-cafeteria.bat`**.

On the first run it installs the Node and Python dependencies and creates the
`.env` files. After that it just starts the two services, each in its own
window. It checks MySQL is actually listening before it starts anything, so a
forgotten XAMPP Start gives you one clear message now instead of confusing
errors later.

Check both are healthy:

- <http://localhost:4000/api/health> — should report `"status": "ok"` with
  `database.connected: true` and `simulationEngine.available: true`
- <http://localhost:5001/health>

### 3. Build the frontend and put it in htdocs

```
cd frontend
npm install
npm run build
xcopy /E /I /Y dist C:\xampp\htdocs\smart-cafeteria
```

### 4. Configure Apache

Copy `deploy/httpd-smart-cafeteria.conf` into `C:\xampp\apache\conf\extra\`,
enable the four modules it lists at the top of the file (`proxy`, `proxy_http`,
`proxy_wstunnel`, `rewrite`) in `C:\xampp\apache\conf\httpd.conf`, add this
line at the bottom of `httpd.conf`:

```
Include conf/extra/httpd-smart-cafeteria.conf
```

and restart Apache from the Control Panel.

### 5. Open it

<http://localhost/smart-cafeteria/>

Demo accounts, all with the password `Password123!`:

| Email | Role | What you see |
|---|---|---|
| `student@example.com` | student | Queue banner, menu, pre-ordering, order tracking |
| `staff@example.com` | staff | Order board, counter open/close |
| `manager@example.com` | manager | Everything above, plus reports and simulation |
| `admin@example.com` | admin | Same as manager |

---

## Shortcut: no Apache

If you only need to demo the app and do not want to configure Apache, the Node
server serves the built frontend itself:

```
cd frontend && npm run build
deploy\start-smart-cafeteria.bat
```

then open <http://localhost:4000/>. You still need MySQL running from XAMPP.

## Development mode

Three terminals:

```
cd des-engine && python app.py          # simulation engine, port 5001
cd backend    && npm run dev            # API with auto-reload, port 4000
cd frontend   && npm run dev            # Vite dev server, port 5173
```

Open <http://localhost:5173>. The Vite dev server proxies `/api` and
`/socket.io` to port 4000, so the frontend uses the same relative URLs in
development as in production — which is what stops the classic "works in dev,
404s in the build".

---

## Project structure

```
smart-cafeteria-v2/
  backend/      Express REST API + Socket.io       (Node, port 4000)
  des-engine/   SimPy discrete-event simulation    (Python/Flask, port 5001)
  frontend/     Svelte PWA                         (built to dist/, served by Apache)
  database/     schema.sql, seed.sql, migration    (MySQL via XAMPP)
  deploy/       Apache config and start/stop scripts
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

**Blank white page at `/smart-cafeteria/`**
The frontend was built for the wrong base path. Rebuild with
`VITE_BASE_PATH=/smart-cafeteria/` in `frontend/.env` and copy `dist` over
again. Check the browser dev tools Network tab: 404s on `/assets/...` confirm
it.

**"Unexpected token '<' in JSON"**
Apache is serving the API path as static files. The two `ProxyPass` lines must
come before the `Alias` in `httpd-smart-cafeteria.conf`, and `mod_proxy` and
`mod_proxy_http` must be enabled.

**Live updates work for a few seconds after each page load, then stop**
`mod_proxy_wstunnel` is not enabled, so the WebSocket upgrade fails. Uncomment
it in `httpd.conf` and restart Apache.

**"Cannot reach MySQL... press Start next to MySQL"**
Exactly what it says. If MySQL will not start, another program is usually on
port 3306 — often a previously installed MySQL service.

**`/api/simulations` returns 503**
The DES engine is not running. `cd des-engine && python app.py`, and check
<http://localhost:5001/health>. The rest of the app keeps working without it.

**Refreshing on any page but the home screen gives 404**
The `mod_rewrite` SPA fallback is not active. Check `AllowOverride All` and
that `rewrite_module` is enabled.

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
