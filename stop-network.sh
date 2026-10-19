#!/bin/bash
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="$ROOT/.network-pids"

if [ ! -f "$PIDFILE" ]; then
  echo "No .network-pids file found — is the network running?"
  exit 1
fi

while read -r pid; do
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    echo "stopped pid $pid"
  fi
done < "$PIDFILE"

rm -f "$PIDFILE"
echo "Network stopped."
