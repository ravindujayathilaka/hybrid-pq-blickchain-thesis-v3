"""
Thesis spec Section 10: one CSV directly comparing Classical vs Hybrid for
each key metric (mean values), with absolute difference and percentage
change. Writes comparative.csv to the experiment root.

Usage:
    python3 comparative.py --experimentDir results/my_run
"""
from __future__ import annotations

import argparse
import os
import pandas as pd

from descriptive_stats import compute_statistics  # reuses the same metric definitions


def build_comparative(experiment_dir: str) -> pd.DataFrame:
    stats_df = compute_statistics(experiment_dir)
    pivot = stats_df.pivot(index="metric", columns="system", values="mean")

    rows = []
    for metric in pivot.index:
        classical = pivot.loc[metric].get("classical")
        hybrid = pivot.loc[metric].get("hybrid")
        if pd.isna(classical) or pd.isna(hybrid):
            diff = None
            pct = None
        else:
            diff = hybrid - classical
            pct = (diff / classical * 100) if classical not in (0, None) else None
        rows.append({
            "Metric": metric,
            "Classical": classical,
            "Hybrid": hybrid,
            "Difference": diff,
            "PercentageChange": pct,
        })
    return pd.DataFrame(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--experimentDir", required=True)
    args = parser.parse_args()

    result = build_comparative(args.experimentDir)
    out_path = os.path.join(args.experimentDir, "comparative.csv")
    result.to_csv(out_path, index=False)
    print(f"Wrote {out_path}")
    print(result.to_string(index=False))


if __name__ == "__main__":
    main()
