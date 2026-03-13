#!/usr/bin/env bash
# setup-mlx.sh — Install MLX-LM and download candidate models for local inference benchmarking.
#
# Usage:
#   ./setup-mlx.sh           Install dependencies and download all candidate models
#   ./setup-mlx.sh --help    Show this help text
#
# Requirements: Python 3.11+, pip, ~50GB disk space for models
# Platform: macOS (Apple Silicon)

set -euo pipefail

# ---------------------------------------------------------------------------
# Help (check before any variable declarations)
# ---------------------------------------------------------------------------

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,/^$/s/^# //p' "$0"
  exit 0
fi

# ---------------------------------------------------------------------------
# Config — parallel arrays (macOS bash 3.2 lacks associative arrays)
# ---------------------------------------------------------------------------

MODELS_DIR="${MODELS_DIR:-$HOME/models}"

MODEL_NAMES=("qwen3-coder-30b" "devstral-small-2" "qwen3.5-27b")
MODEL_REPOS=(
  "mlx-community/Qwen3-Coder-30B-A3B-4bit"
  "mlx-community/Devstral-Small-2-24B-Instruct-2512-4bit"
  "mlx-community/Qwen3.5-27B-4bit"
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

timestamp() { date "+%Y-%m-%d %H:%M:%S"; }
log()       { echo "[$(timestamp)] $*"; }
err()       { echo "[$(timestamp)] ERROR: $*" >&2; }

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

log "=== MLX Local Inference Setup ==="
log "Models directory: $MODELS_DIR"

# --- Step 1: Install Python dependencies -----------------------------------

log "Step 1/3: Installing mlx-lm and huggingface_hub via pip..."
python3 -m pip install --upgrade pip >/dev/null 2>&1 || true
python3 -m pip install "mlx-lm>=0.22" "huggingface_hub>=0.25" 2>&1 | tail -5

# Verify installation
if ! python3 -c "import mlx_lm; print(f'mlx-lm {mlx_lm.__version__}')" 2>/dev/null; then
  err "mlx-lm import failed after installation"
  exit 1
fi
log "mlx-lm installed successfully"

if ! python3 -c "import huggingface_hub; print(f'huggingface_hub {huggingface_hub.__version__}')" 2>/dev/null; then
  err "huggingface_hub import failed after installation"
  exit 1
fi
log "huggingface_hub installed successfully"

# --- Step 2: Download models -----------------------------------------------

log "Step 2/3: Downloading candidate models..."
mkdir -p "$MODELS_DIR"

FAILED=0
for idx in "${!MODEL_NAMES[@]}"; do
  name="${MODEL_NAMES[$idx]}"
  repo="${MODEL_REPOS[$idx]}"
  dest="$MODELS_DIR/$name"

  log "  Downloading $repo → $dest"

  if [[ -d "$dest" ]] && [[ -n "$(ls -A "$dest" 2>/dev/null)" ]]; then
    log "  Already exists and non-empty, skipping (delete to re-download)"
    continue
  fi

  mkdir -p "$dest"

  if ! python3 -c "
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id='${repo}',
    local_dir='${dest}',
    local_dir_use_symlinks=False,
)
print('Download complete')
" 2>&1; then
    err "Failed to download $repo"
    FAILED=$((FAILED + 1))
    continue
  fi

  log "  Downloaded $repo successfully"
done

# --- Step 3: Verify downloads ----------------------------------------------

log "Step 3/3: Verifying model directories..."
ALL_OK=true
for name in "${MODEL_NAMES[@]}"; do
  dest="$MODELS_DIR/$name"
  if [[ ! -d "$dest" ]] || [[ -z "$(ls -A "$dest" 2>/dev/null)" ]]; then
    err "Model directory missing or empty: $dest"
    ALL_OK=false
  else
    file_count=$(find "$dest" -type f | wc -l | tr -d ' ')
    log "  $name: $file_count files"
  fi
done

if [[ "$ALL_OK" == false ]]; then
  err "One or more models failed verification"
  exit 1
fi

if [[ "$FAILED" -gt 0 ]]; then
  err "$FAILED model download(s) failed"
  exit 1
fi

log "=== Setup complete. All models downloaded and verified. ==="
log "Model locations:"
for name in "${MODEL_NAMES[@]}"; do
  echo "  $MODELS_DIR/$name"
done

exit 0
