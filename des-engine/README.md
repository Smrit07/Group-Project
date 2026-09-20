# DES Engine — SimPy simulation service

The discrete-event simulation component described in Section 2.2.1 of the
proposal and Sections 3 and 6 of the final report. It runs as its own HTTP
service on port 5001 and is called by the Express backend.

## Why a separate service

The proposal describes the engine as "invoked from a Node.js back-end via a
simple process bridge or REST endpoint". REST won for two reasons: the Python
process stays alive between calls, so a simulation run does not pay interpreter
start-up and a SimPy import every time; and it can be restarted independently
while the rest of the app keeps serving, which is what makes the graceful
degradation in NFR-09 meaningful rather than theoretical.

## Running it

```
pip install -r requirements.txt
python app.py
```

Then <http://localhost:5001/health>.

`python app.py` uses [waitress](https://pypi.org/project/waitress/) if it is
installed — a production WSGI server that, unlike gunicorn, actually works on
Windows. It falls back to Flask's development server so a bare clone still
runs.

Configuration is in `.env` (copy `.env.example`). Every parameter has a
documented default, so an empty `.env` still works.

## The model

| Aspect | Choice | Why |
|---|---|---|
| Queue discipline | One queue per counter, join-shortest-queue | The NAMI cafeteria has separate physical lines. Modelling it as a single pooled M/G/c queue gives shorter waits than reality. |
| Service times | Lognormal, fitted mean and CV | Serving a thali has a floor and a long right tail. An exponential has its mode at zero, which would understate the queue. |
| Arrivals | Non-stationary Poisson, Lewis–Shedler thinning | The whole problem is that arrivals are concentrated in the 09:00–10:00 break. A constant rate models a problem the college does not have. |
| Pre-orders | Separate customer class, short service, queue priority | This is the mechanism by which pre-ordering is supposed to shorten the walk-in queue (FR-06). |
| Balking | Logistic in queue length | Without it, a badly staffed scenario shows an unbounded queue and a huge average wait. With it, it shows a moderate wait and a high balk rate — which is what actually happens, and the more useful thing to show a manager. |
| Staffing | `counters_open` clamped by `staff_count`; surplus staff speed service up | You cannot run a counter with nobody behind it. This is the dial the manager's question actually turns on, so it is explicit. |
| Warm-up | First 5 minutes discarded | The model starts empty, which is not what 09:05 looks like. |
| Output analysis | Independent replications, adaptive until the 95% CI half-width is within 10% of the mean | A single run is one sample from a random process. Fixing the replication count in advance either wastes CPU on an easy scenario or returns a useless interval on a noisy one. |

Scenario variants are run with **common random numbers** — the same seed, so
the same simulated students walk through every configuration. That is what
makes "2 counters vs 3 counters" an honest comparison rather than a comparison
of two different days.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness. Never touches the database or runs the model. |
| `POST` | `/estimate` | Live wait for the student banner. Budget: under 1 second. |
| `POST` | `/simulate` | Full what-if with confidence intervals, a sensitivity sweep and a plain-English verdict. |
| `POST` | `/compare` | Up to 6 scenarios under common random numbers. |
| `GET` | `/calibration` | Current fitted parameters and where they came from. |
| `POST` | `/calibration/refresh` | Force a refit from MySQL. |

```bash
curl -X POST http://localhost:5001/estimate \
  -H "Content-Type: application/json" \
  -d '{"queueLength": 14, "openCounters": 2}'

curl -X POST http://localhost:5001/simulate \
  -H "Content-Type: application/json" \
  -d '{"countersOpen": 3, "staffCount": 4, "arrivalRatePerHour": 80, "preorderShare": 0.35}'
```

### Two very different workloads

`/estimate` runs on the student-facing path. The backend gives it 1.5 seconds
before falling back to its own arithmetic, so it runs few replications over a
short horizon and caches aggressively — the answer for "14 people, 2 counters"
does not change between two students loading the page four seconds apart.

`/simulate` runs on the manager's path. Nobody is standing at a counter waiting
for it, so it runs the full adaptive replication set.

## Calibration

Section 7.1 of the final report names the project's own weakest point: the
model was calibrated from a small hand-timed sample, so it predicts badly on
atypical days. `des/calibration.py` closes that loop.

Every completed order writes its measured service time to `service_events`, and
the engine re-fits three things from that table every ten minutes:

- service time mean and CV, split by walk-in and pre-order collection
- arrival rate per peak hour, and the within-hour shape in 10-minute bins
- the actual pre-order share

Everything degrades safely. No database, no PyMySQL, not enough rows, a
nonsense variance — any of these and the configured defaults are used, with
`calibration.source` in the response saying which. The engine never refuses to
answer because the data was disappointing.

The fit trims the extreme 2% at each end before estimating. Real counter data
contains rows where a staff member forgot to press "ready" until after their
break; a single 40-minute "service time" would move the mean more than every
honest row combined.

## Files

```
app.py                  Flask routes, auth, error handling
des/config.py           every tunable parameter, with its provenance
des/distributions.py    random variates, arrival profile, thinning, balking
des/model.py            the SimPy model itself
des/statistics.py       confidence intervals, percentiles, time-weighted means
des/calibration.py      fitting parameters from MySQL
des/engine.py           orchestration, caching, verdict generation
```

`des/statistics.py` is deliberately dependency-free — no numpy or scipy — so
there are no wheels to compile on a student laptop running XAMPP.

## Reproducibility

`DES_BASE_SEED` is fixed at `20261007`, so a demo re-run in front of the module
leader produces the same numbers as the screenshots in the report. Pass a
different `seed` in the request body to vary it.
