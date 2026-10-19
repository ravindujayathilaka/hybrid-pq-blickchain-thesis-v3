"""
Thesis spec Section 14: assembles a Markdown report from everything the
rest of the pipeline produced (statistics.csv, comparative.csv,
t_test_results.csv, attacks.csv, benchmark.csv, graphs/).

Usage:
    python3 report_generator.py --experimentDir results/my_run
"""
from __future__ import annotations

import argparse
import os
import platform
import subprocess
import pandas as pd

from common import load_experiment


def node_version() -> str:
    try:
        return subprocess.check_output(["node", "-v"], text=True).strip()
    except Exception:
        return "unknown"


def df_to_markdown(df: pd.DataFrame, float_format: str = "{:.4f}") -> str:
    if df.empty:
        return "_No data available._\n"
    display = df.copy()
    for col in display.select_dtypes(include=["float", "float64"]).columns:
        display[col] = display[col].map(lambda x: float_format.format(x) if pd.notna(x) else "")
    try:
        return display.to_markdown(index=False)
    except ImportError:
        # tabulate not installed — fall back to a plain-text table
        return "```\n" + display.to_string(index=False) + "\n```"


def build_report(experiment_dir: str) -> str:
    data = load_experiment(experiment_dir)
    experiment_id = os.path.basename(os.path.normpath(experiment_dir))

    stats_path = os.path.join(experiment_dir, "statistics.csv")
    comp_path = os.path.join(experiment_dir, "comparative.csv")
    ttest_path = os.path.join(experiment_dir, "t_test_results.csv")

    stats_df = pd.read_csv(stats_path) if os.path.exists(stats_path) else pd.DataFrame()
    comp_df = pd.read_csv(comp_path) if os.path.exists(comp_path) else pd.DataFrame()
    ttest_df = pd.read_csv(ttest_path) if os.path.exists(ttest_path) else pd.DataFrame()

    lines = []
    lines.append(f"# Experimental Report — {experiment_id}\n")

    lines.append("## 1. Experiment Information\n")
    lines.append(f"- **Experiment ID:** {experiment_id}")
    lines.append(f"- **Generated:** {pd.Timestamp.utcnow().isoformat()}Z")
    lines.append("- **Systems compared:** Classical (ECC/secp256k1) vs Hybrid (ECC + ML-DSA-65 / FIPS 204)\n")

    lines.append("## 2. Hardware Configuration\n")
    lines.append(f"- **Platform:** {platform.platform()}")
    lines.append(f"- **Processor:** {platform.processor() or platform.machine()}")
    lines.append(f"- **CPU cores (logical):** {os.cpu_count()}\n")

    lines.append("## 3. Software Configuration\n")
    lines.append(f"- **Node.js:** {node_version()}")
    lines.append(f"- **Python:** {platform.python_version()}")
    lines.append("- **Key libraries:** @noble/curves, @noble/post-quantum (ML-DSA-65), Express, Socket.IO, pandas, scipy, matplotlib\n")

    lines.append("## 4. Workload Description\n")
    summary_path = os.path.join(experiment_dir, "summary.csv")
    if os.path.exists(summary_path):
        lines.append(df_to_markdown(pd.read_csv(summary_path)))
        lines.append("")
    for system in ["classical", "hybrid"]:
        bench = data[system].get("benchmark", pd.DataFrame())
        if bench.empty:
            lines.append(f"- **{system.capitalize()}:** no workload runs recorded.")
            continue
        total_requested = int(bench["requestedCount"].sum())
        total_accepted = int(bench["accepted"].sum())
        lines.append(
            f"- **{system.capitalize()}:** {len(bench)} workload run(s), "
            f"{total_requested} transactions requested, {total_accepted} accepted."
        )
    lines.append("")

    lines.append("## 5. Per-System Results\n")
    for system in ["classical", "hybrid"]:
        lines.append(f"### 5.{1 if system == 'classical' else 2} {system.capitalize()}\n")
        tx = data[system].get("transactions", pd.DataFrame())
        blocks = data[system].get("blocks", pd.DataFrame())
        if not tx.empty:
            accepted = int(tx["accepted"].astype(bool).sum())
            lines.append(f"- Transactions recorded: {len(tx)} ({accepted} accepted, {len(tx) - accepted} rejected)")
        if not blocks.empty:
            lines.append(f"- Blocks mined: {len(blocks)}")
            lines.append(f"- Mean block size: {blocks['blockSizeBytes'].mean():.0f} bytes")
            lines.append(f"- Mean mining time: {blocks['miningTimeMs'].mean():.2f} ms")
        lines.append("")

    lines.append("## 6. Statistical Analysis\n")
    lines.append("### 6.1 Descriptive Statistics\n")
    lines.append(df_to_markdown(stats_df))
    lines.append("")
    lines.append("### 6.2 Significance Testing (Classical vs Hybrid)\n")
    lines.append(df_to_markdown(ttest_df))
    lines.append("")

    lines.append("## 7. Comparative Table\n")
    lines.append(df_to_markdown(comp_df))
    lines.append("")

    lines.append("## 8. Security Testing Results\n")
    for system in ["classical", "hybrid"]:
        attacks = data[system].get("attacks", pd.DataFrame())
        if attacks.empty:
            continue
        blocked = int((~attacks["attackSucceeded"].astype(bool)).sum())
        lines.append(f"### {system.capitalize()}: {blocked}/{len(attacks)} attacks correctly blocked\n")
        lines.append(df_to_markdown(attacks[["attackType", "expectedResult", "actualResult", "detectionTimeMs", "attackSucceeded"]]))
        lines.append("")

    lines.append("## 9. Charts\n")
    graphs_dir = os.path.join(experiment_dir, "graphs")
    if os.path.isdir(graphs_dir):
        for fname in sorted(os.listdir(graphs_dir)):
            if fname.endswith(".png"):
                lines.append(f"![{fname}](graphs/{fname})\n")
    else:
        lines.append("_No graphs generated._\n")

    lines.append("## 10. Observations\n")
    if not comp_df.empty:
        comp_df_sorted = comp_df.dropna(subset=["PercentageChange"]).copy()
        if not comp_df_sorted.empty:
            comp_df_sorted["abs_pct"] = comp_df_sorted["PercentageChange"].abs()
            top = comp_df_sorted.sort_values("abs_pct", ascending=False).head(5)
            for _, row in top.iterrows():
                direction = "higher" if row["PercentageChange"] > 0 else "lower"
                lines.append(
                    f"- **{row['Metric']}**: Hybrid is {abs(row['PercentageChange']):.1f}% {direction} "
                    f"than Classical (Classical={row['Classical']:.4g}, Hybrid={row['Hybrid']:.4g})."
                )
    lines.append("")

    lines.append("## 11. Threats to Validity\n")
    lines.append("- All nodes ran on a single physical machine; localhost networking does not capture "
                  "real wide-area-network latency, packet loss, or bandwidth contention.")
    lines.append("- Mesh size (3 nodes per system) is small relative to production blockchain networks; "
                  "propagation and consensus behavior may not generalize to larger networks.")
    lines.append("- CPU/memory sampling shares the host machine's resources across both systems if run "
                  "concurrently; running systems sequentially, or on isolated cores, improves comparability.")
    lines.append("- PoW difficulty was fixed per run rather than dynamically adjusted, which is a "
                  "simplification relative to production blockchains.")
    lines.append("")

    lines.append("## 12. Limitations\n")
    lines.append("- This prototype does not enforce account balances or UTXO tracking at transaction "
                  "submission time, so true insufficient-funds double-spending cannot be exercised; the "
                  "Double Spending Attempt test instead verifies replay-based double-confirmation "
                  "protection (a signed transaction cannot be mined twice).")
    lines.append("- Wallet key custody is in-memory and per-node, intended for benchmarking only — not a "
                  "production key-management model.")
    lines.append("- Statistical tests assume independence between samples; samples drawn from the same "
                  "mining session may exhibit autocorrelation (e.g. consecutive block times).")
    lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--experimentDir", required=True)
    args = parser.parse_args()

    report = build_report(args.experimentDir)
    out_path = os.path.join(args.experimentDir, "report.md")
    with open(out_path, "w") as f:
        f.write(report)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
