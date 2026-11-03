#!/usr/bin/env bash
# serve-local.sh — run the whole game locally: the multiplayer server (wrangler, :8787) and the
# game client (Vite, :2141) in one terminal. Ctrl+C stops both.
#
# The one non-obvious thing: anything ALREADY listening on those ports is reused, never restarted.
# The Vite config's freePort plugin would otherwise kill a running dev server, and a second
# wrangler sharing .wrangler/state locks its SQLite store (SQLITE_BUSY). Only what THIS script
# started is stopped on exit.
#
# Usage:   ./serve-local.sh            (or: pnpm serve:local)
# Env:     WEB_PORT      client port            (default 2141)
#          NET_PORT      server port            (default 8787; Vite proxies /api + /room to it)
#          INSPECT_PORT  wrangler inspector     (default 9229)
#          PERSIST_DIR   wrangler state folder  (default .wrangler/state — rooms/profiles live here)

set -euo pipefail
cd "$(dirname "$0")"

WEB_PORT="${WEB_PORT:-2141}"
NET_PORT="${NET_PORT:-8787}"
INSPECT_PORT="${INSPECT_PORT:-9229}"
PERSIST_DIR="${PERSIST_DIR:-}"

# ==========================================================================
# HELPERS
# ==========================================================================

listening() { ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN; }

# Wait up to $2 seconds for port $1 to start listening.
wait_port() {
  local port=$1 secs=$2
  for ((i = 0; i < secs * 4; i++)); do
    listening "$port" && return 0
    sleep 0.25
  done
  return 1
}

# Process-group leaders this script started (setsid), killed as whole groups on exit.
STARTED=()
cleanup() {
  trap - INT TERM EXIT
  ((${#STARTED[@]})) || return 0
  echo
  echo "[serve-local] stopping..."
  for pg in "${STARTED[@]}"; do kill -TERM -- "-$pg" 2>/dev/null || true; done
  sleep 1
  for pg in "${STARTED[@]}"; do kill -KILL -- "-$pg" 2>/dev/null || true; done
}
trap cleanup INT TERM EXIT

# Run "$2" in its own process group, prefixing every output line with "[$1] ".
start() {
  local tag=$1 cmd=$2
  setsid bash -c "$cmd 2>&1 | sed -u 's/^/[$tag] /'" &
  STARTED+=($!)
}

# ==========================================================================
# START
# ==========================================================================

if [[ ! -d node_modules ]]; then
  echo "[serve-local] node_modules missing — run 'pnpm install' first." >&2
  exit 1
fi

# ---- MULTIPLAYER SERVER (wrangler) -------------------------------------
if listening "$NET_PORT"; then
  echo "[serve-local] server already running on :$NET_PORT — reusing it"
else
  persist=()
  [[ -n "$PERSIST_DIR" ]] && persist=(--persist-to "$PERSIST_DIR")
  start net "pnpm exec wrangler dev --port $NET_PORT --inspector-port $INSPECT_PORT ${persist[*]:-}"
  if ! wait_port "$NET_PORT" 60; then
    echo "[serve-local] server did not come up on :$NET_PORT within 60s" >&2
    exit 1
  fi
fi

# ---- GAME CLIENT (Vite) ------------------------------------------------
if listening "$WEB_PORT"; then
  echo "[serve-local] client already running on :$WEB_PORT — reusing it"
else
  start web "NET_PORT=$NET_PORT pnpm exec vite --port $WEB_PORT"
  if ! wait_port "$WEB_PORT" 60; then
    echo "[serve-local] client did not come up on :$WEB_PORT within 60s" >&2
    exit 1
  fi
fi

# ---- READY -------------------------------------------------------------
lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "[serve-local] ready"
echo "  this PC : http://localhost:$WEB_PORT"
[[ -n "$lan_ip" ]] && echo "  same LAN: http://$lan_ip:$WEB_PORT   (other players open this)"

if ((${#STARTED[@]} == 0)); then
  echo "[serve-local] both were already running — nothing to stop."
  trap - INT TERM EXIT
  exit 0
fi
echo "  Ctrl+C stops what this script started."

# Stay up until Ctrl+C, or until one of our servers exits on its own.
wait -n "${STARTED[@]}" || true
echo "[serve-local] a server exited — shutting down the rest"
