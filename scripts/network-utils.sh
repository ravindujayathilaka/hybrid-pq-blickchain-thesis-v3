#!/usr/bin/env bash
# Shared process/port helpers for the six-node local experiment network.
# Only processes that can be identified as this project's compiled node
# processes are ever terminated; unrelated listeners are never killed.

network_ports=(4001 4011 4021 4002 4012 4022)

project_node_pid() {
  local pid="$1" cmd cwd
  [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/cmdline" ]] || return 1
  cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"

  if [[ "$cwd" == "$ROOT" && ( "$cmd" == *"packages/classical-node/dist/index.js"* || "$cmd" == *"packages/hybrid-node/dist/index.js"* ) ]]; then
    return 0
  fi
  if [[ "$cmd" == *"$ROOT/packages/classical-node/dist/index.js"* || "$cmd" == *"$ROOT/packages/hybrid-node/dist/index.js"* ]]; then
    return 0
  fi
  return 1
}

port_listener_pids() {
  local port="$1" output
  # Prefer ss with a LISTEN-state filter so ordinary outbound connections
  # using a matching remote port are not mistaken for local port conflicts.
  if command -v ss >/dev/null 2>&1; then
    output="$(ss -ltnp "sport = :$port" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -nu || true)"
    if [[ -n "$output" ]]; then
      printf '%s\n' "$output"
      return 0
    fi
    # An empty result can mean either no listener or insufficient permissions
    # to see process details. fuser is a fallback for systems where ss omits PIDs.
  fi
  if command -v fuser >/dev/null 2>&1; then
    output="$(fuser -n tcp "$port" 2>/dev/null || true)"
    printf '%s\n' "$output" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -nu || true
  elif ! command -v ss >/dev/null 2>&1; then
    echo "Neither fuser nor ss is available; cannot safely inspect port $port." >&2
    return 1
  fi
}

collect_project_node_pids() {
  local pid port
  declare -A seen=()

  if [[ -f "$PIDFILE" ]]; then
    while read -r pid; do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      if project_node_pid "$pid"; then seen["$pid"]=1; fi
    done < "$PIDFILE"
  fi

  for port in "${network_ports[@]}"; do
    while read -r pid; do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      if project_node_pid "$pid"; then seen["$pid"]=1; fi
    done < <(port_listener_pids "$port")
  done

  printf '%s\n' "${!seen[@]}" | grep -E '^[0-9]+$' | sort -nu || true
}

stop_project_nodes() {
  local pid attempt found=0
  local -a pids=()
  mapfile -t pids < <(collect_project_node_pids)

  if ((${#pids[@]} == 0)); then
    echo "No running node processes belonging to this project were found."
  else
    echo "Stopping existing project node process(es): ${pids[*]}"
    found=1
    for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
    for attempt in {1..20}; do
      local remaining=0
      for pid in "${pids[@]}"; do
        if kill -0 "$pid" 2>/dev/null && project_node_pid "$pid"; then remaining=1; fi
      done
      ((remaining == 0)) && break
      sleep 0.25
    done
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null && project_node_pid "$pid"; then
        echo "Node pid $pid did not stop gracefully; force-stopping it."
        kill -KILL "$pid" 2>/dev/null || true
      fi
    done
    echo "Stopped existing project nodes."
  fi
  return 0
}

assert_network_ports_free() {
  local port pid occupied=0
  for port in "${network_ports[@]}"; do
    while read -r pid; do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      occupied=1
      echo "ERROR: port $port is still occupied by pid $pid:" >&2
      ps -p "$pid" -o pid=,args= >&2 || true
    done < <(port_listener_pids "$port")
  done
  if ((occupied)); then
    echo "No nodes were started. Stop the process(es) above or choose unused ports." >&2
    return 1
  fi
}
