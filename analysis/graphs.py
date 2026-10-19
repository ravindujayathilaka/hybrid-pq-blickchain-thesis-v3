"""
Thesis spec Section 12: generates the required comparison charts and saves
each as PNG, SVG, and PDF under <experimentDir>/graphs/.

Usage:
    python3 graphs.py --experimentDir results/my_run
"""
from __future__ import annotations

import argparse
import os
import matplotlib
matplotlib.use("Agg")  # headless — no display server needed
import matplotlib.pyplot as plt
import pandas as pd

from common import load_experiment, ensure_dir

COLORS = {"classical": "#2563eb", "hybrid": "#dc2626"}


def save_fig(fig, out_dir: str, name: str):
    for ext in ("png", "svg", "pdf"):
        fig.savefig(os.path.join(out_dir, f"{name}.{ext}"), bbox_inches="tight", dpi=150)
    plt.close(fig)


def chart_line_over_index(data, file, column, title, ylabel, out_dir, name, xlabel="Sample #"):
    fig, ax = plt.subplots(figsize=(8, 5))
    any_data = False
    for system, color in COLORS.items():
        df = data[system].get(file, pd.DataFrame())
        if df.empty or column not in df.columns:
            continue
        series = pd.to_numeric(df[column], errors="coerce").dropna().reset_index(drop=True)
        if series.empty:
            continue
        ax.plot(series.index, series.values, label=system.capitalize(), color=color, linewidth=1.5)
        any_data = True
    if not any_data:
        plt.close(fig)
        return
    ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.legend()
    ax.grid(alpha=0.3)
    save_fig(fig, out_dir, name)


def chart_boxplot(data, file, columns, title, ylabel, out_dir, name):
    """columns: list of (label, column_name) pairs; plots one box per (system, column) combination."""
    fig, ax = plt.subplots(figsize=(9, 5))
    box_data, labels, colors = [], [], []
    for system, color in COLORS.items():
        df = data[system].get(file, pd.DataFrame())
        for label, column in columns:
            if df.empty or column not in df.columns:
                continue
            series = pd.to_numeric(df[column], errors="coerce").dropna()
            if series.empty:
                continue
            box_data.append(series.values)
            labels.append(f"{system.capitalize()}\n{label}")
            colors.append(color)
    if not box_data:
        plt.close(fig)
        return
    bp = ax.boxplot(box_data, labels=labels, patch_artist=True)
    for patch, color in zip(bp["boxes"], colors):
        patch.set_facecolor(color)
        patch.set_alpha(0.6)
    ax.set_title(title)
    ax.set_ylabel(ylabel)
    ax.grid(alpha=0.3, axis="y")
    plt.xticks(rotation=15, ha="right")
    save_fig(fig, out_dir, name)


def chart_block_size_growth(data, out_dir):
    fig, ax = plt.subplots(figsize=(8, 5))
    any_data = False
    for system, color in COLORS.items():
        df = data[system].get("blocks", pd.DataFrame())
        if df.empty or "blockHeight" not in df.columns:
            continue
        d = df.sort_values("blockHeight")
        ax.plot(d["blockHeight"], d["blockSizeBytes"], marker="o", markersize=3,
                label=system.capitalize(), color=color, linewidth=1.2)
        any_data = True
    if not any_data:
        plt.close(fig)
        return
    ax.set_title("Block Size Growth")
    ax.set_xlabel("Block Height")
    ax.set_ylabel("Block Size (bytes)")
    ax.legend()
    ax.grid(alpha=0.3)
    save_fig(fig, out_dir, "block_size_growth")


def chart_tps_vs_transaction_count(data, out_dir):
    fig, ax = plt.subplots(figsize=(8, 5))
    any_data = False
    for system, color in COLORS.items():
        df = data[system].get("benchmark", pd.DataFrame())
        if df.empty or "requestedCount" not in df.columns:
            continue
        d = df.sort_values("requestedCount")
        ax.plot(d["requestedCount"], d["tps"], marker="o", label=system.capitalize(), color=color)
        any_data = True
    if not any_data:
        plt.close(fig)
        return
    ax.set_title("TPS vs Transaction Count")
    ax.set_xlabel("Transaction Count (workload size)")
    ax.set_ylabel("Transactions Per Second")
    ax.legend()
    ax.grid(alpha=0.3)
    save_fig(fig, out_dir, "tps_vs_transaction_count")


def chart_resource_utilization(data, out_dir):
    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(9, 7), sharex=True)
    any_data = False
    for system, color in COLORS.items():
        df = data[system].get("nodes", pd.DataFrame())
        if df.empty:
            continue
        d = df.sort_values("timestamp").reset_index(drop=True)
        ax1.plot(d.index, d["cpuPercent"], label=system.capitalize(), color=color, linewidth=1)
        ax2.plot(d.index, d["memoryMb"], label=system.capitalize(), color=color, linewidth=1)
        any_data = True
    if not any_data:
        plt.close(fig)
        return
    ax1.set_title("Resource Utilization Over Time")
    ax1.set_ylabel("CPU (%)")
    ax1.legend()
    ax1.grid(alpha=0.3)
    ax2.set_ylabel("Memory (MB)")
    ax2.set_xlabel("Sample # (node monitoring interval)")
    ax2.grid(alpha=0.3)
    save_fig(fig, out_dir, "resource_utilization")


def chart_attack_detection_rate(data, out_dir):
    fig, ax = plt.subplots(figsize=(8, 5))
    systems, rates = [], []
    for system in COLORS:
        df = data[system].get("attacks", pd.DataFrame())
        if df.empty:
            continue
        total = len(df)
        blocked = int((~df["attackSucceeded"].astype(bool)).sum())
        systems.append(system.capitalize())
        rates.append(100 * blocked / total if total else 0)
    if not systems:
        plt.close(fig)
        return
    ax.bar(systems, rates, color=[COLORS[s.lower()] for s in systems], alpha=0.8)
    ax.set_title("Attack Detection Rate")
    ax.set_ylabel("Attacks Correctly Blocked (%)")
    ax.set_ylim(0, 105)
    for i, r in enumerate(rates):
        ax.text(i, r + 1, f"{r:.0f}%", ha="center")
    ax.grid(alpha=0.3, axis="y")
    save_fig(fig, out_dir, "attack_detection_rate")


def chart_success_vs_failure_rate(data, out_dir):
    fig, ax = plt.subplots(figsize=(8, 5))
    systems, accepted_pct, rejected_pct = [], [], []
    for system in COLORS:
        df = data[system].get("transactions", pd.DataFrame())
        if df.empty:
            continue
        total = len(df)
        accepted = int(df["accepted"].astype(bool).sum())
        systems.append(system.capitalize())
        accepted_pct.append(100 * accepted / total if total else 0)
        rejected_pct.append(100 - (100 * accepted / total if total else 0))
    if not systems:
        plt.close(fig)
        return
    ax.bar(systems, accepted_pct, label="Accepted", color="#16a34a", alpha=0.85)
    ax.bar(systems, rejected_pct, bottom=accepted_pct, label="Rejected", color="#dc2626", alpha=0.85)
    ax.set_title("Transaction Success vs Failure Rate")
    ax.set_ylabel("Percent of Submitted Transactions")
    ax.legend()
    ax.grid(alpha=0.3, axis="y")
    save_fig(fig, out_dir, "success_vs_failure_rate")


def generate_all(experiment_dir: str):
    data = load_experiment(experiment_dir)
    out_dir = ensure_dir(os.path.join(experiment_dir, "graphs"))

    chart_tps_vs_transaction_count(data, out_dir)
    chart_line_over_index(data, "transactions", "latencyMs", "Latency vs Transaction Sequence",
                           "Latency (ms)", out_dir, "latency_vs_transaction_count")
    chart_line_over_index(data, "nodes", "cpuPercent", "CPU Usage Over Node Samples",
                           "CPU (%)", out_dir, "cpu_usage_vs_transaction_count")
    chart_line_over_index(data, "nodes", "memoryMb", "Memory Usage Over Node Samples",
                           "Memory (MB)", out_dir, "memory_usage_vs_transaction_count")
    chart_block_size_growth(data, out_dir)
    chart_boxplot(data, "blocks", [("Mining Time", "miningTimeMs")],
                  "Mining Time Comparison", "Milliseconds", out_dir, "mining_time_comparison")
    chart_boxplot(data, "transactions", [("ECC", "eccSignGenMs"), ("PQ", "pqSignGenMs")],
                  "Signature Generation Time", "Milliseconds", out_dir, "signature_generation_time")
    chart_boxplot(data, "transactions", [("ECC", "eccVerifyMs"), ("PQ", "pqVerifyMs")],
                  "Signature Verification Time", "Milliseconds", out_dir, "signature_verification_time")
    chart_boxplot(data, "network", [("Propagation", "propagationMs")],
                  "Network (Block Propagation) Delay", "Milliseconds", out_dir, "network_delay")
    chart_resource_utilization(data, out_dir)
    chart_attack_detection_rate(data, out_dir)
    chart_success_vs_failure_rate(data, out_dir)

    print(f"Graphs written to {out_dir}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--experimentDir", required=True)
    args = parser.parse_args()
    generate_all(args.experimentDir)


if __name__ == "__main__":
    main()
