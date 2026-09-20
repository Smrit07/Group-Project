#!/usr/bin/env bash
# ==============================================================================
#  Smart Cafeteria & Resource Queue Optimizer — start everything (macOS/Linux)
# ==============================================================================
#  Starts the two processes XAMPP cannot run itself:
#     * the Express API + Socket.io server   (Node, port 4000)
#     * the SimPy discrete-event engine      (Python, port 5001)
#
#  You still start Apache and MySQL yourself — from the XAMPP Control Panel
#  (Manager-osx.app on Mac). This script checks that MySQL is actually up
#  before starting anything, because a backend started against a dead
#  database produces confusing errors ten minutes later instead of one clear
#  one now.
#
#  Run it from the project root:
#      chmod +x deploy/start-smart-cafeteria.sh   (first time only)
#      ./deploy/start-smart-cafeteria.sh
# ==============================================================================

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

DES_PID_FILE="$ROOT/deploy/.des-engine.pid"
API_PID_FILE="$ROOT/deploy/.api.pid"
DES_LOG="$ROOT/deploy/des-engine.log"
API_LOG="$ROOT/deploy/api.log"

echo
echo "  ==============================================================="
echo "   Smart Cafeteria & Resource Queue Optimizer"
echo "   Project root: $ROOT"
echo "  ==============================================================="
echo

fail() {
  echo
  echo "  Startup aborted: $1"
  echo
  exit 1
}

# ------------------------------------------------------------------------
# Prerequisite checks. Each one fails with an instruction, not a code.
# ------------------------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "Node.js is not on your PATH. Install it from https://nodejs.org and reopen your terminal."

PYTHON=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
[ -n "$PYTHON" ] || fail "Python 3 is not on your PATH. Install it from https://python.org."

# nc (netcat) is on every Mac by default; this is the least fragile way to
# ask "is MySQL listening" without needing the mysql client on PATH, which
# XAMPP does not add to PATH by default on macOS.
if command -v nc >/dev/null 2>&1; then
  if ! nc -z -w2 127.0.0.1 3306 >/dev/null 2>&1; then
    fail "Nothing is listening on port 3306, so MySQL is not running. \
Open the XAMPP Control Panel (Manager-osx.app) and start MySQL, then run this script again."
  fi
else
  echo "  [!] 'nc' not found — skipping the MySQL port check. Make sure MySQL is running."
fi
echo "  [ok] MySQL is listening on port 3306."

# ------------------------------------------------------------------------
# First-run setup. Skipped silently on every run after the first.
# ------------------------------------------------------------------------
if [ ! -d "$ROOT/backend/node_modules" ]; then
  echo "  [..] Installing backend dependencies (first run only)..."
  (cd "$ROOT/backend" && npm install --no-audit --no-fund) || fail "npm install failed in backend/."
fi

if [ ! -f "$ROOT/backend/.env" ]; then
  echo "  [..] Creating backend/.env from the example."
  cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
  echo "  [!] Edit backend/.env and set JWT_SECRET to a long random string"
  echo "      before showing this to anyone outside your own machine."
fi

if [ ! -f "$ROOT/des-engine/.env" ]; then
  cp "$ROOT/des-engine/.env.example" "$ROOT/des-engine/.env"
fi

# A marker file rather than checking for a directory: pip installs into the
# global (or venv) site-packages, so there is nothing local to look for.
if [ ! -f "$ROOT/des-engine/.installed" ]; then
  echo "  [..] Installing Python dependencies (first run only)..."
  (cd "$ROOT/des-engine" && "$PYTHON" -m pip install -r requirements.txt --quiet) \
    || fail "pip install failed. Run it manually to see why: cd des-engine && $PYTHON -m pip install -r requirements.txt"
  touch "$ROOT/des-engine/.installed"
fi

# ------------------------------------------------------------------------
# Stop any previous run first, so re-running this script doesn't leave two
# copies of each process fighting over the same port.
# ------------------------------------------------------------------------
"$SCRIPT_DIR/stop-smart-cafeteria.sh" --quiet

# ------------------------------------------------------------------------
# Start the two services in the background, each logging to its own file.
# Unlike the Windows .bat (which opens a visible window per process), a
# terminal here would block the script, so output goes to deploy/*.log —
# tail -f either one to watch it live.
# ------------------------------------------------------------------------
echo
echo "  [..] Starting the DES simulation engine on port 5001..."
(cd "$ROOT/des-engine" && "$PYTHON" app.py >"$DES_LOG" 2>&1 &
 echo $! >"$DES_PID_FILE")

# Give Python a moment to import SimPy and bind the port, so the backend's
# own startup health check finds it and prints "engine ready" rather than a
# warning that is already out of date by the time you read it.
sleep 3

echo "  [..] Starting the API server on port 4000..."
(cd "$ROOT/backend" && npm start >"$API_LOG" 2>&1 &
 echo $! >"$API_PID_FILE")

sleep 3

# ------------------------------------------------------------------------
# Report status by actually asking each service, not by assuming the sleep
# was long enough.
# ------------------------------------------------------------------------
des_ok=false
api_ok=false

if command -v curl >/dev/null 2>&1; then
  curl -sf http://127.0.0.1:5001/health >/dev/null 2>&1 && des_ok=true
  curl -sf http://127.0.0.1:4000/api/health >/dev/null 2>&1 && api_ok=true
fi

echo
echo "  ==============================================================="
if $des_ok; then echo "   [ok] DES engine responding on :5001"
else echo "   [!!] DES engine not responding yet — check deploy/des-engine.log"; fi
if $api_ok; then echo "   [ok] API responding on :4000"
else echo "   [!!] API not responding yet — check deploy/api.log"; fi
echo
echo "   App  (via Apache)  http://localhost/smart-cafeteria/"
echo "   App  (via Node)    http://localhost:4000/"
echo "   API health         http://localhost:4000/api/health"
echo "   DES engine         http://localhost:5001/health"
echo "   phpMyAdmin         http://localhost/phpmyadmin"
echo
echo "   Demo logins — password for all of them is  Password123!"
echo "     student@example.com   manager@example.com"
echo "     staff@example.com     admin@example.com"
echo
echo "   Logs:   tail -f deploy/api.log   |   tail -f deploy/des-engine.log"
echo "   Stop:   ./deploy/stop-smart-cafeteria.sh"
echo "  ==============================================================="
echo
