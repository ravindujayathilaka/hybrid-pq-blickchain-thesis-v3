"""
Thesis spec Section 11: for each metric, tests whether the Classical and
Hybrid samples differ significantly.

Method selection: runs a Shapiro-Wilk normality test on each group first
(skipped above n=5000, where Shapiro is unreliable and CLT makes the
t-test robust regardless). If both groups look normal (p > 0.05), uses
Welch's t-test (does not assume equal variances — a safer default than
Student's t-test). Otherwise falls back to the Mann-Whitney U test, the
standard non-parametric alternative, per the spec's own instruction to use
"an appropriate non-parametric test if assumptions are not met."

Writes t_test_results.csv to the experiment root.

Usage:
    python3 t_test.py --experimentDir results/my_run
"""
from __future__ import annotations

import argparse
import os
import warnings
import pandas as pd
from scipy import stats

from common import load_experiment
from descriptive_stats import METRIC_SOURCES

ALPHA = 0.05
SHAPIRO_MAX_N = 5000


def get_samples(data: dict, system: str, file: str, column: str, filt) -> pd.Series:
    df = data[system].get(file, pd.DataFrame())
    if df.empty or column not in df.columns:
        return pd.Series(dtype=float)
    subset = df if filt is None else df[filt(df)]
    return pd.to_numeric(subset[column], errors="coerce").dropna()


def looks_normal(sample: pd.Series) -> bool | None:
    n = len(sample)
    if n < 3:
        return None  # not enough data to test
    if n > SHAPIRO_MAX_N:
        return True  # assume CLT applies at this sample size
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        _, p = stats.shapiro(sample)
    return p > ALPHA


def run_test(classical: pd.Series, hybrid: pd.Series) -> dict:
    if len(classical) < 2 or len(hybrid) < 2:
        return dict(test="N/A", statistic=None, pValue=None, rejectNull=None,
                    reason="Insufficient data (need >=2 samples per group)")

    c_normal = looks_normal(classical)
    h_normal = looks_normal(hybrid)
    both_normal = bool(c_normal) and bool(h_normal)

    if both_normal:
        statistic, p_value = stats.ttest_ind(classical, hybrid, equal_var=False)  # Welch's t-test
        test_name = "Welch's t-test"
    else:
        statistic, p_value = stats.mannwhitneyu(classical, hybrid, alternative="two-sided")
        test_name = "Mann-Whitney U"

    return dict(
        test=test_name,
        statistic=float(statistic),
        pValue=float(p_value),
        rejectNull=bool(p_value < ALPHA),
        reason=f"H0: no difference between Classical and Hybrid. {'Rejected' if p_value < ALPHA else 'Failed to reject'} at alpha={ALPHA}.",
    )


def run_all_tests(experiment_dir: str) -> pd.DataFrame:
    data = load_experiment(experiment_dir)
    rows = []
    for label, file, column, filt in METRIC_SOURCES:
        classical = get_samples(data, "classical", file, column, filt)
        hybrid = get_samples(data, "hybrid", file, column, filt)
        result = run_test(classical, hybrid)
        rows.append({
            "metric": label,
            "nClassical": len(classical),
            "nHybrid": len(hybrid),
            **result,
        })
    return pd.DataFrame(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--experimentDir", required=True)
    args = parser.parse_args()

    result = run_all_tests(args.experimentDir)
    out_path = os.path.join(args.experimentDir, "t_test_results.csv")
    result.to_csv(out_path, index=False)
    print(f"Wrote {out_path}")
    print(result.to_string(index=False))


if __name__ == "__main__":
    main()
