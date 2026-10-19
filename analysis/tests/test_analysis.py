"""
Unit tests for the analysis pipeline (thesis spec Section 15: "Unit tests
for all new modules"). Uses Python's stdlib unittest — no extra test
dependency needed beyond what's already in requirements.txt.

Run from the analysis/ directory:
    python3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from descriptive_stats import describe, ci95, compute_statistics  # noqa: E402
from comparative import build_comparative  # noqa: E402
from t_test import run_test, looks_normal  # noqa: E402
from summary import build_summary  # noqa: E402
from common import load_csv, load_experiment  # noqa: E402


def write_csv(path: str, rows: list[dict]):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pd.DataFrame(rows).to_csv(path, index=False)


class TestDescribe(unittest.TestCase):
    def test_empty_series_returns_zero_n_and_none_stats(self):
        result = describe(pd.Series(dtype=float))
        self.assertEqual(result["n"], 0)
        self.assertIsNone(result["mean"])

    def test_known_values_produce_correct_mean_median(self):
        result = describe(pd.Series([1, 2, 3, 4, 5]))
        self.assertEqual(result["n"], 5)
        self.assertEqual(result["mean"], 3.0)
        self.assertEqual(result["median"], 3.0)
        self.assertEqual(result["min"], 1.0)
        self.assertEqual(result["max"], 5.0)

    def test_single_value_has_zero_variance_and_stddev(self):
        result = describe(pd.Series([42.0]))
        self.assertEqual(result["n"], 1)
        self.assertEqual(result["variance"], 0.0)
        self.assertEqual(result["stddev"], 0.0)

    def test_non_numeric_values_are_dropped_not_errored(self):
        result = describe(pd.Series(["a", "b", 3, 4]))
        self.assertEqual(result["n"], 2)  # only 3 and 4 are numeric

    def test_ci95_widens_with_more_variance(self):
        tight = pd.Series([10, 10.1, 9.9, 10.05, 9.95])
        wide = pd.Series([1, 20, 5, 15, 8])
        lo_t, hi_t = ci95(tight)
        lo_w, hi_w = ci95(wide)
        self.assertLess(hi_t - lo_t, hi_w - lo_w)


class TestComparativeAndPipeline(unittest.TestCase):
    """Exercises the pipeline against a small synthetic experiment directory."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        for system, tps_base, latency_base in [("classical", 20, 15), ("hybrid", 10, 30)]:
            base = os.path.join(self.tmpdir, system)
            write_csv(os.path.join(base, "transactions.csv"), [
                {
                    "transactionId": f"tx-{i}", "blockchainType": system.capitalize(), "nodeId": f"{system}-1",
                    "nodeRole": "miner", "blockNumber": i // 5, "latencyMs": latency_base + i,
                    "eccSignGenMs": 0.5, "pqSignGenMs": (2.0 if system == "hybrid" else None),
                    "combinedSignGenMs": 0.5 if system == "classical" else 2.5,
                    "combinedVerifyMs": 0.4 if system == "classical" else 2.1,
                    "totalSignatureProcessingMs": 1.0, "sizeBytes": 300 if system == "classical" else 3300,
                    "accepted": True, "failureReason": None,
                }
                for i in range(10)
            ])
            write_csv(os.path.join(base, "blocks.csv"), [
                {"blockchainType": system.capitalize(), "nodeId": f"{system}-1", "blockHeight": i,
                 "blockSizeBytes": 1000 if system == "classical" else 9000,
                 "miningTimeMs": 100 + i, "hashingTimeMs": 0.01, "validationTimeMs": 0.02}
                for i in range(3)
            ])
            write_csv(os.path.join(base, "nodes.csv"), [
                {"nodeId": f"{system}-1", "blockchainType": system.capitalize(), "cpuPercent": 10 + i,
                 "memoryMb": 50 + i, "messagesSent": i * 2, "messagesReceived": i}
                for i in range(5)
            ])
            write_csv(os.path.join(base, "benchmark.csv"), [
                {"system": system, "tps": tps_base + i} for i in range(3)
            ])
            write_csv(os.path.join(base, "attacks.csv"), [
                {"system": system, "attackType": "Forged Signature", "attackSucceeded": False},
                {"system": system, "attackType": "Replay Attack", "attackSucceeded": False},
            ])

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_load_csv_returns_dataframe_matching_written_data(self):
        df = load_csv(self.tmpdir, "classical", "transactions")
        self.assertEqual(len(df), 10)
        self.assertIn("latencyMs", df.columns)

    def test_load_csv_returns_empty_dataframe_for_missing_file(self):
        df = load_csv(self.tmpdir, "classical", "does_not_exist")
        self.assertTrue(df.empty)

    def test_load_experiment_loads_both_systems(self):
        data = load_experiment(self.tmpdir)
        self.assertIn("classical", data)
        self.assertIn("hybrid", data)
        self.assertEqual(len(data["classical"]["transactions"]), 10)

    def test_compute_statistics_produces_rows_for_both_systems(self):
        stats_df = compute_statistics(self.tmpdir)
        self.assertIn("classical", stats_df["system"].values)
        self.assertIn("hybrid", stats_df["system"].values)
        self.assertGreater(len(stats_df), 0)

    def test_comparative_shows_hybrid_higher_latency_than_classical(self):
        comp = build_comparative(self.tmpdir)
        row = comp[comp["Metric"] == "Latency (ms)"].iloc[0]
        self.assertGreater(row["Hybrid"], row["Classical"])
        self.assertGreater(row["Difference"], 0)
        self.assertGreater(row["PercentageChange"], 0)

    def test_comparative_shows_hybrid_larger_block_size(self):
        comp = build_comparative(self.tmpdir)
        row = comp[comp["Metric"] == "Block Size (bytes)"].iloc[0]
        self.assertGreater(row["Hybrid"], row["Classical"])

    def test_summary_has_one_row_per_system_with_correct_counts(self):
        summary = build_summary(self.tmpdir)
        self.assertEqual(len(summary), 2)
        classical_row = summary[summary["system"] == "classical"].iloc[0]
        self.assertEqual(classical_row["totalTransactionRecords"], 10)
        self.assertEqual(classical_row["acceptedTransactions"], 10)

    def test_summary_message_counts_sum_per_node_max(self):
        summary = build_summary(self.tmpdir)
        classical_row = summary[summary["system"] == "classical"].iloc[0]
        # messagesSent for the single node ranges 0,2,4,6,8 -> max is 8
        self.assertEqual(classical_row["totalMessagesSent"], 8)


class TestTTest(unittest.TestCase):
    def test_insufficient_data_returns_na_gracefully(self):
        result = run_test(pd.Series([1.0]), pd.Series([2.0]))
        self.assertEqual(result["test"], "N/A")
        self.assertIsNone(result["pValue"])

    def test_identical_distributions_do_not_reject_null(self):
        import random
        random.seed(1)
        a = pd.Series([random.gauss(10, 1) for _ in range(50)])
        b = pd.Series([random.gauss(10, 1) for _ in range(50)])
        result = run_test(a, b)
        self.assertFalse(result["rejectNull"])

    def test_clearly_different_distributions_reject_null(self):
        import random
        random.seed(1)
        a = pd.Series([random.gauss(10, 1) for _ in range(50)])
        b = pd.Series([random.gauss(50, 1) for _ in range(50)])
        result = run_test(a, b)
        self.assertTrue(result["rejectNull"])

    def test_looks_normal_returns_none_for_tiny_samples(self):
        self.assertIsNone(looks_normal(pd.Series([1.0, 2.0])))


if __name__ == "__main__":
    unittest.main()
