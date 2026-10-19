"""
Thesis spec Section 13: a concise one-row-per-system rollup, distinct from
the full per-metric descriptive_stats.csv — a quick-glance summary of
overall experiment scale and headline numbers. Writes summary.csv to the
experiment root.

Usage:
    python3 summary.py --experimentDir results/my_run
"""
from __future__ import annotations

import argparse
import os
import pandas as pd

from common import load_experiment, SYSTEMS


def build_summary(experiment_dir: str) -> pd.DataFrame:
    data = load_experiment(experiment_dir)
    rows = []
    for system in SYSTEMS:
        tx = data[system].get("transactions", pd.DataFrame())
        blocks = data[system].get("blocks", pd.DataFrame())
        nodes = data[system].get("nodes", pd.DataFrame())
        network = data[system].get("network", pd.DataFrame())
        benchmark = data[system].get("benchmark", pd.DataFrame())
        attacks = data[system].get("attacks", pd.DataFrame())
        sync = data[system].get("sync", pd.DataFrame())

        total_tx = len(tx)
        accepted_tx = int(tx["accepted"].astype(bool).sum()) if not tx.empty else 0

        # messagesSent/messagesReceived are cumulative counters per node; take
        # each node's max (=latest) sample and sum across nodes in this system.
        total_messages_sent = None
        total_messages_received = None
        if not nodes.empty and "messagesSent" in nodes.columns:
            per_node_max = nodes.groupby("nodeId")[["messagesSent", "messagesReceived"]].max()
            total_messages_sent = int(per_node_max["messagesSent"].sum())
            total_messages_received = int(per_node_max["messagesReceived"].sum())

        rows.append({
            "system": system,
            "totalTransactionRecords": total_tx,
            "acceptedTransactions": accepted_tx,
            "rejectedTransactions": total_tx - accepted_tx,
            "totalBlocksRecorded": len(blocks),
            "avgTPS": benchmark["tps"].mean() if not benchmark.empty else None,
            "avgLatencyMs": tx.loc[tx["accepted"] == True, "latencyMs"].mean() if not tx.empty else None,  # noqa: E712
            "avgCpuPercent": nodes["cpuPercent"].mean() if not nodes.empty else None,
            "avgMemoryMb": nodes["memoryMb"].mean() if not nodes.empty else None,
            "avgBlockSizeBytes": blocks["blockSizeBytes"].mean() if not blocks.empty else None,
            "avgMiningTimeMs": blocks.loc[blocks["miningTimeMs"] > 0, "miningTimeMs"].mean() if not blocks.empty else None,
            "avgPropagationMs": network["propagationMs"].mean() if not network.empty else None,
            "totalMessagesSent": total_messages_sent,
            "totalMessagesReceived": total_messages_received,
            "avgSyncDurationMs": sync["syncDurationMs"].mean() if not sync.empty else None,
            "syncEventCount": len(sync),
            "attacksTotal": len(attacks),
            "attacksBlocked": int((~attacks["attackSucceeded"].astype(bool)).sum()) if not attacks.empty else None,
        })
    return pd.DataFrame(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--experimentDir", required=True)
    args = parser.parse_args()

    result = build_summary(args.experimentDir)
    out_path = os.path.join(args.experimentDir, "summary.csv")
    result.to_csv(out_path, index=False)
    print(f"Wrote {out_path}")
    print(result.to_string(index=False))


if __name__ == "__main__":
    main()
