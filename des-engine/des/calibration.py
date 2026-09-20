"""
Calibrate the model against what the cafeteria actually did.

Section 7.1 of the final report names the weakest part of the project: the
DES was calibrated against a small hand-timed sample, so it predicts badly
on atypical days. This module closes that loop. Every order the system
processes writes its own timestamps, so once the app has been live for a
week the model can re-fit itself from real data instead of from the
clipboard readings taken in Sprint 1.

Three parameters are estimated:

  service_mean / service_cv   from `service_events.service_seconds`
  pickup_mean  / pickup_cv    from the same table, rows flagged as pickups
  arrival_rate_per_hour       from order creation times in the peak window
  arrival_multipliers         the within-hour shape, in 10-minute bins

Everything degrades safely. No database, no driver, not enough rows, a
nonsense variance — any of these and the configured defaults are used and
the API response says so in `calibration.source`. The engine never refuses
to answer because the data was disappointing.
"""

from __future__ import annotations

import logging
import math
import statistics
import threading
import time
from dataclasses import dataclass, asdict
from typing import Optional

from .config import get_settings

logger = logging.getLogger(__name__)

try:
    import pymysql  # pure-Python, no compiler needed on a Windows/XAMPP laptop

    _DRIVER_AVAILABLE = True
except ImportError:  # pragma: no cover
    pymysql = None  # type: ignore
    _DRIVER_AVAILABLE = False


# Peak window at NAMI College. Calibrating arrival rate across the whole day
# would average the 09:15 crush together with a dead 14:00 and produce a
# model that under-predicts exactly when it matters.
PEAK_START_HOUR = 9
PEAK_END_HOUR = 10


@dataclass
class Calibration:
    """A snapshot of fitted parameters, plus enough provenance to defend it."""

    service_mean_minutes: float
    service_cv: float
    pickup_mean_minutes: float
    pickup_cv: float
    arrival_rate_per_hour: Optional[float]
    arrival_multipliers: Optional[tuple[float, ...]]
    preorder_share: Optional[float]

    source: str                # 'defaults' | 'database' | 'database_partial'
    service_samples: int = 0
    pickup_samples: int = 0
    arrival_samples: int = 0
    fitted_at: float = 0.0
    note: str = ""

    def to_dict(self) -> dict:
        data = asdict(self)
        data["arrivalMultipliers"] = (
            [round(m, 3) for m in self.arrival_multipliers] if self.arrival_multipliers else None
        )
        data.pop("arrival_multipliers", None)
        # camelCase for the JSON API, to match the Node/Svelte side.
        renamed = {
            "serviceMeanMinutes": round(self.service_mean_minutes, 3),
            "serviceCv": round(self.service_cv, 3),
            "pickupMeanMinutes": round(self.pickup_mean_minutes, 3),
            "pickupCv": round(self.pickup_cv, 3),
            "arrivalRatePerHour": (
                round(self.arrival_rate_per_hour, 1) if self.arrival_rate_per_hour else None
            ),
            "arrivalMultipliers": data["arrivalMultipliers"],
            "preorderShare": (
                round(self.preorder_share, 3) if self.preorder_share is not None else None
            ),
            "source": self.source,
            "serviceSamples": self.service_samples,
            "pickupSamples": self.pickup_samples,
            "arrivalSamples": self.arrival_samples,
            "fittedAt": self.fitted_at,
            "note": self.note,
        }
        return renamed


def _defaults(note: str) -> Calibration:
    model = get_settings().model
    return Calibration(
        service_mean_minutes=model.service_mean_minutes,
        service_cv=model.service_cv,
        pickup_mean_minutes=model.pickup_mean_minutes,
        pickup_cv=model.pickup_cv,
        arrival_rate_per_hour=None,
        arrival_multipliers=None,
        preorder_share=None,
        source="defaults",
        fitted_at=time.time(),
        note=note,
    )


def _connect():
    db = get_settings().database
    return pymysql.connect(
        host=db.host,
        port=db.port,
        user=db.user,
        password=db.password,
        database=db.database,
        connect_timeout=db.connect_timeout,
        read_timeout=db.connect_timeout,
        cursorclass=pymysql.cursors.DictCursor,
        charset="utf8mb4",
    )


def _trimmed(values: list[float], lower_q: float = 0.02, upper_q: float = 0.98) -> list[float]:
    """
    Drop the extreme 2% at each end before fitting.

    Real counter data contains a handful of rows where a staff member forgot
    to press "ready" until after their break. A single 40-minute "service
    time" moves the mean by more than every honest row combined, so it is
    trimmed rather than allowed to define the model.
    """
    if len(values) < 25:
        return values
    ordered = sorted(values)
    low = int(len(ordered) * lower_q)
    high = int(math.ceil(len(ordered) * upper_q))
    trimmed = ordered[low:high]
    return trimmed or ordered


def _fit_mean_cv(seconds: list[float], floor_cv: float, ceil_cv: float) -> tuple[float, float, int]:
    """Return (mean_minutes, cv, sample_count) from raw service seconds."""
    usable = _trimmed([s for s in seconds if s and 1.0 <= s <= 3600.0])
    if len(usable) < 2:
        return 0.0, 0.0, len(usable)

    mean_seconds = statistics.fmean(usable)
    stdev_seconds = statistics.pstdev(usable) if len(usable) > 1 else 0.0
    if mean_seconds <= 0:
        return 0.0, 0.0, len(usable)

    cv = stdev_seconds / mean_seconds
    # Clamp: a CV below 0.1 means the data is suspiciously uniform (usually a
    # default value written by a bug), above 1.5 means it is dominated by
    # outliers the trim missed. Either way, don't let it distort the model.
    cv = max(floor_cv, min(ceil_cv, cv))
    return mean_seconds / 60.0, cv, len(usable)


def _fit_arrival_shape(minute_offsets: list[float], bins: int = 6) -> Optional[tuple[float, ...]]:
    """
    Histogram arrival minutes-past-the-hour into `bins` equal slices and
    normalise to a mean of 1.0, giving the within-break shape the arrival
    profile needs.
    """
    if len(minute_offsets) < bins * 5:
        return None

    width = 60.0 / bins
    counts = [0] * bins
    for offset in minute_offsets:
        index = int(offset // width)
        if 0 <= index < bins:
            counts[index] += 1

    total = sum(counts)
    if total == 0:
        return None

    average = total / bins
    # A floor of 0.05 stops an empty bin from producing a zero-intensity
    # stretch, which would make the thinning loop's acceptance test useless.
    return tuple(max(0.05, c / average) for c in counts)


def fetch_calibration() -> Calibration:
    """Query MySQL once and fit. Callers should use `get_calibration()`."""
    settings = get_settings()

    if not settings.database.enabled:
        return _defaults("Database calibration disabled (DES_USE_DB_CALIBRATION=false).")
    if not _DRIVER_AVAILABLE:
        return _defaults("PyMySQL is not installed; run pip install -r requirements.txt.")

    connection = None
    try:
        connection = _connect()
        with connection.cursor() as cursor:
            # --- service times, split by walk-in vs pre-order collection ---
            cursor.execute(
                """
                SELECT is_pickup, service_seconds
                FROM service_events
                WHERE service_seconds IS NOT NULL
                  AND recorded_at >= (NOW() - INTERVAL 60 DAY)
                """
            )
            rows = cursor.fetchall()
            walkin = [float(r["service_seconds"]) for r in rows if not r["is_pickup"]]
            pickups = [float(r["service_seconds"]) for r in rows if r["is_pickup"]]

            # --- arrival volume and shape during the peak window ---
            cursor.execute(
                """
                SELECT created_at,
                       DATE(created_at)   AS order_date,
                       MINUTE(created_at) AS minute_offset
                FROM orders
                WHERE HOUR(created_at) >= %s
                  AND HOUR(created_at) <  %s
                  AND created_at >= (NOW() - INTERVAL 60 DAY)
                """,
                (PEAK_START_HOUR, PEAK_END_HOUR),
            )
            arrival_rows = cursor.fetchall()

            # --- pre-order share, so the baseline reflects real adoption ---
            cursor.execute(
                """
                SELECT
                  SUM(CASE WHEN is_preorder = 1 THEN 1 ELSE 0 END) AS preorders,
                  COUNT(*)                                          AS total
                FROM orders
                WHERE created_at >= (NOW() - INTERVAL 30 DAY)
                """
            )
            share_row = cursor.fetchone() or {}

    except Exception as exc:  # pragma: no cover - environment dependent
        logger.warning("Calibration query failed, falling back to defaults: %s", exc)
        return _defaults(f"Could not read calibration data ({type(exc).__name__}).")
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass

    result = _defaults("")
    minimum = settings.calibration_min_samples
    fitted_anything = False
    notes: list[str] = []

    service_mean, service_cv, service_n = _fit_mean_cv(walkin, 0.15, 1.20)
    if service_n >= minimum and service_mean > 0:
        result.service_mean_minutes = service_mean
        result.service_cv = service_cv
        result.service_samples = service_n
        fitted_anything = True
    else:
        notes.append(f"service times: {service_n} rows, need {minimum}")

    pickup_mean, pickup_cv, pickup_n = _fit_mean_cv(pickups, 0.15, 1.20)
    if pickup_n >= max(10, minimum // 3) and pickup_mean > 0:
        result.pickup_mean_minutes = pickup_mean
        result.pickup_cv = pickup_cv
        result.pickup_samples = pickup_n
        fitted_anything = True
    else:
        notes.append(f"pickup times: {pickup_n} rows")

    if arrival_rows:
        distinct_days = len({row["order_date"] for row in arrival_rows})
        if distinct_days >= 3:
            # Orders per peak hour, averaged over the days we have.
            result.arrival_rate_per_hour = len(arrival_rows) / distinct_days
            result.arrival_samples = len(arrival_rows)
            result.arrival_multipliers = _fit_arrival_shape(
                [float(row["minute_offset"]) for row in arrival_rows]
            )
            fitted_anything = True
        else:
            notes.append(f"arrivals: only {distinct_days} peak days recorded")
    else:
        notes.append("arrivals: no peak-window orders recorded")

    total_orders = float(share_row.get("total") or 0)
    if total_orders >= minimum:
        result.preorder_share = float(share_row.get("preorders") or 0) / total_orders

    if fitted_anything:
        result.source = "database" if not notes else "database_partial"
        result.note = "; ".join(notes) if notes else "Fitted from live cafeteria data."
    else:
        result.source = "defaults"
        result.note = "Not enough live data yet — " + "; ".join(notes)

    result.fitted_at = time.time()
    return result


# --------------------------------------------------------------------------
# Cached accessor
# --------------------------------------------------------------------------

_cache_lock = threading.Lock()
_cached: Optional[Calibration] = None
_cached_at: float = 0.0


def get_calibration(force: bool = False) -> Calibration:
    """
    TTL-cached calibration.

    The live `/estimate` endpoint is called every few seconds by every open
    student browser. Hitting MySQL with a five-table fit on each of those
    would make the DES engine the slowest part of a system whose entire
    selling point is that it is fast, so the fit is refreshed at most once
    per `calibration_ttl_seconds`.
    """
    global _cached, _cached_at

    ttl = get_settings().calibration_ttl_seconds
    now = time.time()

    with _cache_lock:
        fresh = _cached is not None and (now - _cached_at) < ttl
        if fresh and not force:
            return _cached  # type: ignore[return-value]

    fitted = fetch_calibration()

    with _cache_lock:
        _cached = fitted
        _cached_at = time.time()
    return fitted


def invalidate_calibration() -> None:
    global _cached, _cached_at
    with _cache_lock:
        _cached = None
        _cached_at = 0.0
