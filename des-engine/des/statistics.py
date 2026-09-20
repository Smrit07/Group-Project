"""
Output analysis for the cafeteria DES model.

A single simulation run is one sample from a random process, so a single
run tells you almost nothing. Section 6.3 of the proposal asks for
"prediction accuracy", which only means something if the prediction comes
with an interval. Everything in this module exists to turn a set of
independent replications into point estimates plus 95% confidence
intervals, using the method of independent replications (Law, *Simulation
Modeling and Analysis*, ch. 9).

Deliberately dependency-free: numpy/scipy are not installed by the
requirements file, because the marking environment is a student laptop
running XAMPP and the fewer wheels that have to compile, the better.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Iterable, Sequence

# Two-sided t critical values at alpha = 0.05, indexed by degrees of freedom.
# We only ever run a modest number of replications (3-60), so a lookup table
# is exact where it matters and falls back to the normal approximation above
# 30 df, where the difference is under 2%.
_T_CRITICAL_95 = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
    6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
    16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
    21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
    26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
}
_Z_CRITICAL_95 = 1.960


def t_critical_95(degrees_of_freedom: int) -> float:
    """Two-sided 95% critical value, normal-approximated beyond 30 df."""
    if degrees_of_freedom <= 0:
        return float("nan")
    return _T_CRITICAL_95.get(degrees_of_freedom, _Z_CRITICAL_95)


@dataclass(frozen=True)
class Summary:
    """Point estimate of one performance measure across replications."""

    mean: float
    stdev: float
    half_width: float          # 95% CI half-width
    ci_low: float
    ci_high: float
    minimum: float
    maximum: float
    replications: int

    @property
    def relative_precision(self) -> float:
        """half_width / mean — the usual "is this run long enough?" test."""
        if self.mean == 0:
            return float("inf")
        return abs(self.half_width / self.mean)

    def to_dict(self, places: int = 2) -> dict:
        out = asdict(self)
        for key, value in out.items():
            if isinstance(value, float):
                out[key] = None if math.isnan(value) else round(value, places)
        return out


def summarise(samples: Sequence[float]) -> Summary:
    """Mean, sample standard deviation and 95% CI over replication outputs."""
    clean = [float(x) for x in samples if x is not None and not math.isnan(float(x))]
    n = len(clean)

    if n == 0:
        nan = float("nan")
        return Summary(nan, nan, nan, nan, nan, nan, nan, 0)
    if n == 1:
        only = clean[0]
        return Summary(only, 0.0, 0.0, only, only, only, only, 1)

    mean = sum(clean) / n
    variance = sum((x - mean) ** 2 for x in clean) / (n - 1)
    stdev = math.sqrt(variance)
    half_width = t_critical_95(n - 1) * stdev / math.sqrt(n)

    return Summary(
        mean=mean,
        stdev=stdev,
        half_width=half_width,
        ci_low=mean - half_width,
        ci_high=mean + half_width,
        minimum=min(clean),
        maximum=max(clean),
        replications=n,
    )


def percentile(samples: Sequence[float], q: float) -> float:
    """
    Linear-interpolated percentile (the same definition numpy uses by
    default), so the p90 wait we report to the manager is reproducible
    against any other tool they check it with.
    """
    clean = sorted(float(x) for x in samples if x is not None)
    if not clean:
        return float("nan")
    if len(clean) == 1:
        return clean[0]

    rank = (q / 100.0) * (len(clean) - 1)
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return clean[int(rank)]
    weight = rank - lower
    return clean[lower] * (1 - weight) + clean[upper] * weight


class TimeWeightedAccumulator:
    """
    Time-weighted mean of a step function — the correct way to average a
    queue length, which is a level that persists between events rather than
    a value observed at evenly spaced instants.

    Averaging `len(queue)` at each arrival instead would bias the result
    upwards, because arrivals are themselves more frequent when the queue
    is building.
    """

    __slots__ = ("_area", "_last_time", "_last_value", "_maximum", "_start")

    def __init__(self, start_time: float = 0.0, initial_value: float = 0.0):
        self._start = start_time
        self._last_time = start_time
        self._last_value = initial_value
        self._area = 0.0
        self._maximum = initial_value

    def update(self, now: float, value: float) -> None:
        self._area += self._last_value * (now - self._last_time)
        self._last_time = now
        self._last_value = value
        if value > self._maximum:
            self._maximum = value

    def close(self, now: float) -> None:
        """Flush the final segment so the last level is not silently dropped."""
        self._area += self._last_value * (now - self._last_time)
        self._last_time = now

    def reset(self, now: float) -> None:
        """Discard everything accumulated so far — used to drop the warm-up."""
        self._area = 0.0
        self._start = now
        self._last_time = now
        self._maximum = self._last_value

    @property
    def mean(self) -> float:
        elapsed = self._last_time - self._start
        return self._area / elapsed if elapsed > 0 else 0.0

    @property
    def maximum(self) -> float:
        return self._maximum


def welch_moving_average(series: Iterable[float], window: int = 5) -> list[float]:
    """
    Welch's moving average, used to eyeball where the warm-up period ends
    when re-tuning `WARMUP_MINUTES`. Not called on the hot path — it exists
    so the warm-up length in the config is a justified number rather than a
    guess, which is the sort of thing a viva question lands on.
    """
    values = list(series)
    if window < 1 or not values:
        return values

    smoothed: list[float] = []
    for i in range(len(values)):
        span = min(i, len(values) - i - 1, window)
        chunk = values[i - span: i + span + 1]
        smoothed.append(sum(chunk) / len(chunk))
    return smoothed
