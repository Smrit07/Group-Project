"""
Configuration for the DES engine.

Every number that a marker could reasonably ask "where did that come from?"
lives here with a comment saying where it came from, rather than being
buried as a literal three files deep. Defaults are the values the team
measured during the timed observations described in Section 3 of the final
report; each can be overridden from `.env` without touching code, which is
what NFR "maintainability without code changes" asks for.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Optional

try:  # python-dotenv is in requirements.txt but the engine must not die without it
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover - trivial fallback
    pass


def _env_float(key: str, default: float) -> float:
    raw = os.getenv(key)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(key: str, default: int) -> int:
    raw = os.getenv(key)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(float(raw))
    except ValueError:
        return default


def _env_bool(key: str, default: bool) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_multipliers(key: str, default: tuple[float, ...]) -> tuple[float, ...]:
    """Parse a comma-separated arrival profile, e.g. '0.35,1.0,1.45,1.2,0.8,0.45'."""
    raw = os.getenv(key)
    if not raw:
        return default
    try:
        parsed = tuple(float(part) for part in raw.split(",") if part.strip())
        return parsed if parsed else default
    except ValueError:
        return default


@dataclass(frozen=True)
class DatabaseSettings:
    """
    Connection details for XAMPP's MySQL. Note the default user/password:
    XAMPP ships with root and an empty password, and the calibration reader
    only ever issues SELECTs, so it is given the same credentials as the
    Node backend rather than a second account the student has to remember
    to create.
    """

    host: str = field(default_factory=lambda: os.getenv("DB_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("DB_PORT", 3306))
    user: str = field(default_factory=lambda: os.getenv("DB_USER", "root"))
    password: str = field(default_factory=lambda: os.getenv("DB_PASSWORD", ""))
    database: str = field(default_factory=lambda: os.getenv("DB_NAME", "smart_cafeteria"))
    connect_timeout: int = field(default_factory=lambda: _env_int("DB_CONNECT_TIMEOUT", 4))

    @property
    def enabled(self) -> bool:
        """Calibration from live data is opt-out, so a fresh clone with no
        database still starts and serves estimates from the defaults."""
        return _env_bool("DES_USE_DB_CALIBRATION", True)


@dataclass(frozen=True)
class ModelDefaults:
    """Baseline model parameters, all in minutes unless stated otherwise."""

    # Timed at the counters over several peak periods: a walk-in student
    # takes about 2.5 minutes from reaching the front to leaving with food.
    service_mean_minutes: float = field(
        default_factory=lambda: _env_float("DES_SERVICE_MEAN_MINUTES", 2.5)
    )
    # CV of 0.45 -> a fairly tight spread with a modest right tail, which is
    # what the observed service times showed. cv=1.0 would be exponential.
    service_cv: float = field(default_factory=lambda: _env_float("DES_SERVICE_CV", 0.45))

    # Collecting a pre-ordered, already-plated meal is much quicker than
    # ordering from scratch — this is the entire mechanism by which
    # pre-ordering is supposed to shorten the queue (FR-06).
    pickup_mean_minutes: float = field(
        default_factory=lambda: _env_float("DES_PICKUP_MEAN_MINUTES", 0.6)
    )
    pickup_cv: float = field(default_factory=lambda: _env_float("DES_PICKUP_CV", 0.35))

    # Share of demand arriving as a pre-order rather than a walk-in. 0.0 is
    # the "before our system existed" baseline the evaluation compares against.
    preorder_share: float = field(default_factory=lambda: _env_float("DES_PREORDER_SHARE", 0.0))

    # Students will tolerate roughly this many people ahead of them before
    # some start giving up and leaving (see distributions.balk_probability).
    balk_tolerance: int = field(default_factory=lambda: _env_int("DES_BALK_TOLERANCE", 18))
    balk_steepness: float = field(default_factory=lambda: _env_float("DES_BALK_STEEPNESS", 0.45))

    # Break length at NAMI College: 09:00-10:00.
    horizon_minutes: float = field(default_factory=lambda: _env_float("DES_HORIZON_MINUTES", 60.0))

    # Ten-minute bins across the hour. See ArrivalProfile for the shape.
    arrival_multipliers: tuple[float, ...] = field(
        default_factory=lambda: _env_multipliers(
            "DES_ARRIVAL_MULTIPLIERS", (0.35, 1.00, 1.45, 1.20, 0.80, 0.45)
        )
    )

    # Warm-up: the model starts with an empty cafeteria, which is optimistic
    # for the first few minutes. Statistics collected before this point are
    # discarded. 5 minutes was chosen by inspecting a Welch moving average of
    # queue length across 30 pilot replications (see statistics.welch_moving_average).
    warmup_minutes: float = field(default_factory=lambda: _env_float("DES_WARMUP_MINUTES", 5.0))

    # Replication counts. The full scenario endpoint can afford to be
    # thorough; the live estimate endpoint is called from a user-facing page
    # and has a 1.5 s budget on the Node side, so it runs far fewer.
    scenario_replications: int = field(
        default_factory=lambda: _env_int("DES_SCENARIO_REPLICATIONS", 30)
    )
    estimate_replications: int = field(
        default_factory=lambda: _env_int("DES_ESTIMATE_REPLICATIONS", 8)
    )
    max_replications: int = field(default_factory=lambda: _env_int("DES_MAX_REPLICATIONS", 200))

    # Master seed. Fixed by default so that a demo re-run in front of the
    # module leader produces the same numbers as the screenshots in the report.
    base_seed: int = field(default_factory=lambda: _env_int("DES_BASE_SEED", 20261007))

    # Hard ceiling on a single /simulate request, so a silly parameter set
    # cannot tie up the Flask worker indefinitely.
    max_runtime_seconds: float = field(
        default_factory=lambda: _env_float("DES_MAX_RUNTIME_SECONDS", 20.0)
    )


@dataclass(frozen=True)
class EngineSettings:
    host: str = field(default_factory=lambda: os.getenv("DES_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("DES_PORT", 5001))
    debug: bool = field(default_factory=lambda: _env_bool("DES_DEBUG", False))

    # How long a calibration snapshot is trusted before it is refetched.
    calibration_ttl_seconds: int = field(
        default_factory=lambda: _env_int("DES_CALIBRATION_TTL_SECONDS", 600)
    )
    # Minimum observations before live data is allowed to override the
    # measured defaults. Calibrating off four data points is worse than not
    # calibrating at all.
    calibration_min_samples: int = field(
        default_factory=lambda: _env_int("DES_CALIBRATION_MIN_SAMPLES", 30)
    )
    # Cache TTL for the live /estimate fast path.
    estimate_cache_ttl_seconds: int = field(
        default_factory=lambda: _env_int("DES_ESTIMATE_CACHE_TTL_SECONDS", 20)
    )

    database: DatabaseSettings = field(default_factory=DatabaseSettings)
    model: ModelDefaults = field(default_factory=ModelDefaults)

    # Optional shared secret. If set, the Node backend must send it as
    # X-DES-Key. Left unset for local XAMPP development, where the engine is
    # bound to 127.0.0.1 anyway and is not reachable from the campus network.
    api_key: Optional[str] = field(default_factory=lambda: os.getenv("DES_API_KEY") or None)


_settings: Optional[EngineSettings] = None


def get_settings() -> EngineSettings:
    """Process-wide singleton so every module sees the same configuration."""
    global _settings
    if _settings is None:
        _settings = EngineSettings()
    return _settings
