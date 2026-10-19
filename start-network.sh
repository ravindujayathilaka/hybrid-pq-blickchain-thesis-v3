#!/bin/bash
# Launches a 3-node full-mesh network for BOTH systems on one machine.
#
# Classical (System A): ports 4001, 4011, 4021
# Hybrid    (System B): ports 4002, 4012, 4022
#
# All 3 nodes of a system share one EXPERIMENT_DIR/<system> folder — their
# transactions.csv/blocks.csv/nodes.csv/network.csv interleave safely
# (each row is written with a single atomic append syscall, well under the
# ~4KB atomic write boundary on Linux) and are told apart by the nodeId
# column. Classical and hybrid go to separate subfolders so the analysis
# scripts can build a Classical-vs-Hybrid comparison from two clean sets.
#
# Usage: EXPERIMENT_ID=my_run ./start-network.sh
# Env overrides: DIFFICULTY (default 4), SAMPLE_INTERVAL_MS (default 1000)

set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DIFFICULTY="${DIFFICULTY:-4}"
SAMPLE_INTERVAL_MS="${SAMPLE_INTERVAL_MS:-1000}"
EXPERIMENT_ID="${EXPERIMENT_ID:-$(date -u +%Y-%m-%dT%H-%M-%SZ)}"
BASE_DIR="results/${EXPERIMENT_ID}"
CLASSICAL_DIR="${BASE_DIR}/classical"
HYBRID_DIR="${BASE_DIR}/hybrid"

PIDFILE="$ROOT/.network-pids"
> "$PIDFILE"
mkdir -p logs "$CLASSICAL_DIR" "$HYBRID_DIR"
echo "$BASE_DIR" > "$ROOT/.last-experiment-dir"

start_node() {
  local pkg_dir=$1
  local port=$2
  local label=$3
  local peers=$4
  local expdir=$5

  DIFFICULTY="$DIFFICULTY" PORT="$port" NODE_LABEL="$label" PEERS="$peers" \
    EXPERIMENT_DIR="$expdir" SAMPLE_INTERVAL_MS="$SAMPLE_INTERVAL_MS" \
    nohup node "$pkg_dir/dist/index.js" > "logs/${label}.stdout.log" 2>&1 &
  echo $! >> "$PIDFILE"
  echo "started $label on port $port (pid $!) -> $expdir"
}

echo "=== Experiment: $EXPERIMENT_ID ==="
echo "=== Starting classical (System A) mesh: 4001, 4011, 4021 ==="
start_node packages/classical-node 4001 classical-1 "http://localhost:4011,http://localhost:4021" "$CLASSICAL_DIR"
start_node packages/classical-node 4011 classical-2 "http://localhost:4001,http://localhost:4021" "$CLASSICAL_DIR"
start_node packages/classical-node 4021 classical-3 "http://localhost:4001,http://localhost:4011" "$CLASSICAL_DIR"

echo "=== Starting hybrid (System B) mesh: 4002, 4012, 4022 ==="
start_node packages/hybrid-node 4002 hybrid-1 "http://localhost:4012,http://localhost:4022" "$HYBRID_DIR"
start_node packages/hybrid-node 4012 hybrid-2 "http://localhost:4002,http://localhost:4022" "$HYBRID_DIR"
start_node packages/hybrid-node 4022 hybrid-3 "http://localhost:4002,http://localhost:4012" "$HYBRID_DIR"

sleep 2
echo ""
echo "All 6 nodes started. Checking health..."
for port in 4001 4011 4021 4002 4012 4022; do
  echo -n "port $port: "
  curl -s -m 3 "localhost:$port/health" || echo "(not responding yet)"
  echo ""
done

echo ""
echo "Network is up. Experiment data -> $BASE_DIR"
echo "Run ./stop-network.sh to shut it all down."
