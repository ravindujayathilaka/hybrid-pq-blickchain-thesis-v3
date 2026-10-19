#!/bin/bash
# Usage: ./collect-network-data.sh <system> <num_blocks>
#   system: "classical" or "hybrid"
#   num_blocks: how many transaction+mine cycles to run on node-1
#
# Mines on node-1 of the chosen system, then pulls each node's
# /metrics/propagation log (how long each mined block took to reach that
# node, and how many bytes it was) into results/<system>_propagation.csv,
# and each mine's local timing into results/<system>_mining.csv.

set -e
SYSTEM=$1
N=${2:-10}

if [ "$SYSTEM" == "classical" ]; then
  PORTS=(4001 4011 4021)
elif [ "$SYSTEM" == "hybrid" ]; then
  PORTS=(4002 4012 4022)
else
  echo "Usage: $0 <classical|hybrid> <num_blocks>"
  exit 1
fi

MINER_PORT=${PORTS[0]}
mkdir -p results

MINING_CSV="results/${SYSTEM}_mining.csv"
echo "run,blockIndex,transactionCount,durationMs,attempts" > "$MINING_CSV"

echo "=== Driving $N mine cycles on $SYSTEM node-1 (port $MINER_PORT) ==="
ALICE=$(curl -s -X POST localhost:$MINER_PORT/wallet | jq -r .walletId)
BOB=$(curl -s -X POST localhost:$MINER_PORT/wallet | jq -r .walletId)

for i in $(seq 1 "$N"); do
  curl -s -X POST localhost:$MINER_PORT/wallet/$ALICE/transaction \
    -H 'Content-Type: application/json' \
    -d "{\"toAddress\":\"$BOB\",\"amount\":1}" > /dev/null

  RESULT=$(curl -s -X POST localhost:$MINER_PORT/mine \
    -H 'Content-Type: application/json' \
    -d "{\"minerAddress\":\"$BOB\"}")

  INDEX=$(echo "$RESULT" | jq '.block.index')
  TXCOUNT=$(echo "$RESULT" | jq '.transactionCount')
  DURATION=$(echo "$RESULT" | jq '.durationMs')
  ATTEMPTS=$(echo "$RESULT" | jq '.attempts')
  echo "$i,$INDEX,$TXCOUNT,$DURATION,$ATTEMPTS" >> "$MINING_CSV"
  echo "  block $INDEX mined: ${DURATION}ms, tx=$TXCOUNT"

  # brief pause so propagation has time to complete before the next block
  sleep 0.3
done

echo ""
echo "=== Collecting propagation logs from all 3 $SYSTEM nodes ==="
PROP_CSV="results/${SYSTEM}_propagation.csv"
echo "fromNode,toNode,blockIndex,propagationMs,blockBytes,accepted,reason" > "$PROP_CSV"

for port in "${PORTS[@]}"; do
  curl -s "localhost:$port/metrics/propagation" | \
    jq -r '.records[] | [.fromNode, .toNode, .blockIndex, .propagationMs, .blockBytes, .accepted, (.reason // "")] | @csv' \
    >> "$PROP_CSV" || true
done

echo "Saved: $MINING_CSV"
echo "Saved: $PROP_CSV"
echo ""
echo "--- Quick summary ---"
echo "Mining time (ms), mean:"
tail -n +2 "$MINING_CSV" | awk -F, '{sum+=$4; n++} END {if(n>0) print sum/n; else print "no data"}'
echo "Propagation time (ms), mean:"
tail -n +2 "$PROP_CSV" | awk -F, '{sum+=$4; n++} END {if(n>0) print sum/n; else print "no data"}'
echo "Block bytes, mean:"
tail -n +2 "$PROP_CSV" | awk -F, '{sum+=$5; n++} END {if(n>0) print sum/n; else print "no data"}'
