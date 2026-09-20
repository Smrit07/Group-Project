"""
The SimPy model of the NAMI College cafeteria.

Entities
--------
Student            arrives, sizes up the queue, may balk, otherwise joins the
                   shortest counter queue, is served, leaves.
Counter            a physical serving point. One at a time, priority-ordered
                   so that a pre-order collection can slot in ahead of a
                   walk-in — which is what actually happens when someone
                   turns up to collect a bag that is already packed.

Events
------
arrival, balk, start-of-service, end-of-service, end-of-horizon, end-of-warmup.

Design notes that matter for the write-up
-----------------------------------------
* Queues are *per counter*, not one shared line. A single shared line with
  c servers (M/G/c) is mathematically nicer and gives shorter waits, but the
  NAMI cafeteria has separate physical lines at each counter, and modelling
  it as M/G/c would make the simulation flatter than reality. Students join
  the shortest line on arrival (join-shortest-queue) and do not jockey
  afterwards, which matches observation.

* `counters_open` is clamped by `staff_count`: you cannot run a counter with
  nobody behind it. Surplus staff instead speed every counter up, with
  diminishing returns. This is the part of the model the manager's "what-if"
  question actually turns on, so it is explicit rather than implied.

* Statistics collected before `warmup_minutes` are discarded. The model
  starts empty, which is not what 09:05 looks like.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, replace
from typing import Optional

import simpy

from .distributions import (
    ArrivalProfile,
    VariateStream,
    balk_probability,
    lognormal_from_mean_cv,
    staffing_speed_factor,
    thinned_arrival_times,
)
from .statistics import TimeWeightedAccumulator, percentile


# --------------------------------------------------------------------------
# Parameters
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class ScenarioParameters:
    """One fully-specified what-if scenario. Immutable so a parameter set can
    be safely reused as a cache key and echoed back in the API response."""

    counters_open: int
    staff_count: int
    arrival_rate_per_hour: float

    service_mean_minutes: float = 2.5
    service_cv: float = 0.45
    pickup_mean_minutes: float = 0.6
    pickup_cv: float = 0.35
    preorder_share: float = 0.0

    horizon_minutes: float = 60.0
    warmup_minutes: float = 5.0

    balk_tolerance: int = 18
    balk_steepness: float = 0.45

    # Live state injection: students already queueing when the clock starts.
    # This is what turns a generic model into a prediction about *right now*,
    # and is the reason /estimate can answer "how long if I walk over".
    initial_queue_length: int = 0

    arrival_multipliers: tuple[float, ...] = (0.35, 1.00, 1.45, 1.20, 0.80, 0.45)

    def validated(self) -> "ScenarioParameters":
        """Coerce into a runnable range and raise on anything nonsensical.

        Validation lives on the parameter object rather than in the Flask
        layer so that the model cannot be driven into an invalid state by a
        future caller that forgets to check.
        """
        errors: list[str] = []

        if self.counters_open < 1:
            errors.append("countersOpen must be at least 1.")
        if self.counters_open > 20:
            errors.append("countersOpen above 20 is outside the modelled range.")
        if self.staff_count < 1:
            errors.append("staffCount must be at least 1.")
        if self.staff_count > 60:
            errors.append("staffCount above 60 is outside the modelled range.")
        if self.arrival_rate_per_hour <= 0:
            errors.append("arrivalRatePerHour must be greater than 0.")
        if self.arrival_rate_per_hour > 3000:
            errors.append("arrivalRatePerHour above 3000 is outside the modelled range.")
        if not (0.0 <= self.preorder_share <= 1.0):
            errors.append("preorderShare must be between 0 and 1.")
        if self.service_mean_minutes <= 0:
            errors.append("serviceMeanMinutes must be greater than 0.")
        if self.horizon_minutes <= 0 or self.horizon_minutes > 600:
            errors.append("horizonMinutes must be between 1 and 600.")
        if self.warmup_minutes < 0 or self.warmup_minutes >= self.horizon_minutes:
            errors.append("warmupMinutes must be non-negative and shorter than the horizon.")
        if self.initial_queue_length < 0 or self.initial_queue_length > 2000:
            errors.append("initialQueueLength must be between 0 and 2000.")

        if errors:
            raise ValueError(" ".join(errors))
        return self

    # -- derived quantities -------------------------------------------------

    @property
    def effective_counters(self) -> int:
        """Counters that can actually be manned."""
        return max(1, min(self.counters_open, self.staff_count))

    @property
    def speed_factor(self) -> float:
        return staffing_speed_factor(self.effective_counters, self.staff_count)

    @property
    def understaffed_by(self) -> int:
        """Counters the manager thinks are open but has nobody to run."""
        return max(0, self.counters_open - self.staff_count)

    @property
    def offered_load(self) -> float:
        """
        rho = lambda * E[S] / c, averaged over the horizon.

        Above 1.0 the cafeteria cannot keep up and the queue grows without
        bound (bounded here only by balking and the end of the break). We
        report it so a manager can see *why* a scenario is bad rather than
        only that it is.
        """
        walkin = (1.0 - self.preorder_share) * self.service_mean_minutes
        pickup = self.preorder_share * self.pickup_mean_minutes
        mean_service = (walkin + pickup) * self.speed_factor
        per_minute = self.arrival_rate_per_hour / 60.0
        return (per_minute * mean_service) / self.effective_counters

    @property
    def peak_offered_load(self) -> float:
        """Offered load during the busiest arrival bin — the number that
        actually predicts whether the 09:15 crush falls over."""
        profile = ArrivalProfile(tuple(self.arrival_multipliers), self.horizon_minutes)
        return self.offered_load * profile.peak_multiplier


# --------------------------------------------------------------------------
# Results
# --------------------------------------------------------------------------

@dataclass
class ReplicationResult:
    """Output of a single independent run."""

    seed: int
    arrivals: int = 0
    served: int = 0
    balked: int = 0
    unserved_at_close: int = 0

    mean_wait_minutes: float = 0.0
    p90_wait_minutes: float = 0.0
    max_wait_minutes: float = 0.0
    mean_queue_length: float = 0.0
    max_queue_length: float = 0.0
    counter_utilisation: float = 0.0
    throughput_per_hour: float = 0.0
    balk_rate: float = 0.0

    waits: list[float] = field(default_factory=list, repr=False)


# --------------------------------------------------------------------------
# The model
# --------------------------------------------------------------------------

class CafeteriaModel:
    """
    One replication. Construct, call `run()`, read the `ReplicationResult`.

    A fresh instance per replication keeps state isolation obvious — there is
    no reset path to get subtly wrong, which is the usual source of
    "my second replication looks nothing like my first".
    """

    def __init__(self, params: ScenarioParameters, seed: int):
        self.params = params
        self.seed = seed
        self.rng = VariateStream(seed)
        self.env = simpy.Environment()

        counters = params.effective_counters
        # PriorityResource: lower priority value is served first, so a
        # pre-order collection (priority 0) goes ahead of a walk-in (1).
        self.counters = [simpy.PriorityResource(self.env, capacity=1) for _ in range(counters)]
        self.counter_queue_sizes = [0] * counters

        self.profile = ArrivalProfile(tuple(params.arrival_multipliers), params.horizon_minutes)

        # --- statistics ---
        self.waiting = 0
        self.queue_accumulator = TimeWeightedAccumulator(0.0, 0.0)
        self.busy_accumulator = TimeWeightedAccumulator(0.0, 0.0)
        self.busy_servers = 0

        self.waits: list[float] = []
        self.arrivals = 0
        self.served = 0
        self.balked = 0
        self.warm = params.warmup_minutes <= 0

    # -- helpers ------------------------------------------------------------

    def _shortest_counter(self) -> int:
        """Join-shortest-queue, ties broken by index (students drift left)."""
        best = 0
        best_size = self.counter_queue_sizes[0]
        for index in range(1, len(self.counter_queue_sizes)):
            if self.counter_queue_sizes[index] < best_size:
                best = index
                best_size = self.counter_queue_sizes[index]
        return best

    def _sample_service(self, is_pickup: bool) -> float:
        params = self.params
        if is_pickup:
            raw = lognormal_from_mean_cv(
                self.rng.service, params.pickup_mean_minutes, params.pickup_cv
            )
        else:
            raw = lognormal_from_mean_cv(
                self.rng.service, params.service_mean_minutes, params.service_cv
            )
        # Surplus staff act as helpers; a floor keeps the sample physical.
        return max(0.05, raw * params.speed_factor)

    def _set_waiting(self, delta: int) -> None:
        self.waiting += delta
        self.queue_accumulator.update(self.env.now, self.waiting)

    def _set_busy(self, delta: int) -> None:
        self.busy_servers += delta
        self.busy_accumulator.update(self.env.now, self.busy_servers)

    # -- processes ----------------------------------------------------------

    def _warmup_process(self):
        """Discard everything gathered during the transient start-up."""
        yield self.env.timeout(self.params.warmup_minutes)
        self.warm = True
        self.waits.clear()
        self.arrivals = 0
        self.served = 0
        self.balked = 0
        self.queue_accumulator.reset(self.env.now)
        self.busy_accumulator.reset(self.env.now)

    def _arrival_process(self):
        """
        Pre-generate the whole NHPP realisation, then walk it.

        Generating up front rather than sampling an inter-arrival gap inside
        the loop keeps the arrival stream identical across scenarios that
        share a seed — the common-random-numbers property that makes
        "2 counters vs 3 counters" an honest comparison.
        """
        times = thinned_arrival_times(
            self.rng.arrivals,
            self.profile,
            self.params.arrival_rate_per_hour,
            self.params.horizon_minutes,
        )

        previous = 0.0
        for arrival_time in times:
            yield self.env.timeout(arrival_time - previous)
            previous = arrival_time
            is_pickup = self.rng.behaviour.random() < self.params.preorder_share
            self.env.process(self._student(is_pickup=is_pickup, can_balk=not is_pickup))

    def _seed_initial_queue(self):
        """
        Inject the students who are already standing there at t=0.

        Spread across the counters rather than all dumped on counter 1, and
        flagged `can_balk=False` — someone already in the line has, by
        definition, decided not to balk.
        """
        for _ in range(self.params.initial_queue_length):
            self.env.process(self._student(is_pickup=False, can_balk=False))
        # Yield once so this is a valid generator and the processes are
        # registered before the clock advances.
        yield self.env.timeout(0)

    def _student(self, is_pickup: bool, can_balk: bool):
        if self.warm:
            self.arrivals += 1

        # --- balking decision, taken on the total visible line ---
        if can_balk:
            probability = balk_probability(
                self.waiting, self.params.balk_tolerance, self.params.balk_steepness
            )
            if self.rng.behaviour.random() < probability:
                if self.warm:
                    self.balked += 1
                return

        index = self._shortest_counter()
        counter = self.counters[index]
        self.counter_queue_sizes[index] += 1

        joined_at = self.env.now
        self._set_waiting(+1)

        priority = 0 if is_pickup else 1
        with counter.request(priority=priority) as request:
            yield request

            wait = self.env.now - joined_at
            self._set_waiting(-1)
            self.counter_queue_sizes[index] -= 1
            self._set_busy(+1)

            if self.warm:
                self.waits.append(wait)

            yield self.env.timeout(self._sample_service(is_pickup))

            self._set_busy(-1)
            if self.warm:
                self.served += 1

    # -- driver -------------------------------------------------------------

    def run(self) -> ReplicationResult:
        params = self.params

        if params.warmup_minutes > 0:
            self.env.process(self._warmup_process())
        self.env.process(self._seed_initial_queue())
        self.env.process(self._arrival_process())

        self.env.run(until=params.horizon_minutes)

        # Close the time-weighted accumulators at the horizon so the final
        # level is counted rather than dropped.
        self.queue_accumulator.close(params.horizon_minutes)
        self.busy_accumulator.close(params.horizon_minutes)

        observed_minutes = max(1e-9, params.horizon_minutes - params.warmup_minutes)
        counters = params.effective_counters

        result = ReplicationResult(seed=self.seed)
        result.arrivals = self.arrivals
        result.served = self.served
        result.balked = self.balked
        result.unserved_at_close = self.waiting
        result.waits = list(self.waits)

        if self.waits:
            result.mean_wait_minutes = sum(self.waits) / len(self.waits)
            result.p90_wait_minutes = percentile(self.waits, 90)
            result.max_wait_minutes = max(self.waits)

        result.mean_queue_length = self.queue_accumulator.mean
        result.max_queue_length = self.queue_accumulator.maximum
        result.counter_utilisation = min(1.0, self.busy_accumulator.mean / counters)
        result.throughput_per_hour = self.served * (60.0 / observed_minutes)
        total_offered = self.served + self.balked + self.waiting
        result.balk_rate = (self.balked / total_offered) if total_offered else 0.0

        return result


def run_replication(params: ScenarioParameters, seed: int) -> ReplicationResult:
    """Convenience wrapper — one model, one run, one result."""
    return CafeteriaModel(params, seed).run()


def run_replications(
    params: ScenarioParameters,
    count: int,
    base_seed: int,
    deadline_seconds: Optional[float] = None,
) -> list[ReplicationResult]:
    """
    Independent replications, seeded `base_seed + i`.

    `deadline_seconds` is a wall-clock guard: if a caller asks for 30
    replications of a scenario that happens to be expensive, we return the
    replications we finished rather than holding the HTTP connection open.
    The reported confidence interval then honestly reflects the smaller
    sample, which is better than a timeout with no answer at all.
    """
    params = params.validated()
    started = time.monotonic()
    results: list[ReplicationResult] = []

    for index in range(count):
        results.append(run_replication(params, base_seed + index))
        if deadline_seconds is not None and (time.monotonic() - started) > deadline_seconds:
            break

    return results


def with_overrides(params: ScenarioParameters, **overrides) -> ScenarioParameters:
    """Typed copy-with-changes, used by the comparison endpoint."""
    return replace(params, **overrides)
