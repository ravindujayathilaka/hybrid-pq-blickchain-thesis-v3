#!/bin/bash
# Runs one complete, thesis-ready experiment end to end:
#   1. Starts the 3-node classical + 3-node hybrid mesh network
#   2. Drives a workload against both systems
#   3. Runs the security attack suite against both systems
#   4. Stops the network
#   5. Runs the full Python analysis pipeline (statistics, comparison,
#      t-tests, graphs, report)
#
# Usage:
#   ./run-experiment.sh [transaction_count] [concurrency]
#
# Examples:
#   ./run-experiment.sh              # defaults: 1000 tx, concurrency 10
#   ./run-experiment.sh 10000 25
#   ./run-experiment.sh 50000 50
#
# Env overrides: DIFFICULTY (default 4), SAMPLE_INTERVAL_MS (default 1000)

set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

# Always stop the local nodes on normal completion, Ctrl-C, or a failed
# workload/analysis command. Without this trap, the next run can inherit
# orphan nodes whose ports are then reported as EADDRINUSE.
cleanup_network() {
  local status=$?
  trap - EXIT
  if [[ -f "$ROOT/.network-pids" ]]; then
    echo "Cleaning up network processes after experiment (exit status $status)."
    "$ROOT/stop-network.sh" || true
  fi
  exit "$status"
}
trap cleanup_network EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

COUNT="${1:-1000}"
CONCURRENCY="${2:-10}"
export EXPERIMENT_ID="${EXPERIMENT_ID:-run_$(date -u +%Y-%m-%dT%H-%M-%SZ)}"
BASE_DIR="results/${EXPERIMENT_ID}"

echo "############################################################"
echo "# Experiment: $EXPERIMENT_ID"
echo "# Transactions per system: $COUNT (concurrency $CONCURRENCY)"
echo "############################################################"

echo ""
echo "=== [1/5] Starting network ==="
./start-network.sh
sleep 2

echo ""
echo "=== [2/5] Workload: classical ==="
node scripts/workload-generator.mjs \
  --url=http://localhost:4001 --system=classical \
  --count="$COUNT" --concurrency="$CONCURRENCY" --mineEvery=50 --walletPoolSize=20 \
  --experimentDir="${BASE_DIR}/classical"

echo ""
echo "=== [2/5] Workload: hybrid ==="
node scripts/workload-generator.mjs \
  --url=http://localhost:4002 --system=hybrid \
  --count="$COUNT" --concurrency="$CONCURRENCY" --mineEvery=50 --walletPoolSize=20 \
  --experimentDir="${BASE_DIR}/hybrid"

echo ""
echo "=== [3/5] Security attack suite: classical ==="
node scripts/attack-simulator.mjs --url=http://localhost:4001 --system=classical --experimentDir="${BASE_DIR}/classical"

echo ""
echo "=== [3/5] Security attack suite: hybrid ==="
node scripts/attack-simulator.mjs --url=http://localhost:4002 --system=hybrid --experimentDir="${BASE_DIR}/hybrid"

echo ""
echo "=== [4/5] Stopping network ==="
sleep 1
./stop-network.sh

echo ""
echo "=== [5/5] Running analysis pipeline ==="
python3 analysis/run_analysis.py --experimentDir "$BASE_DIR"

echo ""
echo "############################################################"
echo "# Done. Full results: $BASE_DIR"
echo "#   report.md, statistics.csv, comparative.csv, t_test_results.csv, graphs/"
echo "############################################################"
