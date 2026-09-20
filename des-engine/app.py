"""
HTTP front door for the SimPy DES engine.

This is the service the Express backend talks to. Section 2.2 of the
proposal describes it as "invoked from a Node.js back-end via a simple
process bridge or REST endpoint"; a REST endpoint won because it keeps the
Python process alive between calls, so a scenario run does not pay
interpreter start-up every time, and because it can be restarted
independently while the rest of the app stays up.

Endpoints
---------
GET  /health        liveness + configuration echo
POST /estimate      live wait estimate for the student queue banner (fast path)
POST /simulate      full what-if scenario for the manager dashboard
POST /compare       several scenarios under common random numbers
GET  /calibration   current fitted parameters and where they came from
POST /calibration/refresh  force a refit from MySQL

Run it with:
    python app.py                     (development)
    waitress-serve --port=5001 app:app  (Windows / XAMPP, see README)
"""

from __future__ import annotations

import logging
import os
import platform
import sys
import time
from typing import Any

from flask import Flask, g, jsonify, request

from des.calibration import get_calibration, invalidate_calibration
from des.config import get_settings
from des.engine import (
    MODEL_VERSION,
    build_parameters,
    clear_caches,
    estimate_wait,
    run_scenario,
)
from des.model import run_replications
from des.statistics import summarise

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [des-engine] %(levelname)s %(message)s",
)
logger = logging.getLogger("des-engine")

STARTED_AT = time.time()


def create_app() -> Flask:
    app = Flask(__name__)
    settings = get_settings()

    # ----------------------------------------------------------------------
    # Cross-cutting concerns
    # ----------------------------------------------------------------------

    @app.before_request
    def _authenticate_and_time() -> Any:
        g.started = time.monotonic()

        if request.method == "OPTIONS" or request.path == "/health":
            return None

        # Optional shared secret. Unset in local XAMPP development, where the
        # engine binds to 127.0.0.1 and is unreachable from the network; set
        # it if the engine is ever moved to a separate host.
        if settings.api_key:
            provided = request.headers.get("X-DES-Key")
            if provided != settings.api_key:
                return jsonify({"error": "unauthorised", "message": "Invalid or missing X-DES-Key."}), 401

        return None

    @app.after_request
    def _cors_and_timing(response):
        # The Node backend is the only intended caller, but allowing the
        # browser origin too means a developer can poke /health from the
        # Svelte dev tools while debugging.
        response.headers["Access-Control-Allow-Origin"] = os.getenv("DES_CORS_ORIGIN", "*")
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-DES-Key"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"

        started = getattr(g, "started", None)
        if started is not None:
            response.headers["X-Runtime-Ms"] = f"{(time.monotonic() - started) * 1000:.1f}"
        return response

    @app.errorhandler(ValueError)
    def _handle_validation(exc: ValueError):
        # ScenarioParameters.validated() raises ValueError with a readable
        # message; surfacing it as 400 tells the manager which field is wrong
        # instead of showing a generic 500.
        return jsonify({"error": "invalid_parameters", "message": str(exc)}), 400

    @app.errorhandler(404)
    def _handle_404(_):
        return jsonify({"error": "not_found", "message": "No such endpoint."}), 404

    @app.errorhandler(Exception)
    def _handle_unexpected(exc: Exception):
        logger.exception("Unhandled error in DES engine")
        return (
            jsonify(
                {
                    "error": "engine_error",
                    "message": "The simulation engine failed to complete this request.",
                    "detail": str(exc) if settings.debug else None,
                }
            ),
            500,
        )

    def _payload() -> dict:
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else {}

    # ----------------------------------------------------------------------
    # Routes
    # ----------------------------------------------------------------------

    @app.get("/health")
    def health():
        """
        Cheap liveness check. The Express backend polls this to decide
        whether to show the manager "simulation available" or the graceful
        degradation message required by NFR-09, so it must never touch the
        database or run the model.
        """
        return jsonify(
            {
                "status": "ok",
                "service": "smart-cafeteria-des-engine",
                "modelVersion": MODEL_VERSION,
                "uptimeSeconds": round(time.time() - STARTED_AT, 1),
                "python": platform.python_version(),
                "defaults": {
                    "serviceMeanMinutes": settings.model.service_mean_minutes,
                    "horizonMinutes": settings.model.horizon_minutes,
                    "scenarioReplications": settings.model.scenario_replications,
                    "estimateReplications": settings.model.estimate_replications,
                },
            }
        )

    @app.post("/estimate")
    def estimate():
        """
        Live wait estimate. Body: { queueLength, openCounters, staffCount? }

        Contract with the backend: answer within ~1 second or the backend
        falls back to its own arithmetic. The engine therefore caps its own
        work rather than trying to be as accurate as possible.
        """
        return jsonify(estimate_wait(_payload()))

    @app.post("/simulate")
    def simulate():
        """
        Full what-if run. Body accepts the manager's form fields
        (countersOpen, staffCount, arrivalRatePerHour) plus optional
        overrides for every model parameter.
        """
        payload = _payload()
        logger.info(
            "Scenario request: counters=%s staff=%s arrivals/h=%s",
            payload.get("countersOpen"),
            payload.get("staffCount"),
            payload.get("arrivalRatePerHour"),
        )
        return jsonify(run_scenario(payload))

    @app.post("/compare")
    def compare():
        """
        Run several scenarios against the *same* random stream.

        Body: { "scenarios": [ {...}, {...} ], "seed": 12345 }

        Common random numbers across the variants means the same simulated
        students walk through every configuration, so the difference between
        two options is the option — not a lucky day. This is the endpoint
        behind "should we open a third counter or add a second person to the
        two we have?", which is the question the manager interview in
        Section 4.1 actually asked.
        """
        payload = _payload()
        scenarios = payload.get("scenarios")
        if not isinstance(scenarios, list) or not scenarios:
            raise ValueError("`scenarios` must be a non-empty array.")
        if len(scenarios) > 6:
            raise ValueError("At most 6 scenarios can be compared in one request.")

        settings_model = settings.model
        seed = int(payload.get("seed") or settings_model.base_seed)
        replications = max(5, min(60, int(payload.get("replications") or 15)))
        calibration = get_calibration()

        rows = []
        budget_each = settings_model.max_runtime_seconds / max(1, len(scenarios))

        for index, raw in enumerate(scenarios):
            if not isinstance(raw, dict):
                raise ValueError(f"Scenario {index + 1} is not an object.")
            params = build_parameters(raw, calibration)
            results = run_replications(params, replications, seed, deadline_seconds=budget_each)
            if not results:
                continue

            wait = summarise([r.mean_wait_minutes for r in results])
            queue = summarise([r.max_queue_length for r in results])
            util = summarise([r.counter_utilisation for r in results])
            balk = summarise([r.balk_rate * 100 for r in results])

            rows.append(
                {
                    "label": raw.get("label") or f"Scenario {index + 1}",
                    "countersOpen": params.counters_open,
                    "effectiveCounters": params.effective_counters,
                    "staffCount": params.staff_count,
                    "preorderSharePercent": round(params.preorder_share * 100, 1),
                    "avgWaitMinutes": round(wait.mean, 2),
                    "avgWaitCi": [round(wait.ci_low, 2), round(wait.ci_high, 2)],
                    "maxQueueLength": round(queue.mean, 1),
                    "counterUtilisationPercent": round(util.mean * 100, 1),
                    "balkRatePercent": round(balk.mean, 1),
                    "peakOfferedLoad": round(params.peak_offered_load, 3),
                    "replications": len(results),
                }
            )

        if not rows:
            raise RuntimeError("No scenario produced a usable result.")

        best = min(rows, key=lambda row: row["avgWaitMinutes"])
        for row in rows:
            row["deltaVsBestMinutes"] = round(row["avgWaitMinutes"] - best["avgWaitMinutes"], 2)

        return jsonify(
            {
                "engine": "simpy-des",
                "modelVersion": MODEL_VERSION,
                "seed": seed,
                "commonRandomNumbers": True,
                "scenarios": rows,
                "recommended": best["label"],
                "calibration": calibration.to_dict(),
                "disclaimer": "All figures are simulation estimates, not guaranteed times (FR-04).",
            }
        )

    @app.get("/calibration")
    def calibration_view():
        """What the model currently believes, and where it got it from."""
        return jsonify(get_calibration().to_dict())

    @app.post("/calibration/refresh")
    def calibration_refresh():
        """
        Force a refit. Worth calling after a bulk import of observation data,
        rather than waiting out the TTL.
        """
        invalidate_calibration()
        clear_caches()
        return jsonify({"refreshed": True, "calibration": get_calibration(force=True).to_dict()})

    return app


app = create_app()


if __name__ == "__main__":
    settings = get_settings()
    logger.info(
        "Starting DES engine on http://%s:%s (model %s, python %s)",
        settings.host,
        settings.port,
        MODEL_VERSION,
        platform.python_version(),
    )
    if settings.debug:
        logger.warning("DES_DEBUG is on — do not leave this enabled for the demo.")

    try:
        # Waitress is a production-grade WSGI server that works on Windows,
        # which gunicorn does not. Preferred when available; Flask's own
        # development server is the fallback so a bare `python app.py` still
        # works on a fresh clone.
        from waitress import serve

        serve(app, host=settings.host, port=settings.port, threads=6)
    except ImportError:
        logger.warning("waitress not installed — using Flask's development server.")
        app.run(host=settings.host, port=settings.port, debug=settings.debug, threaded=True)
    except KeyboardInterrupt:  # pragma: no cover
        logger.info("DES engine stopped.")
        sys.exit(0)
