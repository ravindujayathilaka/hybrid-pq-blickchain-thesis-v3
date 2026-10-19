"""
Shared helpers for loading an experiment's CSV output.

Expected layout (produced by start-network.sh + workload-generator.mjs +
attack-simulator.mjs):

    results/<experiment_id>/
        classical/
            transactions.csv, blocks.csv, nodes.csv, network.csv,
            benchmark.csv, attacks.csv
        hybrid/
            (same files)
"""
from __future__ import annotations

import os
import pandas as pd

SYSTEMS = ["classical", "hybrid"]
FILES = ["transactions", "blocks", "nodes", "network", "benchmark", "attacks", "sync"]


def load_csv(experiment_dir: str, system: str, name: str) -> pd.DataFrame:
    """Load one CSV (e.g. 'transactions') for one system. Returns an empty DataFrame if missing."""
    path = os.path.join(experiment_dir, system, f"{name}.csv")
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return pd.DataFrame()
    return pd.read_csv(path)


def load_experiment(experiment_dir: str) -> dict:
    """Load every known CSV for both systems into a nested dict: data[system][file] -> DataFrame."""
    data = {}
    for system in SYSTEMS:
        data[system] = {name: load_csv(experiment_dir, system, name) for name in FILES}
    return data


def ensure_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path
