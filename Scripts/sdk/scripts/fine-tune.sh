#!/usr/bin/env bash
# fine-tune.sh — Run QLoRA fine-tuning on prepared training data using MLX-LM.
#
# Usage:
#   ./fine-tune.sh                          Run with defaults
#   ./fine-tune.sh --model ~/models/other   Use a different base model
#   ./fine-tune.sh --iters 100              Override iteration count
#   ./fine-tune.sh --learning-rate 2e-5     Override learning rate
#   ./fine-tune.sh --help                   Show this help text
#
# Defaults:
#   --model           ~/models/qwen3-coder-30b
#   --iters           200
#   --learning-rate   1e-5
#   --lora-layers     16
#   --lora-rank       8
#   --batch-size      1
#   --val-batches     10
#
# Output:
#   state/training/adapters/    QLoRA adapter weights
#   state/training/metrics.json Training run metrics
#
# Requirements: Python 3.11+, mlx-lm installed (see setup-mlx.sh)
# Platform: macOS (Apple Silicon)

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDK_DIR="$(dirname "$SCRIPT_DIR")"
PREPARED_DIR="$SDK_DIR/state/training/prepared"
ADAPTER_DIR="$SDK_DIR/state/training/adapters"
METRICS_FILE="$SDK_DIR/state/training/metrics.json"

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

MODEL="$HOME/models/qwen3-coder-30b"
ITERS=200
LEARNING_RATE="1e-5"
LORA_LAYERS=16
LORA_RANK=8
BATCH_SIZE=1
VAL_BATCHES=10

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
# Parse CLI overrides
# ---------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      usage
      ;;
    --model)
      MODEL="$2"; shift 2
      ;;
    --iters)
      ITERS="$2"; shift 2
      ;;
    --learning-rate)
      LEARNING_RATE="$2"; shift 2
      ;;
    --lora-layers)
      LORA_LAYERS="$2"; shift 2
      ;;
    --lora-rank)
      LORA_RANK="$2"; shift 2
      ;;
    --batch-size)
      BATCH_SIZE="$2"; shift 2
      ;;
    --val-batches)
      VAL_BATCHES="$2"; shift 2
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
  err "Model directory does not exist: $MODEL"
  err "Download the model first or specify --model <path>"
  exit 1
fi

if [ ! -f "$PREPARED_DIR/train.jsonl" ]; then
  err "Training data not found: $PREPARED_DIR/train.jsonl"
  err "Run prepare-training-data.py first"
  exit 1
fi

if [ ! -f "$PREPARED_DIR/val.jsonl" ]; then
  err "Validation data not found: $PREPARED_DIR/val.jsonl"
  err "Run prepare-training-data.py first"
  exit 1
fi

TRAIN_COUNT=$(wc -l < "$PREPARED_DIR/train.jsonl" | tr -d ' ')
VAL_COUNT=$(wc -l < "$PREPARED_DIR/val.jsonl" | tr -d ' ')

log "=== fine-tune.sh ==="
log "Model:         $MODEL"
log "Iterations:    $ITERS"
log "Learning rate: $LEARNING_RATE"
log "LoRA layers:   $LORA_LAYERS"
log "LoRA rank:     $LORA_RANK"
log "Batch size:    $BATCH_SIZE"
log "Val batches:   $VAL_BATCHES"
log "Train examples: $TRAIN_COUNT"
log "Val examples:   $VAL_COUNT"
log "Adapter output: $ADAPTER_DIR"
echo

# ---------------------------------------------------------------------------
# Ensure adapter directory exists
# ---------------------------------------------------------------------------

mkdir -p "$ADAPTER_DIR"

# ---------------------------------------------------------------------------
# Run fine-tuning, capture output
# ---------------------------------------------------------------------------

LOG_FILE="$SDK_DIR/state/training/fine-tune-$(date +%Y%m%d-%H%M%S).log"
START_TIME=$(date +%s)

log "Starting fine-tuning... (log: $LOG_FILE)"

python3 -m mlx_lm.lora \
  --model "$MODEL" \
  --adapter-path "$ADAPTER_DIR" \
  --data "$PREPARED_DIR" \
  --train \
  --lora-layers "$LORA_LAYERS" \
  --lora-rank "$LORA_RANK" \
  --batch-size "$BATCH_SIZE" \
  --iters "$ITERS" \
  --learning-rate "$LEARNING_RATE" \
  --val-batches "$VAL_BATCHES" \
  2>&1 | tee "$LOG_FILE"

EXIT_CODE=${PIPESTATUS[0]}
END_TIME=$(date +%s)
DURATION_MINUTES=$(( (END_TIME - START_TIME) / 60 ))

if [ "$EXIT_CODE" -ne 0 ]; then
  err "Fine-tuning failed with exit code $EXIT_CODE"
  err "Check log: $LOG_FILE"
  exit "$EXIT_CODE"
fi

log "Fine-tuning complete in ${DURATION_MINUTES} minute(s)"

# ---------------------------------------------------------------------------
# Parse metrics from log output (AC #4)
# ---------------------------------------------------------------------------

log "Parsing training metrics from log..."

# Extract training loss values (mlx_lm outputs lines like "Iter 1: Train loss 2.345, ...")
INITIAL_LOSS=""
FINAL_LOSS=""
INITIAL_VAL_LOSS=""
FINAL_VAL_LOSS=""

# Parse training losses — typical format: "Iter N: Train loss X.XXX, ..."
TRAIN_LOSSES=$(grep -oE 'Train loss [0-9]+\.[0-9]+' "$LOG_FILE" 2>/dev/null || true)
if [ -n "$TRAIN_LOSSES" ]; then
  INITIAL_LOSS=$(echo "$TRAIN_LOSSES" | head -1 | grep -oE '[0-9]+\.[0-9]+')
  FINAL_LOSS=$(echo "$TRAIN_LOSSES" | tail -1 | grep -oE '[0-9]+\.[0-9]+')
fi

# Parse validation losses — typical format: "Iter N: Val loss X.XXX, ..."
VAL_LOSSES=$(grep -oE 'Val loss [0-9]+\.[0-9]+' "$LOG_FILE" 2>/dev/null || true)
if [ -n "$VAL_LOSSES" ]; then
  INITIAL_VAL_LOSS=$(echo "$VAL_LOSSES" | head -1 | grep -oE '[0-9]+\.[0-9]+')
  FINAL_VAL_LOSS=$(echo "$VAL_LOSSES" | tail -1 | grep -oE '[0-9]+\.[0-9]+')
fi

# Fallback: try alternative log formats
if [ -z "$INITIAL_LOSS" ]; then
  # Some versions output "train_loss: X.XXX"
  ALT_LOSSES=$(grep -oE 'train_loss[: ]+[0-9]+\.[0-9]+' "$LOG_FILE" 2>/dev/null || true)
  if [ -n "$ALT_LOSSES" ]; then
    INITIAL_LOSS=$(echo "$ALT_LOSSES" | head -1 | grep -oE '[0-9]+\.[0-9]+')
    FINAL_LOSS=$(echo "$ALT_LOSSES" | tail -1 | grep -oE '[0-9]+\.[0-9]+')
  fi
fi

if [ -z "$INITIAL_VAL_LOSS" ]; then
  ALT_VAL=$(grep -oE 'val_loss[: ]+[0-9]+\.[0-9]+' "$LOG_FILE" 2>/dev/null || true)
  if [ -n "$ALT_VAL" ]; then
    INITIAL_VAL_LOSS=$(echo "$ALT_VAL" | head -1 | grep -oE '[0-9]+\.[0-9]+')
    FINAL_VAL_LOSS=$(echo "$ALT_VAL" | tail -1 | grep -oE '[0-9]+\.[0-9]+')
  fi
fi

# Default to null if not found
INITIAL_LOSS="${INITIAL_LOSS:-null}"
FINAL_LOSS="${FINAL_LOSS:-null}"
INITIAL_VAL_LOSS="${INITIAL_VAL_LOSS:-null}"
FINAL_VAL_LOSS="${FINAL_VAL_LOSS:-null}"

# Warn about loss trends
if [ "$INITIAL_LOSS" != "null" ] && [ "$FINAL_LOSS" != "null" ]; then
  # Use python for float comparison (bash can't do floats)
  LOSS_DECREASED=$(python3 -c "print('yes' if float('$FINAL_LOSS') < float('$INITIAL_LOSS') else 'no')" 2>/dev/null || echo "unknown")
  if [ "$LOSS_DECREASED" = "no" ]; then
    log "WARNING: Training loss did NOT decrease ($INITIAL_LOSS -> $FINAL_LOSS)"
    log "  The model may not be learning. Consider more data or different hyperparameters."
  fi
fi

if [ "$INITIAL_VAL_LOSS" != "null" ] && [ "$FINAL_VAL_LOSS" != "null" ] && [ "$FINAL_LOSS" != "null" ]; then
  OVERFITTING=$(python3 -c "
il = float('$INITIAL_VAL_LOSS')
fv = float('$FINAL_VAL_LOSS')
fl = float('$FINAL_LOSS')
# Overfitting: val loss increased while train loss decreased
if fv > il and fl < float('$INITIAL_LOSS'):
    print('yes')
else:
    print('no')
" 2>/dev/null || echo "unknown")
  if [ "$OVERFITTING" = "yes" ]; then
    log "WARNING: Possible overfitting detected"
    log "  Val loss increased ($INITIAL_VAL_LOSS -> $FINAL_VAL_LOSS) while train loss decreased"
    log "  Consider reducing --iters or adding more training data."
  fi
fi

# Quote numeric values, use null for missing
quote_or_null() {
  if [ "$1" = "null" ]; then
    echo "null"
  else
    echo "$1"
  fi
}

# Write metrics JSON
RUN_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
MODEL_NAME=$(basename "$MODEL")

cat > "$METRICS_FILE" << METRICS_EOF
{
  "run_date": "$RUN_DATE",
  "model": "$MODEL_NAME",
  "training_examples": $TRAIN_COUNT,
  "validation_examples": $VAL_COUNT,
  "initial_loss": $(quote_or_null "$INITIAL_LOSS"),
  "final_loss": $(quote_or_null "$FINAL_LOSS"),
  "initial_val_loss": $(quote_or_null "$INITIAL_VAL_LOSS"),
  "final_val_loss": $(quote_or_null "$FINAL_VAL_LOSS"),
  "iterations": $ITERS,
  "learning_rate": "$LEARNING_RATE",
  "lora_layers": $LORA_LAYERS,
  "lora_rank": $LORA_RANK,
  "batch_size": $BATCH_SIZE,
  "duration_minutes": $DURATION_MINUTES
}
METRICS_EOF

log "Metrics written to $METRICS_FILE"
log "Done."
