"""
Orchestration between the HTTP layer and the SimPy model.

Two very different workloads share one model, and keeping them apart is the
main job of this module:

`estimate_wait()`  runs on the student-facing path. The Node backend gives it
                   1.5 seconds before it gives up and falls back to the naive
                   formula (NFR-09). So it runs few replications, over a short
                   horizon, and memoises aggressively — the answer for
                   "14 people, 2 counters" does not change between two students
                   loading the page four seconds apart.

`run_scenario()`   runs on the manager's what-if path. Nobody is standing at a
                   counter waiting for it, so it runs the full 30 replications
                   and returns confidence intervals, a sensitivity sweep and a
                   plain-English verdict.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any, Optional

from .calibration import Calibration, get_calibration
from .config import get_settings
from .model import ReplicationResult, ScenarioParameters, run_replications
from .statistics import Summary, percentile, summarise


# --------------------------------------------------------------------------
# Building parameters from a request payload + calibration
# --------------------------------------------------------------------------

def _coerce_float(value: Any, fallback: float) -> float:
    try:
        if value is None:
            return fallback
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _coerce_int(value: Any, fallback: int) -> int:
    try:
        if value is None:
            return fallback
        return int(float(value))
    except (TypeError, ValueError):
        return fallback


def build_parameters(payload: dict, calibration: Calibration) -> ScenarioParameters:
    """
    Merge three sources, in increasing order of authority:

        1. configured defaults          (des/config.py)
        2. calibration from live data   (des/calibration.py)
        3. whatever the caller sent     (the manager's form)

    So the manager's form always wins, calibration fills the gaps, and the
    defaults guarantee the model is runnable even on a fresh install with an
    empty database.
    """
    model = get_settings().model

    arrival_default = calibration.arrival_rate_per_hour or 40.0
    preorder_default = (
        calibration.preorder_share
        if calibration.preorder_share is not None
        else model.preorder_share
    )
    multipliers = calibration.arrival_multipliers or model.arrival_multipliers

    return ScenarioParameters(
        counters_open=_coerce_int(payload.get("countersOpen"), 2),
        staff_count=_coerce_int(payload.get("staffCount"), 3),
        arrival_rate_per_hour=_coerce_float(payload.get("arrivalRatePerHour"), arrival_default),
        service_mean_minutes=_coerce_float(
            payload.get("serviceMeanMinutes"), calibration.service_mean_minutes
        ),
        service_cv=_coerce_float(payload.get("serviceCv"), calibration.service_cv),
        pickup_mean_minutes=_coerce_float(
            payload.get("pickupMeanMinutes"), calibration.pickup_mean_minutes
        ),
        pickup_cv=_coerce_float(payload.get("pickupCv"), calibration.pickup_cv),
        preorder_share=_coerce_float(payload.get("preorderShare"), preorder_default),
        horizon_minutes=_coerce_float(payload.get("horizonMinutes"), model.horizon_minutes),
        warmup_minutes=_coerce_float(payload.get("warmupMinutes"), model.warmup_minutes),
        balk_tolerance=_coerce_int(payload.get("balkTolerance"), model.balk_tolerance),
        balk_steepness=_coerce_float(payload.get("balkSteepness"), model.balk_steepness),
        initial_queue_length=_coerce_int(payload.get("initialQueueLength"), 0),
        arrival_multipliers=tuple(multipliers),
    ).validated()


# --------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------

def _aggregate(results: list[ReplicationResult]) -> dict[str, Summary]:
    return {
        "meanWaitMinutes": summarise([r.mean_wait_minutes for r in results]),
        "p90WaitMinutes": summarise([r.p90_wait_minutes for r in results]),
        "maxWaitMinutes": summarise([r.max_wait_minutes for r in results]),
        "meanQueueLength": summarise([r.mean_queue_length for r in results]),
        "maxQueueLength": summarise([r.max_queue_length for r in results]),
        "counterUtilisation": summarise([r.counter_utilisation for r in results]),
        "throughputPerHour": summarise([r.throughput_per_hour for r in results]),
        "balkRatePercent": summarise([r.balk_rate * 100 for r in results]),
        "servedPerRun": summarise([float(r.served) for r in results]),
        "balkedPerRun": summarise([float(r.balked) for r in results]),
    }


def _verdict(params: ScenarioParameters, metrics: dict[str, Summary]) -> dict:
    """
    Turn numbers into the sentence a cafeteria manager actually needs.

    The proposal's whole justification for the admin dashboard is that
    staffing decisions are currently made on intuition. Handing back a JSON
    blob of nine statistics replaces intuition with arithmetic homework, so
    the engine states a conclusion and says what drove it.
    """
    mean_wait = metrics["meanWaitMinutes"].mean
    p90_wait = metrics["p90WaitMinutes"].mean
    utilisation = metrics["counterUtilisation"].mean
    balk_percent = metrics["balkRatePercent"].mean
    sustained_load = params.offered_load
    peak_load = params.peak_offered_load

    reasons: list[str] = []

    if params.understaffed_by > 0:
        reasons.append(
            f"{params.counters_open} counters were requested but only {params.staff_count} "
            f"staff are available, so {params.effective_counters} counters were modelled."
        )

    # The rating is led by what the students actually experienced in the runs,
    # not by the load ratio. A peak load above 1.0 that lasts ten minutes is
    # survivable — the cafeteria absorbs it and catches up — and calling that
    # "overloaded" would cry wolf on configurations that work fine in practice.
    # Load is used to *explain* the outcome and to flag fragility.
    if sustained_load >= 1.0 or balk_percent >= 15.0:
        rating = "overloaded"
        headline = (
            "Demand exceeds capacity for the whole break. The queue grows until students give "
            "up, so the average wait understates how bad it feels on the floor."
        )
    elif mean_wait > 8.0 or p90_wait > 15.0:
        rating = "poor"
        headline = "The break is covered eventually, but the waits are the ones the project set out to remove."
    elif mean_wait <= 3.0 and p90_wait <= 6.0:
        rating = "comfortable"
        headline = "Waits stay short across the whole break, with room to absorb a busy day."
    else:
        rating = "acceptable"
        headline = (
            "The break is covered, though some students still wait noticeably longer than average."
        )

    if sustained_load >= 1.0:
        reasons.append(
            f"Sustained offered load is {sustained_load:.2f} — at or above 1.00 the queue cannot clear."
        )
    elif sustained_load >= 0.85:
        reasons.append(
            f"Sustained offered load is {sustained_load:.2f}, leaving almost no slack for an absence."
        )

    if peak_load >= 1.0 and sustained_load < 1.0:
        reasons.append(
            f"The busiest ten minutes run at a load of {peak_load:.2f}, so a queue builds during the "
            "rush and then clears — expect the worst waits early in the break, not at the end."
        )

    if balk_percent >= 5.0:
        reasons.append(
            f"About {balk_percent:.0f}% of students walk away without being served — "
            "lost sales as well as lost goodwill."
        )
    if utilisation >= 0.90:
        reasons.append(
            f"Counters are busy {utilisation * 100:.0f}% of the time, so staff get no recovery gaps."
        )
    elif utilisation <= 0.35:
        reasons.append(
            f"Counters are idle {100 - utilisation * 100:.0f}% of the time — this configuration "
            "costs more staff than the demand needs."
        )

    reasons.append(
        f"Nine students in ten are served within {p90_wait:.1f} minutes; the average is "
        f"{mean_wait:.1f} minutes."
    )

    return {"rating": rating, "headline": headline, "reasons": reasons}


def _sensitivity(params: ScenarioParameters, base_seed: int, budget_seconds: float) -> list[dict]:
    """
    Re-run the scenario with one counter fewer and one counter more.

    A manager comparing options wants "what if I open one more?" answered in
    the same screen, and because every variant reuses `base_seed`, the
    comparison uses common random numbers: the same simulated students walk
    in, so the difference is attributable to the counter and not to luck.
    """
    settings = get_settings()
    variants: list[dict] = []
    per_variant = max(1.0, budget_seconds / 2.0)
    replications = max(5, settings.model.scenario_replications // 3)

    for delta in (-1, 1):
        counters = params.counters_open + delta
        if counters < 1 or counters > 20:
            continue
        try:
            variant = ScenarioParameters(
                **{**params.__dict__, "counters_open": counters}
            ).validated()
        except ValueError:
            continue

        runs = run_replications(variant, replications, base_seed, deadline_seconds=per_variant)
        if not runs:
            continue

        wait = summarise([r.mean_wait_minutes for r in runs])
        variants.append(
            {
                "countersOpen": counters,
                "effectiveCounters": variant.effective_counters,
                "meanWaitMinutes": round(wait.mean, 2),
                "replications": len(runs),
                "deltaVsBaseMinutes": None,  # filled in by the caller
            }
        )

    return variants


# --------------------------------------------------------------------------
# Public entry points
# --------------------------------------------------------------------------

def run_scenario(payload: dict) -> dict:
    """Full what-if run for POST /simulate."""
    settings = get_settings()
    started = time.monotonic()

    calibration = get_calibration()
    params = build_parameters(payload, calibration)

    replications = _coerce_int(
        payload.get("replications"), settings.model.scenario_replications
    )
    replications = max(3, min(settings.model.max_replications, replications))
    seed = _coerce_int(payload.get("seed"), settings.model.base_seed)

    budget = settings.model.max_runtime_seconds
    target_precision = _coerce_float(payload.get("targetPrecision"), 0.10)

    # Sequential (adaptive) replication: run the requested batch, then keep
    # adding replications until the 95% CI half-width is within
    # `targetPrecision` of the mean, or we hit the configured ceiling or the
    # time budget. Fixing the replication count in advance either wastes CPU
    # on an easy scenario or hands back a useless interval on a noisy one;
    # this asks the data how many runs it needs.
    results = run_replications(params, replications, seed, deadline_seconds=budget * 0.5)
    if not results:
        raise RuntimeError("The model produced no replications — check the scenario parameters.")

    ceiling = settings.model.max_replications
    batch = max(5, replications // 3)
    while (
        len(results) < ceiling
        and summarise([r.mean_wait_minutes for r in results]).relative_precision > target_precision
        and (time.monotonic() - started) < budget * 0.5
    ):
        extra = run_replications(
            params, batch, seed + len(results), deadline_seconds=budget * 0.2
        )
        if not extra:
            break
        results.extend(extra)

    metrics = _aggregate(results)

    sensitivity = []
    if payload.get("includeSensitivity", True):
        remaining = budget - (time.monotonic() - started)
        if remaining > 1.0:
            sensitivity = _sensitivity(params, seed, remaining)
            base_wait = metrics["meanWaitMinutes"].mean
            for variant in sensitivity:
                variant["deltaVsBaseMinutes"] = round(
                    variant["meanWaitMinutes"] - base_wait, 2
                )

    precision = metrics["meanWaitMinutes"].relative_precision

    return {
        "engine": "simpy-des",
        "modelVersion": MODEL_VERSION,
        # Flat headline figures, so a caller that only wants a number does not
        # have to walk the nested structure. The Node backend stores these
        # straight into simulation_scenarios.results.
        "avgWaitMinutes": round(metrics["meanWaitMinutes"].mean, 2),
        "p90WaitMinutes": round(metrics["p90WaitMinutes"].mean, 2),
        "maxQueueLength": round(metrics["maxQueueLength"].mean, 1),
        "avgQueueLength": round(metrics["meanQueueLength"].mean, 2),
        "counterUtilisationPercent": round(metrics["counterUtilisation"].mean * 100, 1),
        "throughputPerHour": round(metrics["throughputPerHour"].mean, 1),
        "balkRatePercent": round(metrics["balkRatePercent"].mean, 1),
        # Full detail with confidence intervals.
        "metrics": {name: summary.to_dict() for name, summary in metrics.items()},
        "scenario": {
            "countersOpen": params.counters_open,
            "effectiveCounters": params.effective_counters,
            "staffCount": params.staff_count,
            "understaffedBy": params.understaffed_by,
            "arrivalRatePerHour": round(params.arrival_rate_per_hour, 1),
            "preorderSharePercent": round(params.preorder_share * 100, 1),
            "serviceMeanMinutes": round(params.service_mean_minutes, 2),
            "speedFactor": round(params.speed_factor, 3),
            "horizonMinutes": params.horizon_minutes,
            "warmupMinutes": params.warmup_minutes,
            "offeredLoad": round(params.offered_load, 3),
            "peakOfferedLoad": round(params.peak_offered_load, 3),
        },
        "run": {
            "replications": len(results),
            "requestedReplications": replications,
            "seed": seed,
            "targetPrecision": target_precision,
            "relativePrecision": None if precision == float("inf") else round(precision, 4),
            "precisionNote": (
                f"95% CI half-width is within {target_precision:.0%} of the mean — "
                "the run is long enough."
                if precision <= target_precision
                else (
                    "Stopped at the replication or time ceiling before reaching the target "
                    "precision; treat the interval, not the point estimate, as the answer."
                )
            ),
            "runtimeSeconds": round(time.monotonic() - started, 3),
        },
        "sensitivity": sensitivity,
        "verdict": _verdict(params, metrics),
        "calibration": calibration.to_dict(),
        "disclaimer": (
            "All figures are simulation estimates, not guaranteed times (FR-04)."
        ),
    }


# --------------------------------------------------------------------------
# Live estimate, with a short-TTL cache
# --------------------------------------------------------------------------

@dataclass
class _CacheEntry:
    value: dict
    expires_at: float


_estimate_cache: dict[tuple, _CacheEntry] = {}
_estimate_lock = threading.Lock()
MODEL_VERSION = "2.0.0"


def _cache_get(key: tuple) -> Optional[dict]:
    now = time.monotonic()
    with _estimate_lock:
        entry = _estimate_cache.get(key)
        if entry and entry.expires_at > now:
            return entry.value
        if entry:
            _estimate_cache.pop(key, None)
    return None


def _cache_put(key: tuple, value: dict, ttl: float) -> None:
    with _estimate_lock:
        # Cheap bound: this cache is keyed on small integers, so it cannot
        # grow much, but a stuck process shouldn't leak either.
        if len(_estimate_cache) > 512:
            _estimate_cache.clear()
        _estimate_cache[key] = _CacheEntry(value, time.monotonic() + ttl)


def estimate_wait(payload: dict) -> dict:
    """
    Live wait estimate for POST /estimate.

    Called with the *current* queue length and open-counter count from the
    database, it seeds the model with those students and asks: if you joined
    the back of this line right now, how long until you are served?

    That is a different question from the steady-state average the scenario
    endpoint answers, and it is the one the banner on the student's phone is
    actually claiming to answer.
    """
    settings = get_settings()
    started = time.monotonic()

    queue_length = max(0, _coerce_int(payload.get("queueLength"), 0))
    open_counters = _coerce_int(payload.get("openCounters"), 0)

    if open_counters <= 0:
        # Not a failure — a closed cafeteria is a real state, and the student
        # needs to be told that rather than shown a fabricated number.
        return {
            "estimatedWaitMinutes": None,
            "queueLength": queue_length,
            "openCounters": 0,
            "source": "des_model",
            "isEstimate": True,
            "confidence": "none",
            "message": "All counters are closed, so no wait time can be estimated.",
            "modelVersion": MODEL_VERSION,
        }

    # Bucket the queue length so that 14 and 15 people share a cached answer.
    # The model's own noise is larger than the difference between them, so a
    # separate run per integer would burn CPU to produce indistinguishable
    # numbers.
    bucket = queue_length if queue_length < 10 else (queue_length // 3) * 3
    calibration = get_calibration()
    cache_key = (
        bucket,
        open_counters,
        _coerce_int(payload.get("staffCount"), open_counters),
        round(calibration.service_mean_minutes, 2),
        round(calibration.pickup_mean_minutes, 2),
    )

    cached = _cache_get(cache_key)
    if cached is not None:
        response = dict(cached)
        response["queueLength"] = queue_length  # report the true figure
        response["cached"] = True
        return response

    params = build_parameters(
        {
            **payload,
            "countersOpen": open_counters,
            "staffCount": payload.get("staffCount") or open_counters,
            "initialQueueLength": queue_length,
            # Short horizon: we only care about the next stretch of the break,
            # and a 60-minute run would cost 10x the CPU to answer a question
            # about the next ten minutes.
            "horizonMinutes": _coerce_float(payload.get("horizonMinutes"), 25.0),
            # No warm-up: the initial queue *is* the state we want to start in,
            # so discarding the first minutes would discard the whole point.
            "warmupMinutes": 0.0,
        },
        calibration,
    )

    results = run_replications(
        params,
        settings.model.estimate_replications,
        settings.model.base_seed,
        deadline_seconds=0.9,  # comfortably inside the backend's 1.5 s timeout
    )

    if not results:
        raise RuntimeError("Estimate produced no replications.")

    # The wait experienced by the students already in the queue is what a new
    # arrival is about to join, so take the mean over the initial cohort where
    # we have one, and over everyone otherwise.
    all_waits: list[float] = []
    for result in results:
        cohort = result.waits[: max(1, queue_length)] if queue_length else result.waits
        all_waits.extend(cohort)

    if not all_waits:
        mean_wait = 0.0
        p90 = 0.0
    else:
        mean_wait = sum(all_waits) / len(all_waits)
        p90 = percentile(all_waits, 90)

    summary = summarise([r.mean_wait_minutes for r in results])
    precision = summary.relative_precision
    confidence = "high" if precision <= 0.15 else "medium" if precision <= 0.35 else "low"

    response = {
        "estimatedWaitMinutes": round(mean_wait, 1),
        "p90WaitMinutes": round(p90, 1),
        "queueLength": queue_length,
        "openCounters": params.effective_counters,
        "source": "des_model",
        "isEstimate": True,
        "confidence": confidence,
        "replications": len(results),
        "offeredLoad": round(params.offered_load, 3),
        "modelVersion": MODEL_VERSION,
        "calibrationSource": calibration.source,
        "runtimeSeconds": round(time.monotonic() - started, 3),
        "cached": False,
        "message": "Estimated by the discrete-event simulation model.",
    }

    _cache_put(cache_key, response, settings.estimate_cache_ttl_seconds)
    return response


def clear_caches() -> None:
    with _estimate_lock:
        _estimate_cache.clear()
