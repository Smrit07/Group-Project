# Unit Tests — Report Section 7.1 (UT-01 to UT-12)

Automated tests for the **Smart Cafeteria & Resource Queue Optimizer**.
Every row of *Table 7.1 Unit test results* in the group report is implemented here, and each test
name starts with its ID (`UT-05 placeOrder: ...`) so the output lines up with the report.

**No MySQL, browser or running server is needed.** The tests run the *real* backend code;
only the database and the Python engine are replaced with fakes.

---

## 1. Where to put this folder

Place `unit-tests` in the project root, **next to** `backend/` and `des-engine/`:

```
Group-Project-main/
├── backend/
├── des-engine/
├── frontend/
└── unit-tests/      <-- this folder
```

If it lives somewhere else, tell it where the code is:

```bash
# Mac / Linux
BACKEND_DIR=/path/to/backend  DES_ENGINE_DIR=/path/to/des-engine  npm test

# Windows PowerShell
$env:BACKEND_DIR="C:\path\to\backend"; $env:DES_ENGINE_DIR="C:\path\to\des-engine"; npm test
```

## 2. One-time setup

You need **Node.js 18.17 or newer** (check with `node --version`).
Python 3.10+ is only needed for the optional engine tests (step 4).

```bash
cd backend
npm install          # skip if you have already run it
cd ..
```

The `unit-tests` folder itself has **no dependencies to install** — it uses Node's built-in test runner.

## 3. Run the tests (Node / backend)

```bash
cd unit-tests
npm test
```

Expected result: every line green (`✔`) and a summary ending in

```
ℹ tests 87
ℹ pass 87
ℹ fail 0
```

### Handy variations

```bash
# only one test case from the report
node --test --test-name-pattern="UT-07"

# only one file
node --test tests/orders.test.js
```

## 4. Run the Python engine tests (UT-09, the real SimPy model)

```bash
pip install -r ../des-engine/requirements.txt     # once
npm run test:python                                # Windows (uses "python")
npm run test:python3                               # Mac / Linux (uses "python3")
```

Or directly: `python -m unittest discover -s python -v`
Expected: `Ran 16 tests ... OK` (takes about a second).

---

## What is covered

| ID | Function under test | Test file | Requirements |
|----|---------------------|-----------|--------------|
| UT-01 | `login(role)` – each of the 4 roles | `tests/auth.test.js` | FR-01 |
| UT-02 | `checkRole(token, required)` – student on staff endpoint → 403 | `tests/access-control.test.js` | FR-01, NFR-05 |
| UT-03 | `getQueueLength()` – 3 received/preparing orders → 3 | `tests/queue.test.js` | FR-02 |
| UT-04 | `estimateWait(queue, counters)` – 6 / 2 counters → 7.5 min, labelled | `tests/queue.test.js`, `python/…` | FR-03, FR-04 |
| UT-05 | `placeOrder(student, items)` – status `received` + pickup estimate | `tests/orders.test.js` | FR-06, FR-07 |
| UT-06 | `updateOrderStatus` – received → preparing, `preparing_at` set | `tests/orders.test.js` | FR-10 |
| UT-07 | `updateOrderStatus` – completed → preparing rejected | `tests/orders.test.js` | FR-10 |
| UT-08 | `toggleCounter(id, open)` – close counter 2, broadcast to all screens | `tests/counters.test.js` | FR-11, NFR-04 |
| UT-09 | `runScenario(params)` – 2 vs 3 counters, avg wait + CI | `tests/simulation.test.js`, `python/test_ut09_des_engine.py` | FR-12 |
| UT-10 | `getReport(admin)` – summarised figures only, no student IDs | `tests/reports.test.js` | FR-17, NFR-06 |
| UT-11 | `fallbackEstimate()` – engine stopped → queue length + "approximate" label | `tests/queue.test.js` | NFR-09 |
| UT-12 | `hashPassword(pw)` – bcrypt, salted, not reversible | `tests/auth.test.js` | NFR-05 |

Extra tests beyond the twelve rows: circuit breaker and timeouts (`tests/des-client.test.js`, section 4.4 of the
report), a sweep of **every API route** to prove none is left unprotected, and an exhaustive 5 × 5 order-status
transition matrix.

## How it works

| Real code (tested) | Replaced with a fake |
|--------------------|----------------------|
| Controllers, middleware, routes, `desClient`, `waitTimeEstimator` | MySQL pool → in-memory fake in `helpers/setup.js` |
| bcrypt hashing, JWT signing/verification | DES engine HTTP calls → `fetch` is stubbed |
| SimPy model (Python tests only) | MySQL calibration → switched off, built-in defaults used |

Because the database is fake, a test can inspect **exactly which SQL and parameters** the code sent — for example
UT-10 checks that report queries never touch `student_id`, and UT-03 reads the status list out of the real SQL.

## Limitations (be honest about these in the report)

- **UT-01 "redirect to the role-specific screen"** is done by the Svelte frontend (`App.svelte`). These tests prove the
  backend returns the right role in the response and the JWT; they do not click through a browser.
- The fake database does not run real SQL, so SQL *syntax* errors are not caught here. That is what the integration
  tests (section 7.2) against a real MySQL are for.

## Troubleshooting

| Message | Fix |
|---------|-----|
| `The backend dependencies are not installed` | `cd backend && npm install` |
| `Could not find the backend at ...` | Move the folder next to `backend/`, or set `BACKEND_DIR` |
| `Cannot find module 'bcryptjs'` | Same as the first row – run `npm install` inside `backend/` |
| `node: bad option: --test-reporter` | Node is too old; install Node 18.17+ (or run `node --test`) |
| `ModuleNotFoundError: simpy` | `pip install -r ../des-engine/requirements.txt` |
| `'python' is not recognized` (Windows) | Use `py -m unittest discover -s python -v` |
