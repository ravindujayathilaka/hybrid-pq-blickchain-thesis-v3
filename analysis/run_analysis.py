#!/usr/bin/env python3
"""
Runs the full analysis pipeline against an experiment's raw CSV output, in
the dependency order the spec implies (statistics before comparison,
comparison before the report, etc).

Usage:
    python3 run_analysis.py --experimentDir results/my_run
"""
from __future__ import annotations

import argparse
import os

from descriptive_stats import compute_statistics
from comparative import build_comparative
from t_test import run_all_tests
from summary import build_summary
from graphs import generate_all
from report_generator import build_report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--experimentDir", required=True)
    args = parser.parse_args()
    d = args.experimentDir

    print("=== 1/6: Summary ===")
    build_summary(d).to_csv(os.path.join(d, "summary.csv"), index=False)

    print("=== 2/6: Descriptive statistics ===")
    compute_statistics(d).to_csv(os.path.join(d, "statistics.csv"), index=False)

    print("=== 3/6: Comparative dataset ===")
    build_comparative(d).to_csv(os.path.join(d, "comparative.csv"), index=False)

    print("=== 4/6: Significance testing ===")
    run_all_tests(d).to_csv(os.path.join(d, "t_test_results.csv"), index=False)

    print("=== 5/6: Graphs ===")
    generate_all(d)

    print("=== 6/6: Report ===")
    with open(os.path.join(d, "report.md"), "w") as f:
        f.write(build_report(d))

    print(f"\nDone. Full results in: {d}")
    print(f"  {d}/summary.csv")
    print(f"  {d}/statistics.csv")
    print(f"  {d}/comparative.csv")
    print(f"  {d}/t_test_results.csv")
    print(f"  {d}/graphs/")
    print(f"  {d}/report.md")


if __name__ == "__main__":
    main()
