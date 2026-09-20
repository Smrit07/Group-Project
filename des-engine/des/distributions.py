"""
Random variate generation for the cafeteria model.

Two things here are not the textbook default, and both are deliberate:

1. Service times are lognormal, not exponential. Serving a thali has a
   floor — nobody is served in 3 seconds — and a long right tail when a
   student pays in coins or changes their mind. An exponential has its mode
   at zero, which would systematically understate the queue. Lognormal is
   the standard choice for human service times and is what the cafeteria
   observations in `service_events` actually look like.

2. Arrivals follow a non-stationary Poisson process. The whole problem
   statement in the report is that arrivals are *concentrated* in the
   09:00-10:00 break; a constant rate would model a problem the college
   does not have. We use Lewis & Shedler thinning, which generates a
   correct NHPP for any bounded intensity function.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import Callable, Sequence


class VariateStream:
    """
    A seeded random stream. Each replication gets its own, and within a
    replication each *use* (arrivals, service, balking) gets its own
    substream, so that changing the service-time distribution does not
    also shuffle the arrival pattern. That is common random numbers, and
    it is what makes two scenarios comparable: when the manager compares
    "2 counters" with "3 counters", the difference they see is the
    counters, not a different day's worth of students.
    """

    __slots__ = ("arrivals", "service", "behaviour", "seed")

    def __init__(self, seed: int):
        self.seed = seed
        # Widely separated derived seeds keep the substreams independent.
        self.arrivals = random.Random(seed * 7919 + 1)
        self.service = random.Random(seed * 7919 + 2)
        self.behaviour = random.Random(seed * 7919 + 3)


def lognormal_from_mean_cv(rng: random.Random, mean: float, cv: float) -> float:
    """
    Sample a lognormal specified by the mean and coefficient of variation
    of the *variate*, not of its log — which is how the calibration data
    arrives (we measure seconds at a counter, not log-seconds).

    Given mean m and cv c:
        sigma^2 = ln(1 + c^2)
        mu      = ln(m) - sigma^2 / 2
    """
    if mean <= 0:
        return 0.0
    if cv <= 0:
        return mean

    sigma_squared = math.log(1.0 + cv * cv)
    sigma = math.sqrt(sigma_squared)
    mu = math.log(mean) - sigma_squared / 2.0
    return rng.lognormvariate(mu, sigma)


def exponential(rng: random.Random, mean: float) -> float:
    if mean <= 0:
        return 0.0
    return rng.expovariate(1.0 / mean)


def triangular(rng: random.Random, low: float, mode: float, high: float) -> float:
    return rng.triangular(low, high, mode)


@dataclass(frozen=True)
class ArrivalProfile:
    """
    A piecewise-constant arrival intensity over the simulated session.

    `multipliers` scales the baseline arrival rate across equal-width slices
    of the horizon. The default shape reflects what the team observed at
    NAMI College: a trickle as the period ends, a hard spike in the first
    fifteen minutes of the break, then a decay.

        [0.35, 1.00, 1.45, 1.20, 0.80, 0.45]

    over a 60-minute break = six 10-minute bins. The area under the profile
    is normalised to 1.0 so that `base_rate_per_hour` keeps its plain
    meaning: total expected arrivals over one hour.
    """

    multipliers: Sequence[float] = (0.35, 1.00, 1.45, 1.20, 0.80, 0.45)
    horizon_minutes: float = 60.0

    def __post_init__(self) -> None:
        if not self.multipliers:
            raise ValueError("ArrivalProfile needs at least one multiplier.")
        if any(m < 0 for m in self.multipliers):
            raise ValueError("Arrival multipliers cannot be negative.")
        if self.horizon_minutes <= 0:
            raise ValueError("horizon_minutes must be positive.")

    @property
    def normalised(self) -> list[float]:
        average = sum(self.multipliers) / len(self.multipliers)
        if average == 0:
            return [0.0] * len(self.multipliers)
        return [m / average for m in self.multipliers]

    @property
    def peak_multiplier(self) -> float:
        norm = self.normalised
        return max(norm) if norm else 1.0

    def intensity_at(self, minute: float, base_rate_per_hour: float) -> float:
        """Instantaneous arrival rate, in students per minute, at `minute`."""
        norm = self.normalised
        bin_width = self.horizon_minutes / len(norm)
        index = int(minute // bin_width)
        if index < 0:
            index = 0
        elif index >= len(norm):
            index = len(norm) - 1
        return (base_rate_per_hour / 60.0) * norm[index]


def thinned_arrival_times(
    rng: random.Random,
    profile: ArrivalProfile,
    base_rate_per_hour: float,
    horizon_minutes: float,
) -> list[float]:
    """
    Generate arrival times for a non-stationary Poisson process by thinning
    (Lewis & Shedler, 1979).

    Sample candidate points from a homogeneous process at the *maximum*
    intensity lambda_max, then keep each candidate with probability
    lambda(t)/lambda_max. The survivors are a correct NHPP realisation.
    Simpler than inverting the cumulative intensity and, unlike the naive
    "resample the rate every 10 minutes" approach, it does not put a
    spurious renewal point at every bin boundary.
    """
    lambda_max = (base_rate_per_hour / 60.0) * profile.peak_multiplier
    if lambda_max <= 0:
        return []

    times: list[float] = []
    clock = 0.0
    # Hard cap: a defensive stop so a pathological rate can never hang the
    # HTTP request that triggered the run.
    ceiling = int(lambda_max * horizon_minutes * 10) + 1000

    while clock < horizon_minutes and len(times) < ceiling:
        clock += rng.expovariate(lambda_max)
        if clock >= horizon_minutes:
            break
        acceptance = profile.intensity_at(clock, base_rate_per_hour) / lambda_max
        if rng.random() < acceptance:
            times.append(clock)

    return times


def balk_probability(queue_length: int, tolerance: int, steepness: float = 0.45) -> float:
    """
    Probability that an arriving student takes one look at the queue and
    leaves. Modelled as a logistic curve centred on `tolerance`: below it
    almost nobody balks, above it the probability climbs smoothly rather
    than snapping from 0 to 1 at a hard threshold.

    This matters for the report's claim about reduced waiting: without
    balking, a badly staffed scenario shows an ever-growing queue and a
    huge average wait. With balking, it shows a *moderate* wait and a high
    balk rate — which is what actually happens in the dining hall, and is
    the more honest thing to put in front of a manager.
    """
    if tolerance <= 0:
        return 0.0
    exponent = -steepness * (queue_length - tolerance)
    # Guard against overflow at extreme queue lengths.
    if exponent > 50:
        return 0.0
    if exponent < -50:
        return 1.0
    return 1.0 / (1.0 + math.exp(exponent))


def staffing_speed_factor(counters_open: int, staff_count: int) -> float:
    """
    Convert a (counters, staff) pair into a multiplier on service time.

    The report treats counters and staff as two separate dials, so the model
    has to say what happens when they disagree:

    * staff < counters  -> counters cannot all be manned. The caller is
      responsible for clamping the effective counter count; this function
      returns 1.0 because each manned counter still runs at normal speed.
    * staff == counters -> one person per counter, the baseline. 1.0.
    * staff > counters  -> the surplus act as runners/second pairs of hands.
      Each extra person shaves service time, with diminishing returns, to a
      floor of 0.65 (you cannot serve a thali in less than about two-thirds
      of the normal time no matter how many people hover).
    """
    if counters_open <= 0:
        return 1.0

    surplus = max(0, staff_count - counters_open)
    if surplus == 0:
        return 1.0

    helpers_per_counter = surplus / counters_open
    # Exponential decay towards the 0.65 floor.
    factor = 0.65 + 0.35 * math.exp(-0.9 * helpers_per_counter)
    return max(0.65, min(1.0, factor))


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def describe_distribution(mean: float, cv: float) -> dict:
    """Human-readable distribution parameters, echoed back in the API
    response so a marker can see exactly what was simulated."""
    sigma_squared = math.log(1.0 + cv * cv) if cv > 0 else 0.0
    return {
        "family": "lognormal",
        "meanMinutes": round(mean, 3),
        "coefficientOfVariation": round(cv, 3),
        "mu": round(math.log(mean) - sigma_squared / 2.0, 4) if mean > 0 else None,
        "sigma": round(math.sqrt(sigma_squared), 4),
    }


# Exposed so callers can type-annotate an injected intensity function in
# tests without importing ArrivalProfile.
IntensityFunction = Callable[[float], float]
