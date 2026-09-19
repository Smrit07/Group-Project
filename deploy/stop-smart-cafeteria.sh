#!/usr/bin/env bash
# ==============================================================================
#  Stop the Node API and the Python DES engine (macOS/Linux).
# ==============================================================================
#  Kills by PID file, not by process name — a blanket `pkill node` would also
#  take down VS Code's language server, any other Node project you have
#  running, and anything else that happens to be a Node process.
#
#  Apache and MySQL are left alone: stop those from the XAMPP Control Panel
#  if you want to, since other work may be using them.
#
#  Pass --quiet to suppress the "nothing was running" messages — used by
#  start-smart-cafeteria.sh when it clears out a previous run first.
# ==============================================================================

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUIET=false
[ "${1:-}" = "--quiet" ] && QUIET=true

say() { $QUIET || echo "$@"; }

stop_pidfile() {
  local pidfile="$1"
  local label="$2"

  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      # Give it a moment to shut down cleanly (server.js has a graceful
      # shutdown handler that closes the DB pool) before forcing it.
      for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
      done
      kill -9 "$pid" 2>/dev/null
      say "  [ok] $label stopped."
    else
      say "  [-] $label was not running."
    fi
    rm -f "$pidfile"
  else
    say "  [-] $label was not running (no PID file)."
  fi
}

say
say "  Stopping Smart Cafeteria services..."
stop_pidfile "$SCRIPT_DIR/.api.pid" "API server"
stop_pidfile "$SCRIPT_DIR/.des-engine.pid" "DES engine"

say
say "  Apache and MySQL were left running — stop them from the XAMPP Control Panel."
say
