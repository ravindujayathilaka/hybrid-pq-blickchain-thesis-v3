"""
Thesis spec Section 9: descriptive statistics for every required metric,
computed separately for Classical and Hybrid. Writes statistics.csv to the
experiment root.

Usage:
    python3 descriptive_stats.py --experimentDir results/my_run
"""
from __future__ import annotations

import argparse
import os
import numpy as np
import pandas as pd
from scipy import stats

from common import load_experiment, SYSTEMS


def ci95(data: pd.Series) -> tuple[float, float]:
    """95% confidence interval for the mean, using the t-distribution (appropriate for small n)."""
    data = data.dropna()
    n = len(data)
    if n < 2:
        return (float("nan"), float("nan"))
    mean = float(np.mean(data))
    sem = stats.sem(data)
    if sem == 0 or np.isnan(sem):
        return (mean, mean)
    h = sem * stats.t.ppf(0.975, n - 1)
    return (mean - h, mean + h)


def describe(series: pd.Series) -> dict:
    series = pd.to_numeric(series, errors="coerce").dropna()
    if len(series) == 0:
        return dict(n=0, mean=None, median=None, min=None, max=None, variance=None, stddev=None,
                    ci95_lower=None, ci95_upper=None)
    lo, hi = ci95(series)
    return dict(
        n=int(len(series)),
        mean=float(series.mean()),
        median=float(series.median()),
        min=float(series.min()),
        max=float(series.max()),
        variance=float(series.var(ddof=1)) if len(series) > 1 else 0.0,
        stddev=float(series.std(ddof=1)) if len(series) > 1 else 0.0,
        ci95_lower=lo,
        ci95_upper=hi,
    )


# (metric label, file, column, optional filter)
METRIC_SOURCES = [
    ("TPS", "benchmark", "tps", None),
    ("Latency (ms)", "transactions", "latencyMs", lambda df: df["accepted"] == True),  # noqa: E712
    ("CPU Usage (%)", "nodes", "cpuPercent", None),
    ("Memory Usage (MB)", "nodes", "memoryMb", None),
    ("ECC Signature Generation Time (ms)", "transactions", "eccSignGenMs", None),
    ("PQ Signature Generation Time (ms)", "transactions", "pqSignGenMs", None),
    ("Combined Signing Time (ms)", "transactions", "combinedSignGenMs", None),
    ("Total Signature Processing Time (ms)", "transactions", "totalSignatureProcessingMs", None),
    ("ECC Verification Time (ms)", "transactions", "eccVerifyMs", None),
    ("PQ Verification Time (ms)", "transactions", "pqVerifyMs", None),
    ("Combined Verification Time (ms)", "transactions", "combinedVerifyMs", None),
    ("Mining Time (ms)", "blocks", "miningTimeMs", None),
    ("Hashing Time (ms)", "blocks", "hashingTimeMs", None),
    ("Validation Time (ms)", "blocks", "validationTimeMs", None),
    ("Block Size (bytes)", "blocks", "blockSizeBytes", None),
    ("Block Propagation Time (ms)", "network", "propagationMs", None),
    ("Transaction Size (bytes)", "transactions", "sizeBytes", None),
    ("Synchronization Time (ms)", "sync", "syncDurationMs", None),
]


def compute_statistics(experiment_dir: str) -> pd.DataFrame:
    data = load_experiment(experiment_dir)
    rows = []
    for system in SYSTEMS:
        for label, file, column, filt in METRIC_SOURCES:
            df = data[system].get(file, pd.DataFrame())
            if df.empty or column not in df.columns:
                rows.append({"system": system, "metric": label, **describe(pd.Series(dtype=float))})
                continue
            subset = df if filt is None else df[filt(df)]
            rows.append({"system": system, "metric": label, **describe(subset[column])})
    return pd.DataFrame(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--experimentDir", required=True)
    args = parser.parse_args()

    result = compute_statistics(args.experimentDir)
    out_path = os.path.join(args.experimentDir, "statistics.csv")
    result.to_csv(out_path, index=False)
    print(f"Wrote {out_path} ({len(result)} rows)")
    print(result.to_string(index=False))


if __name__ == "__main__":
    main()
