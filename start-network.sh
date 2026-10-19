#!/usr/bin/env bash
# Launches a 3-node full-mesh network for both systems.
# Classical ports: 4001, 4011, 4021; Hybrid ports: 4002, 4012, 4022.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

source "$ROOT/scripts/network-utils.sh"
PIDFILE="$ROOT/.network-pids"

DIFFICULTY="${DIFFICULTY:-4}"
SAMPLE_INTERVAL_MS="${SAMPLE_INTERVAL_MS:-1000}"
EXPERIMENT_ID="${EXPERIMENT_ID:-$(date -u +%Y-%m-%dT%H-%M-%SZ)}"
BASE_DIR="results/${EXPERIMENT_ID}"
CLASSICAL_DIR="${BASE_DIR}/classical"
HYBRID_DIR="${BASE_DIR}/hybrid"

# A failed previous run can leave nodes alive. Stop only this project's nodes
# before touching the pid file; never overwrite it while those nodes are alive.
stop_project_nodes
assert_network_ports_free
rm -f "$PIDFILE"
: > "$PIDFILE"
mkdir -p logs "$CLASSICAL_DIR" "$HYBRID_DIR"
echo "$BASE_DIR" > "$ROOT/.last-experiment-dir"

start_node() {
  local pkg_dir="$1" port="$2" label="$3" peers="$4" expdir="$5"
  DIFFICULTY="$DIFFICULTY" PORT="$port" NODE_LABEL="$label" PEERS="$peers" \
    EXPERIMENT_DIR="$expdir" SAMPLE_INTERVAL_MS="$SAMPLE_INTERVAL_MS" \
    nohup node "$pkg_dir/dist/index.js" > "logs/${label}.stdout.log" 2>&1 &
  echo $! >> "$PIDFILE"
  echo "started $label on port $port (pid $!) -> $expdir"
}

cleanup_on_failure() {
  local status=$?
  trap - ERR
  if ((status != 0)); then
    echo "Network startup failed; cleaning up the nodes started by this attempt." >&2
    "$ROOT/stop-network.sh" || true
  fi
  return "$status"
}
trap cleanup_on_failure ERR

echo "=== Experiment: $EXPERIMENT_ID ==="
echo "=== Starting classical mesh: 4001, 4011, 4021 ==="
start_node packages/classical-node 4001 classical-1 "http://localhost:4011,http://localhost:4021" "$CLASSICAL_DIR"
start_node packages/classical-node 4011 classical-2 "http://localhost:4001,http://localhost:4021" "$CLASSICAL_DIR"
start_node packages/classical-node 4021 classical-3 "http://localhost:4001,http://localhost:4011" "$CLASSICAL_DIR"
echo "=== Starting hybrid mesh: 4002, 4012, 4022 ==="
start_node packages/hybrid-node 4002 hybrid-1 "http://localhost:4012,http://localhost:4022" "$HYBRID_DIR"
start_node packages/hybrid-node 4012 hybrid-2 "http://localhost:4002,http://localhost:4022" "$HYBRID_DIR"
start_node packages/hybrid-node 4022 hybrid-3 "http://localhost:4002,http://localhost:4012" "$HYBRID_DIR"

# Poll each health endpoint rather than merely sleeping and continuing when a
# node failed to bind. This prevents the workload from starting against a
# partial network and makes EADDRINUSE/startup failures explicit.
for port in "${network_ports[@]}"; do
  expected_label=""
  case "$port" in
    4001) expected_label=classical-1 ;; 4011) expected_label=classical-2 ;; 4021) expected_label=classical-3 ;;
    4002) expected_label=hybrid-1 ;; 4012) expected_label=hybrid-2 ;; 4022) expected_label=hybrid-3 ;;
  esac
  healthy=0
  for attempt in {1..30}; do
    response="$(curl -fsS --max-time 2 "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
    if [[ "$response" == *'"status":"ok"'* && "$response" == *"\"node\":\"$expected_label\""* ]]; then
      echo "port $port: $response"
      healthy=1
      break
    fi
    # Fail early when the expected process has already exited.
    if ! grep -q "$expected_label listening" "logs/${expected_label}.stdout.log" 2>/dev/null \
      && ((attempt >= 6)); then
      break
    fi
    sleep 0.5
  done
  if ((healthy == 0)); then
    echo "ERROR: $expected_label failed health check on port $port." >&2
    echo "--- logs/${expected_label}.stdout.log (last 60 lines) ---" >&2
    tail -60 "logs/${expected_label}.stdout.log" >&2 || true
    false
  fi
done

trap - ERR
echo "All six nodes passed health checks. Experiment data -> $BASE_DIR"
echo "Run ./stop-network.sh to shut the network down."
