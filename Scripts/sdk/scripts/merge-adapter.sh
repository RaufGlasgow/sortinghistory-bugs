#!/usr/bin/env bash
# merge-adapter.sh — Merge QLoRA adapter weights into the base model.
#
# Usage:
#   ./merge-adapter.sh                          Merge with defaults
#   ./merge-adapter.sh --model ~/models/other   Use a different base model
#   ./merge-adapter.sh --help                   Show this help text
#
# Merges the adapter from state/training/adapters/ into the base model
# and saves the result to state/training/merged/.
#
# After merging, runs a quick generation test to verify the model works.
# The merged model can be served with: ./serve-model.sh state/training/merged/
#
# Defaults:
#   --model   ~/models/qwen3-coder-30b
#
# Requirements: Python 3.11+, mlx-lm installed (see setup-mlx.sh)
# Platform: macOS (Apple Silicon)

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDK_DIR="$(dirname "$SCRIPT_DIR")"
ADAPTER_DIR="$SDK_DIR/state/training/adapters"
MERGED_DIR="$SDK_DIR/state/training/merged"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

MODEL="$HOME/models/qwen3-coder-30b"

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

# ---------------------------------------------------------------------------
# Parse CLI
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      ;;
    --model)
      MODEL="$2"; shift 2
      ;;
    *)
      err "Unknown option: $1"
      echo "Run '$0 --help' for usage." >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

if [ ! -d "$MODEL" ]; then
  err "Base model directory does not exist: $MODEL"
  err "Download the model first or specify --model <path>"
  exit 1
fi

if [ ! -d "$ADAPTER_DIR" ] || [ -z "$(ls -A "$ADAPTER_DIR" 2>/dev/null)" ]; then
  err "Adapter directory is empty or missing: $ADAPTER_DIR"
  err "Run fine-tune.sh first to generate adapter weights"
  exit 1
fi

log "=== merge-adapter.sh ==="
log "Base model:  $MODEL"
log "Adapter:     $ADAPTER_DIR"
log "Output:      $MERGED_DIR"
echo

# ---------------------------------------------------------------------------
# Clean previous merged output if present
# ---------------------------------------------------------------------------

if [ -d "$MERGED_DIR" ] && [ -n "$(ls -A "$MERGED_DIR" 2>/dev/null)" ]; then
  log "Removing previous merged model..."
  rm -rf "$MERGED_DIR"
fi

mkdir -p "$MERGED_DIR"

# ---------------------------------------------------------------------------
# Merge adapter into base model
# ---------------------------------------------------------------------------

log "Merging adapter into base model..."

python3 -m mlx_lm.fuse \
  --model "$MODEL" \
  --adapter-path "$ADAPTER_DIR" \
  --save-path "$MERGED_DIR"

# Verify output is non-empty
if [ -z "$(ls -A "$MERGED_DIR" 2>/dev/null)" ]; then
  err "Merge produced empty output directory: $MERGED_DIR"
  exit 1
fi

FILE_COUNT=$(ls -1 "$MERGED_DIR" | wc -l | tr -d ' ')
log "Merge complete: $FILE_COUNT file(s) in $MERGED_DIR"

# ---------------------------------------------------------------------------
# Verify merged model works
# ---------------------------------------------------------------------------

log "Running generation test on merged model..."

VERIFY_OUTPUT=$(python3 -m mlx_lm.generate \
  --model "$MERGED_DIR" \
  --prompt "Hello" \
  --max-tokens 20 \
  2>&1) || {
  err "Generation test failed. Merged model may be corrupt."
  err "Output: $VERIFY_OUTPUT"
  exit 1
}

log "Generation test passed."
log "Sample output: $(echo "$VERIFY_OUTPUT" | head -3)"
echo
log "Merged model ready at: $MERGED_DIR"
log "To serve: $SCRIPT_DIR/serve-model.sh $MERGED_DIR"
log "Done."
