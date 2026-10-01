"""
UT-09  runScenario(params) - 2 counters vs 3 counters -> average wait + confidence interval for both

Requirements: FR-12, FR-13, FR-04

Unlike the Node tests, this runs the REAL SimPy model from ../../des-engine.
No MySQL is needed: database calibration is switched off so the engine uses its built-in defaults.

Run:   python -m unittest discover -s python -v        (from the unit-tests folder)
"""
import math
import os
import sys
import unittest
from pathlib import Path

# --- locate the engine -------------------------------------------------------------------
ENGINE_DIR = Path(
    os.environ.get("DES_ENGINE_DIR", Path(__file__).resolve().parents[2] / "des-engine")
).resolve()
if not (ENGINE_DIR / "des" / "engine.py").exists():
    raise SystemExit(
        f"Could not find the DES engine at {ENGINE_DIR}\n"
        "Put the unit-tests folder next to 'des-engine', or set DES_ENGINE_DIR."
    )

os.environ["DES_USE_DB_CALIBRATION"] = "false"   # use built-in defaults, never touch MySQL
sys.path.insert(0, str(ENGINE_DIR))

try:
    from des.engine import run_scenario, estimate_wait, clear_caches   # noqa: E402
    from des.statistics import summarise, t_critical_95                # noqa: E402
except ModuleNotFoundError as err:                                      # pragma: no cover
    raise SystemExit(
        f"{err}\nInstall the engine dependencies first:  pip install -r {ENGINE_DIR / 'requirements.txt'}"
    )

# Small + fast: 5 replications, no sensitivity sweep. Same seed => common random numbers.
FAST = {"replications": 5, "includeSensitivity": False, "seed": 2026, "arrivalRatePerHour": 300}


def scenario(counters: int, **overrides) -> dict:
    return run_scenario({**FAST, "countersOpen": counters, "staffCount": counters, **overrides})


class UT09RunScenario(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        clear_caches()
        cls.two = scenario(2)
        cls.three = scenario(3)

    # ---- the UT-09 case itself -------------------------------------------------------
    def test_both_scenarios_return_average_wait(self):
        for label, result in (("2 counters", self.two), ("3 counters", self.three)):
            with self.subTest(label):
                self.assertIsInstance(result["avgWaitMinutes"], (int, float))
                self.assertGreaterEqual(result["avgWaitMinutes"], 0)

    def test_both_scenarios_return_a_95_percent_confidence_interval(self):
        for label, result in (("2 counters", self.two), ("3 counters", self.three)):
            with self.subTest(label):
                wait = result["metrics"]["meanWaitMinutes"]
                for key in ("mean", "ci_low", "ci_high", "half_width", "replications"):
                    self.assertIn(key, wait)
                self.assertLessEqual(wait["ci_low"], wait["mean"])
                self.assertLessEqual(wait["mean"], wait["ci_high"])
                self.assertGreater(wait["half_width"], 0)
                self.assertGreaterEqual(wait["replications"], 5)
                # headline figure is the mean of the same CI
                self.assertAlmostEqual(result["avgWaitMinutes"], wait["mean"], places=1)

    def test_an_extra_counter_reduces_the_wait(self):
        self.assertLess(self.three["avgWaitMinutes"], self.two["avgWaitMinutes"])

    def test_scenario_echoes_the_counters_that_were_asked_for(self):
        self.assertEqual(self.two["scenario"]["countersOpen"], 2)
        self.assertEqual(self.three["scenario"]["countersOpen"], 3)

    # ---- other properties the report relies on ---------------------------------------
    def test_results_are_reproducible_with_the_same_seed(self):
        again = scenario(2)
        self.assertEqual(again["avgWaitMinutes"], self.two["avgWaitMinutes"])

    def test_output_is_labelled_as_an_estimate_FR04(self):
        self.assertIn("estimate", self.two["disclaimer"].lower())

    def test_other_headline_figures_are_present(self):
        for key in ("p90WaitMinutes", "maxQueueLength", "counterUtilisationPercent", "throughputPerHour", "verdict"):
            self.assertIn(key, self.two)

    def test_p90_wait_is_not_below_the_average(self):
        self.assertGreaterEqual(self.two["p90WaitMinutes"], self.two["avgWaitMinutes"])

    def test_more_arrivals_means_longer_waits(self):
        quiet = scenario(2, arrivalRatePerHour=150)
        busy = scenario(2, arrivalRatePerHour=400)
        self.assertLess(quiet["avgWaitMinutes"], busy["avgWaitMinutes"])

    def test_invalid_parameters_are_rejected_not_silently_simulated(self):
        with self.assertRaises(ValueError):
            run_scenario({**FAST, "countersOpen": 0, "staffCount": 1})


class UT09Statistics(unittest.TestCase):
    """The confidence-interval maths, checked against a hand calculation."""

    def test_summarise_known_sample(self):
        # samples 10,12,14,16,18: mean 14, sample stdev sqrt(10), t(4 df, 95%) = 2.776
        s = summarise([10, 12, 14, 16, 18])
        expected_half_width = 2.776 * math.sqrt(10) / math.sqrt(5)
        self.assertAlmostEqual(s.mean, 14.0)
        self.assertAlmostEqual(s.stdev, math.sqrt(10))
        self.assertAlmostEqual(s.half_width, expected_half_width, places=6)
        self.assertAlmostEqual(s.ci_low, 14 - expected_half_width, places=6)
        self.assertAlmostEqual(s.ci_high, 14 + expected_half_width, places=6)
        self.assertEqual(s.replications, 5)

    def test_identical_samples_have_a_zero_width_interval(self):
        s = summarise([5, 5, 5, 5])
        self.assertEqual(s.mean, 5)
        self.assertEqual(s.half_width, 0)

    def test_more_replications_narrow_the_interval(self):
        few = summarise([10, 14, 12, 16, 8])
        many = summarise([10, 14, 12, 16, 8] * 6)
        self.assertLess(many.half_width, few.half_width)

    def test_critical_values(self):
        self.assertEqual(t_critical_95(4), 2.776)
        self.assertEqual(t_critical_95(10), 2.228)
        self.assertEqual(t_critical_95(1000), 1.96)          # normal approximation
        self.assertTrue(math.isnan(t_critical_95(0)))


class UT04LiveEstimate(unittest.TestCase):
    """The DES-based live estimate used by the student queue banner (FR-03, FR-04)."""

    def test_estimate_is_labelled_and_complete(self):
        clear_caches()
        result = estimate_wait({"queueLength": 6, "openCounters": 2})
        self.assertTrue(result["isEstimate"])
        self.assertEqual(result["source"], "des_model")
        self.assertEqual(result["queueLength"], 6)
        self.assertGreaterEqual(result["estimatedWaitMinutes"], 0)
        self.assertGreaterEqual(result["p90WaitMinutes"], result["estimatedWaitMinutes"])

    def test_longer_queue_means_longer_estimate(self):
        clear_caches()
        short = estimate_wait({"queueLength": 2, "openCounters": 2})
        long_ = estimate_wait({"queueLength": 30, "openCounters": 2})
        self.assertLess(short["estimatedWaitMinutes"], long_["estimatedWaitMinutes"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
