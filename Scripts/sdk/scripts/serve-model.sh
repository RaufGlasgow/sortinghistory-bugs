#!/usr/bin/env bash
# serve-model.sh — Start/stop an MLX-LM OpenAI-compatible server for a local model.
#
# Usage:
#   ./serve-model.sh <model-path>   Start serving the model at localhost:8080
#   ./serve-model.sh --stop         Stop the running server
#   ./serve-model.sh --status       Check if a server is running
#   ./serve-model.sh --help         Show this help text
#
# The server exposes an OpenAI-compatible API at http://localhost:8080/v1/
# A PID file is written to /tmp/mlx-server.pid for lifecycle management.
#
# Requirements: Python 3.11+, mlx-lm installed (see setup-mlx.sh)
# Platform: macOS (Apple Silicon)

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PORT="${MLX_PORT:-8080}"
HOST="${MLX_HOST:-127.0.0.1}"
PID_FILE="/tmp/mlx-server.pid"
LOG_FILE="/tmp/mlx-server.log"
HEALTH_TIMEOUT="${MLX_HEALTH_TIMEOUT:-120}"  # seconds

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

timestamp() { date "+%Y-%m-%d %H:%M:%S"; }
log()       { echo "[$(timestamp)] $*"; }
err()       { echo "[$(timestamp)] ERROR: $*" >&2; }

usage() {
  sed -n '2,/^$/s/^# //p' "$0"
  exit 0
}

get_pid() {
  if [[ -f "$PID_FILE" ]]; then
    cat "$PID_FILE"
  else
    echo ""
  fi
}

is_running() {
  local pid
  pid=$(get_pid)
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

do_stop() {
  local pid
  pid=$(get_pid)

  if [[ -z "$pid" ]]; then
    log "No PID file found at $PID_FILE — server may not be running"
    return 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    log "Stopping MLX server (PID $pid)..."
    kill "$pid" 2>/dev/null || true

    # Wait up to 10 seconds for graceful shutdown
    local wait=0
    while kill -0 "$pid" 2>/dev/null && [[ $wait -lt 10 ]]; do
      sleep 1
      wait=$((wait + 1))
    done

    # Force kill if still running
    if kill -0 "$pid" 2>/dev/null; then
      log "Graceful shutdown timed out, sending SIGKILL..."
      kill -9 "$pid" 2>/dev/null || true
    fi

    log "Server stopped"
  else
    log "Process $pid is not running (stale PID file)"
  fi

  rm -f "$PID_FILE"
  return 0
}

do_status() {
  if is_running; then
    local pid
    pid=$(get_pid)
    log "MLX server is running (PID $pid) on $HOST:$PORT"

    # Try health check
    if curl -sf "http://$HOST:$PORT/v1/models" >/dev/null 2>&1; then
      log "Health check: OK"
    else
      log "Health check: server process running but /v1/models not responding"
    fi
    return 0
  else
    log "MLX server is not running"
    return 1
  fi
}

do_start() {
  local model_path="$1"

  # Validate model path
  if [[ ! -d "$model_path" ]]; then
    err "Model path does not exist: $model_path"
    exit 1
  fi

  if [[ -z "$(ls -A "$model_path" 2>/dev/null)" ]]; then
    err "Model directory is empty: $model_path"
    exit 1
  fi

  # Stop any existing server
  if is_running; then
    log "Existing server detected, stopping first..."
    do_stop
  fi

  log "Starting MLX-LM server..."
  log "  Model: $model_path"
  log "  Endpoint: http://$HOST:$PORT/v1/"
  log "  Log: $LOG_FILE"

  # Start the server in the background
  python3 -m mlx_lm.server \
    --model "$model_path" \
    --host "$HOST" \
    --port "$PORT" \
    > "$LOG_FILE" 2>&1 &

  local server_pid=$!
  echo "$server_pid" > "$PID_FILE"
  log "Server started with PID $server_pid"

  # Health check — wait for /v1/models to return HTTP 200
  log "Waiting for health check (timeout: ${HEALTH_TIMEOUT}s)..."
  local elapsed=0
  local interval=2

  while [[ $elapsed -lt $HEALTH_TIMEOUT ]]; do
    # Check if process is still alive
    if ! kill -0 "$server_pid" 2>/dev/null; then
      err "Server process exited unexpectedly. Check $LOG_FILE"
      rm -f "$PID_FILE"
      tail -20 "$LOG_FILE" >&2
      exit 1
    fi

    # Try the health endpoint
    if curl -sf "http://$HOST:$PORT/v1/models" >/dev/null 2>&1; then
      log "Health check passed after ${elapsed}s"
      log "Server is ready at http://$HOST:$PORT/v1/"
      return 0
    fi

    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  # Timeout — kill and report failure
  err "Health check timed out after ${HEALTH_TIMEOUT}s"
  err "Last 20 lines of server log:"
  tail -20 "$LOG_FILE" >&2
  do_stop
  exit 1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

case "${1:-}" in
  --help|-h)
    usage
    ;;
  --stop)
    do_stop
    ;;
  --status)
    do_status
    ;;
  "")
    err "No model path provided"
    echo "Usage: $0 <model-path> | --stop | --status | --help" >&2
    exit 1
    ;;
  *)
    do_start "$1"
    ;;
esac
