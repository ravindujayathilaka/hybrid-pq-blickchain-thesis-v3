#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PIDFILE="$ROOT/.network-pids"
source "$ROOT/scripts/network-utils.sh"

stop_project_nodes
rm -f "$PIDFILE"

# Do not kill anything that cannot be identified as this project's node. Make
# any unrelated listener conflict visible so the next start cannot fail silently.
assert_network_ports_free
 echo "Network stopped."
