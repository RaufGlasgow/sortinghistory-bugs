#!/usr/bin/env bash
# benchmark-models.sh — Sequential benchmark of candidate MLX models for local inference.
#
# Usage:
#   ./benchmark-models.sh                  Run full benchmark suite
#   ./benchmark-models.sh --models-dir DIR Override models directory (default: ~/models)
#   ./benchmark-models.sh --help           Show this help text
#
# For each candidate model, starts the MLX server, runs 3 test prompts capturing
# tool-call success/accuracy, tokens/sec, and peak memory, then stops the server.
#
# Output: Scripts/sdk/state/training/benchmark-results.json
#
# Requirements: Python 3.11+, mlx-lm, jq, curl
# Platform: macOS (Apple Silicon)

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDK_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_FILE="$SDK_DIR/state/training/benchmark-results.json"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"
PORT="${MLX_PORT:-8080}"
HOST="${MLX_HOST:-127.0.0.1}"
BASE_URL="http://$HOST:$PORT/v1"
PID_FILE="/tmp/mlx-server.pid"

# Models to benchmark (directory name under MODELS_DIR)
MODEL_NAMES=("qwen3-coder-30b" "devstral-small-2" "qwen3.5-27b")
MODEL_LABELS=("Qwen3-Coder-30B-A3B-4bit" "Devstral-Small-2-24B-Instruct-2512-4bit" "Qwen3.5-27B-4bit")

# Memory sampling interval (milliseconds)
MEM_SAMPLE_INTERVAL_MS=500

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

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "Required command not found: $1"; exit 1; }
}

# Get RSS of the mlx_lm.server process in KB
get_rss_kb() {
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || echo "0"
  else
    echo "0"
  fi
}

# Background memory sampler — writes peak RSS to a temp file
start_mem_sampler() {
  local peak_file="$1"
  echo "0" > "$peak_file"
  (
    while true; do
      rss=$(get_rss_kb)
      current_peak=$(cat "$peak_file" 2>/dev/null || echo "0")
      if [[ "$rss" -gt "$current_peak" ]]; then
        echo "$rss" > "$peak_file"
      fi
      sleep 0.5
    done
  ) &
  echo $!
}

stop_mem_sampler() {
  local sampler_pid="$1"
  kill "$sampler_pid" 2>/dev/null || true
  wait "$sampler_pid" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Test Prompts
# ---------------------------------------------------------------------------

# Prompt 1: Bug-fixer system prompt + Bug #156 context
# Expected: Read tool call with a .swift file path
PROMPT_1_SYSTEM='You are a senior iOS developer fixing a bug in a SwiftUI trivia game called "Sorting History." Explore the codebase, identify the issue, and fix it. Use tools to read and edit files.'

PROMPT_1_USER='Bug #156: A user was playing US History Epic and a natural disaster from another part of the world showed up as a new event. This is clearly a miscategorized event — an event in the wrong category JSON file.

Investigate which event is miscategorized by reading the relevant category JSON files. Start by reading the US History events file to look for non-US events.

Use the Read tool to examine: Data/Events/us-history.json'

PROMPT_1_TOOLS='[{"type":"function","function":{"name":"Read","description":"Read a file from disk","parameters":{"type":"object","properties":{"file_path":{"type":"string","description":"Path to the file to read"}},"required":["file_path"]}}},{"type":"function","function":{"name":"Edit","description":"Edit a file on disk","parameters":{"type":"object","properties":{"file_path":{"type":"string","description":"Path to the file"},"old_string":{"type":"string","description":"Text to replace"},"new_string":{"type":"string","description":"Replacement text"}},"required":["file_path","old_string","new_string"]}}}]'

# Prompt 2: Content error fix — JSON date correction
# Expected: Edit tool call with a .json file path
PROMPT_2_SYSTEM='You are a content editor for a historical trivia game. Fix factual errors in event JSON files.'

PROMPT_2_USER='The event "Apollo 11 Moon Landing" in Data/Events/space-history.json has the wrong date. It shows "1969-07-16" but the actual landing date was July 20, 1969 (the 16th was the launch date). Use the Edit tool to fix the date field from "1969-07-16" to "1969-07-20" in the JSON file.

The relevant JSON snippet is:
{
  "title": "Apollo 11 Moon Landing",
  "date": "1969-07-16",
  "description": "First crewed Moon landing"
}

Fix only the date field using the Edit tool on Data/Events/space-history.json.'

PROMPT_2_TOOLS='[{"type":"function","function":{"name":"Read","description":"Read a file from disk","parameters":{"type":"object","properties":{"file_path":{"type":"string","description":"Path to the file to read"}},"required":["file_path"]}}},{"type":"function","function":{"name":"Edit","description":"Edit a file on disk","parameters":{"type":"object","properties":{"file_path":{"type":"string","description":"Path to the file"},"old_string":{"type":"string","description":"Text to replace"},"new_string":{"type":"string","description":"Replacement text"}},"required":["file_path","old_string","new_string"]}}}]'

# Prompt 3: Multi-file read + edit — requires 2+ tool calls
# Expected: Read tool call THEN Edit tool call (sequential)
PROMPT_3_SYSTEM='You are a developer maintaining a trivia game. You need to read a configuration file, then update a related source file based on what you find.'

PROMPT_3_USER='Task: First, read the category configuration from Data/Events/categories.json to find the display name for the "world-wars" category. Then, edit Views/CategoryListView.swift to add a comment on line 1 that says "// Categories loaded from categories.json".

Step 1: Use Read tool on Data/Events/categories.json
Step 2: Use Edit tool on Views/CategoryListView.swift to add the comment

You MUST use both tools in sequence — Read first, then Edit.'

PROMPT_3_TOOLS='[{"type":"function","function":{"name":"Read","description":"Read a file from disk","parameters":{"type":"object","properties":{"file_path":{"type":"string","description":"Path to the file to read"}},"required":["file_path"]}}},{"type":"function","function":{"name":"Edit","description":"Edit a file on disk","parameters":{"type":"object","properties":{"file_path":{"type":"string","description":"Path to the file"},"old_string":{"type":"string","description":"Text to replace"},"new_string":{"type":"string","description":"Replacement text"}},"required":["file_path","old_string","new_string"]}}}]'

# ---------------------------------------------------------------------------
# Send a chat completion request and capture the full response
# ---------------------------------------------------------------------------

send_prompt() {
  local system_prompt="$1"
  local user_prompt="$2"
  local tools_json="$3"
  local response_file="$4"

  local request_body
  request_body=$(jq -n \
    --arg system "$system_prompt" \
    --arg user "$user_prompt" \
    --argjson tools "$tools_json" \
    '{
      model: "local-model",
      messages: [
        {role: "system", content: $system},
        {role: "user", content: $user}
      ],
      tools: $tools,
      tool_choice: "auto",
      max_tokens: 2048,
      temperature: 0.1
    }')

  local start_time
  start_time=$(python3 -c "import time; print(time.time())")

  local http_code
  http_code=$(curl -sf -w "%{http_code}" \
    -o "$response_file" \
    -H "Content-Type: application/json" \
    -d "$request_body" \
    "$BASE_URL/chat/completions" 2>/dev/null) || http_code="000"

  local end_time
  end_time=$(python3 -c "import time; print(time.time())")

  local duration
  duration=$(python3 -c "print(round($end_time - $start_time, 3))")

  echo "$http_code|$duration"
}

# ---------------------------------------------------------------------------
# Analyze a single prompt response for tool-call metrics
# ---------------------------------------------------------------------------

analyze_response() {
  local response_file="$1"
  local prompt_id="$2"
  local duration="$3"
  local peak_mem_kb="$4"

  local tool_call_success="false"
  local tool_call_accuracy="false"
  local swift_valid="n/a"
  local tokens_per_sec="0"
  local completion_tokens=0
  local prompt_tokens=0

  # Check if response is valid JSON
  if ! jq -e . "$response_file" >/dev/null 2>&1; then
    echo "{\"prompt_id\":$prompt_id,\"tool_call_success\":false,\"tool_call_accuracy\":false,\"swift_valid\":\"n/a\",\"tokens_per_sec\":0,\"completion_tokens\":0,\"prompt_tokens\":0,\"duration_seconds\":$duration,\"peak_memory_mb\":0,\"error\":\"Invalid JSON response\"}"
    return
  fi

  # Extract token counts
  completion_tokens=$(jq -r '.usage.completion_tokens // 0' "$response_file")
  prompt_tokens=$(jq -r '.usage.prompt_tokens // 0' "$response_file")

  # Calculate tokens/sec
  if [[ "$completion_tokens" -gt 0 ]] && (( $(echo "$duration > 0" | bc -l 2>/dev/null || echo "0") )); then
    tokens_per_sec=$(python3 -c "print(round($completion_tokens / $duration, 2))")
  fi

  # Peak memory in MB
  local peak_mem_mb=0
  if [[ "$peak_mem_kb" -gt 0 ]]; then
    peak_mem_mb=$(python3 -c "print(round($peak_mem_kb / 1024, 1))")
  fi

  # Check for tool calls in the response
  local tool_calls
  tool_calls=$(jq -r '.choices[0].message.tool_calls // empty' "$response_file" 2>/dev/null)

  if [[ -n "$tool_calls" ]] && [[ "$tool_calls" != "null" ]]; then
    local num_calls
    num_calls=$(jq -r '.choices[0].message.tool_calls | length' "$response_file" 2>/dev/null || echo "0")

    if [[ "$num_calls" -gt 0 ]]; then
      tool_call_success="true"

      # Check accuracy based on prompt expectations
      case "$prompt_id" in
        1)
          # Expects: Read with .swift or .json path
          local first_tool
          first_tool=$(jq -r '.choices[0].message.tool_calls[0].function.name // ""' "$response_file")
          local first_args
          first_args=$(jq -r '.choices[0].message.tool_calls[0].function.arguments // ""' "$response_file")

          if [[ "$first_tool" == "Read" ]]; then
            # Check if arguments reference a relevant file path
            if echo "$first_args" | jq -r '.file_path // ""' 2>/dev/null | grep -qiE '\.(swift|json)$'; then
              tool_call_accuracy="true"
            fi
          fi
          ;;
        2)
          # Expects: Edit with .json path
          local has_edit="false"
          for i in $(seq 0 $((num_calls - 1))); do
            local tool_name
            tool_name=$(jq -r ".choices[0].message.tool_calls[$i].function.name // \"\"" "$response_file")
            local tool_args
            tool_args=$(jq -r ".choices[0].message.tool_calls[$i].function.arguments // \"\"" "$response_file")

            if [[ "$tool_name" == "Edit" ]]; then
              if echo "$tool_args" | jq -r '.file_path // ""' 2>/dev/null | grep -qiE '\.json$'; then
                has_edit="true"
              fi
            fi
          done
          tool_call_accuracy="$has_edit"
          ;;
        3)
          # Expects: 2+ tool calls with Read + Edit
          if [[ "$num_calls" -ge 2 ]]; then
            local has_read="false"
            local has_edit="false"
            for i in $(seq 0 $((num_calls - 1))); do
              local tool_name
              tool_name=$(jq -r ".choices[0].message.tool_calls[$i].function.name // \"\"" "$response_file")
              [[ "$tool_name" == "Read" ]] && has_read="true"
              [[ "$tool_name" == "Edit" ]] && has_edit="true"
            done
            [[ "$has_read" == "true" && "$has_edit" == "true" ]] && tool_call_accuracy="true"
          fi
          ;;
      esac

      # Swift validity check: if response contains Swift code, validate with swiftc
      local content
      content=$(jq -r '.choices[0].message.content // ""' "$response_file" 2>/dev/null)
      if echo "$content" | grep -q 'import SwiftUI\|import Foundation\|struct.*View'; then
        local swift_tmp
        swift_tmp=$(mktemp /tmp/bench_swift_XXXXXX.swift)
        # Extract Swift code block
        echo "$content" | sed -n '/```swift/,/```/p' | sed '1d;$d' > "$swift_tmp"
        if [[ -s "$swift_tmp" ]]; then
          if xcrun swiftc -typecheck "$swift_tmp" 2>/dev/null; then
            swift_valid="pass"
          else
            swift_valid="fail"
          fi
        fi
        rm -f "$swift_tmp"
      fi
    fi
  fi

  # Build result JSON
  jq -n \
    --argjson prompt_id "$prompt_id" \
    --argjson tool_call_success "$tool_call_success" \
    --argjson tool_call_accuracy "$tool_call_accuracy" \
    --arg swift_valid "$swift_valid" \
    --argjson tokens_per_sec "$tokens_per_sec" \
    --argjson completion_tokens "$completion_tokens" \
    --argjson prompt_tokens "$prompt_tokens" \
    --argjson duration "$duration" \
    --argjson peak_memory_mb "$peak_mem_mb" \
    '{
      prompt_id: $prompt_id,
      tool_call_success: $tool_call_success,
      tool_call_accuracy: $tool_call_accuracy,
      swift_valid: $swift_valid,
      tokens_per_sec: $tokens_per_sec,
      completion_tokens: $completion_tokens,
      prompt_tokens: $prompt_tokens,
      duration_seconds: $duration,
      peak_memory_mb: $peak_memory_mb
    }'
}

# ---------------------------------------------------------------------------
# Benchmark a single model
# ---------------------------------------------------------------------------

benchmark_model() {
  local model_name="$1"
  local model_label="$2"
  local model_path="$MODELS_DIR/$model_name"

  log "--- Benchmarking: $model_label ---"
  log "  Path: $model_path"

  # Verify model exists
  if [[ ! -d "$model_path" ]] || [[ -z "$(ls -A "$model_path" 2>/dev/null)" ]]; then
    err "Model not found or empty: $model_path"
    echo "{\"model\":\"$model_label\",\"model_dir\":\"$model_name\",\"error\":\"Model not found\",\"prompts\":[]}"
    return
  fi

  # Start server
  log "  Starting MLX server..."
  if ! "$SCRIPT_DIR/serve-model.sh" "$model_path"; then
    err "Failed to start server for $model_name"
    echo "{\"model\":\"$model_label\",\"model_dir\":\"$model_name\",\"error\":\"Server start failed\",\"prompts\":[]}"
    return
  fi

  local prompt_results="[]"

  # Run each prompt
  local prompts_systems=("$PROMPT_1_SYSTEM" "$PROMPT_2_SYSTEM" "$PROMPT_3_SYSTEM")
  local prompts_users=("$PROMPT_1_USER" "$PROMPT_2_USER" "$PROMPT_3_USER")
  local prompts_tools=("$PROMPT_1_TOOLS" "$PROMPT_2_TOOLS" "$PROMPT_3_TOOLS")
  local prompt_descriptions=(
    "Bug-fixer: Read .swift/.json file"
    "Content fix: Edit .json date"
    "Multi-step: Read + Edit sequence"
  )

  for i in 0 1 2; do
    local prompt_id=$((i + 1))
    log "  Prompt $prompt_id/3: ${prompt_descriptions[$i]}"

    local response_file
    response_file=$(mktemp /tmp/bench_response_XXXXXX.json)
    local peak_file
    peak_file=$(mktemp /tmp/bench_peak_XXXXXX.txt)

    # Start memory sampler
    local sampler_pid
    sampler_pid=$(start_mem_sampler "$peak_file")

    # Send the prompt
    local result
    result=$(send_prompt "${prompts_systems[$i]}" "${prompts_users[$i]}" "${prompts_tools[$i]}" "$response_file")

    # Stop memory sampler
    stop_mem_sampler "$sampler_pid"

    local http_code duration peak_mem_kb
    http_code=$(echo "$result" | cut -d'|' -f1)
    duration=$(echo "$result" | cut -d'|' -f2)
    peak_mem_kb=$(cat "$peak_file" 2>/dev/null || echo "0")

    if [[ "$http_code" != "200" ]]; then
      log "    HTTP $http_code — request failed"
      local error_result
      error_result=$(jq -n \
        --argjson prompt_id "$prompt_id" \
        --arg desc "${prompt_descriptions[$i]}" \
        --arg http_code "$http_code" \
        '{prompt_id: $prompt_id, description: $desc, tool_call_success: false, tool_call_accuracy: false, error: ("HTTP " + $http_code)}')
      prompt_results=$(echo "$prompt_results" | jq --argjson r "$error_result" '. + [$r]')
    else
      log "    HTTP 200 — analyzing response..."
      local analysis
      analysis=$(analyze_response "$response_file" "$prompt_id" "$duration" "$peak_mem_kb")
      analysis=$(echo "$analysis" | jq --arg desc "${prompt_descriptions[$i]}" '. + {description: $desc}')

      local tc_success tc_accuracy tps
      tc_success=$(echo "$analysis" | jq -r '.tool_call_success')
      tc_accuracy=$(echo "$analysis" | jq -r '.tool_call_accuracy')
      tps=$(echo "$analysis" | jq -r '.tokens_per_sec')
      log "    tool_call_success=$tc_success accuracy=$tc_accuracy tokens/s=$tps"

      prompt_results=$(echo "$prompt_results" | jq --argjson r "$analysis" '. + [$r]')
    fi

    rm -f "$response_file" "$peak_file"
  done

  # Stop server
  log "  Stopping MLX server..."
  "$SCRIPT_DIR/serve-model.sh" --stop

  # Compute aggregate metrics
  local total_success avg_tps
  total_success=$(echo "$prompt_results" | jq '[.[] | select(.tool_call_success == true)] | length')
  avg_tps=$(echo "$prompt_results" | jq '[.[] | .tokens_per_sec // 0] | add / length | . * 100 | round / 100')
  local total_accuracy
  total_accuracy=$(echo "$prompt_results" | jq '[.[] | select(.tool_call_accuracy == true)] | length')
  local max_mem
  max_mem=$(echo "$prompt_results" | jq '[.[] | .peak_memory_mb // 0] | max')

  jq -n \
    --arg model "$model_label" \
    --arg model_dir "$model_name" \
    --argjson prompts "$prompt_results" \
    --argjson tool_call_successes "$total_success" \
    --argjson tool_call_accuracies "$total_accuracy" \
    --argjson avg_tokens_per_sec "$avg_tps" \
    --argjson peak_memory_mb "$max_mem" \
    '{
      model: $model,
      model_dir: $model_dir,
      tool_call_successes: ($tool_call_successes | tostring) + "/3",
      tool_call_accuracies: ($tool_call_accuracies | tostring) + "/3",
      avg_tokens_per_sec: $avg_tokens_per_sec,
      peak_memory_mb: $peak_memory_mb,
      prompts: $prompts
    }'
}

# ---------------------------------------------------------------------------
# Model Selection Logic (AC #6)
# ---------------------------------------------------------------------------

select_models() {
  local results_json="$1"

  log "=== Model Selection ==="

  # Score each model: tool_call_successes as primary, avg_tokens_per_sec as tiebreaker
  local selection
  selection=$(echo "$results_json" | jq '
    # Parse "X/3" success strings to numbers for sorting
    [.models[] | select(.error == null)] |
    map(. + {
      success_count: (.tool_call_successes | split("/")[0] | tonumber),
      accuracy_count: (.tool_call_accuracies | split("/")[0] | tonumber)
    }) |
    sort_by([-.success_count, -.accuracy_count, -.avg_tokens_per_sec]) |
    {
      ranked: .,
      primary: (if length > 0 then .[0].model else null end),
      primary_dir: (if length > 0 then .[0].model_dir else null end),
      primary_successes: (if length > 0 then .[0].tool_call_successes else "0/3" end),
      backup: (if length > 1 then .[1].model else null end),
      backup_dir: (if length > 1 then .[1].model_dir else null end),
      backup_successes: (if length > 1 then .[1].tool_call_successes else "0/3" end),
      all_passed: ([.[] | .success_count] | min >= 3),
      blocker: ([.[] | .success_count] | max < 3)
    }
  ')

  local primary primary_score backup blocker
  primary=$(echo "$selection" | jq -r '.primary // "none"')
  primary_score=$(echo "$selection" | jq -r '.primary_successes // "0/3"')
  backup=$(echo "$selection" | jq -r '.backup // "none"')
  blocker=$(echo "$selection" | jq -r '.blocker')

  log "  Primary model: $primary ($primary_score tool-call successes)"
  log "  Backup model: $backup"

  if [[ "$blocker" == "true" ]]; then
    log "  !! BLOCKER: No model achieved 3/3 tool-call successes"
  fi

  # Build rationale
  local rationale
  rationale="Primary selected based on highest tool-call success rate"
  if [[ "$blocker" == "true" ]]; then
    rationale="$rationale. BLOCKER: No model achieved perfect tool-call success — manual evaluation required."
  fi

  echo "$selection" | jq --arg rationale "$rationale" '. + {rationale: $rationale}'
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --models-dir)
      MODELS_DIR="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# Check dependencies
require_cmd jq
require_cmd curl
require_cmd python3

log "=== MLX Model Benchmark Suite ==="
log "Models directory: $MODELS_DIR"
log "Results file: $RESULTS_FILE"
log "Server endpoint: $BASE_URL"
log ""

# Verify at least one model exists
ANY_MODEL=false
for name in "${MODEL_NAMES[@]}"; do
  if [[ -d "$MODELS_DIR/$name" ]] && [[ -n "$(ls -A "$MODELS_DIR/$name" 2>/dev/null)" ]]; then
    ANY_MODEL=true
  fi
done

if [[ "$ANY_MODEL" == false ]]; then
  err "No models found in $MODELS_DIR"
  err "Run setup-mlx.sh first to download models"
  exit 1
fi

# Run benchmarks
ALL_RESULTS='{"models":[]}'
BENCHMARK_START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

for idx in "${!MODEL_NAMES[@]}"; do
  name="${MODEL_NAMES[$idx]}"
  label="${MODEL_LABELS[$idx]}"

  log ""
  model_result=$(benchmark_model "$name" "$label")

  ALL_RESULTS=$(echo "$ALL_RESULTS" | jq --argjson r "$model_result" '.models += [$r]')
done

# Model selection
log ""
SELECTION=$(select_models "$ALL_RESULTS")

# Compose final output
BENCHMARK_END=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

FINAL_OUTPUT=$(echo "$ALL_RESULTS" | jq \
  --arg start "$BENCHMARK_START" \
  --arg end "$BENCHMARK_END" \
  --argjson selection "$SELECTION" \
  '. + {
    benchmark_start: $start,
    benchmark_end: $end,
    selection: $selection
  }')

# Write results
mkdir -p "$(dirname "$RESULTS_FILE")"
echo "$FINAL_OUTPUT" | jq . > "$RESULTS_FILE"

log ""
log "=== Benchmark Complete ==="
log "Results written to: $RESULTS_FILE"

# Print summary
echo ""
echo "=== SUMMARY ==="
echo "$FINAL_OUTPUT" | jq '{
  primary_model: .selection.primary,
  primary_successes: .selection.primary_successes,
  backup_model: .selection.backup,
  backup_successes: .selection.backup_successes,
  blocker: .selection.blocker,
  models: [.models[] | {model: .model, successes: .tool_call_successes, accuracies: .tool_call_accuracies, avg_tps: .avg_tokens_per_sec, peak_mem_mb: .peak_memory_mb}]
}'

if echo "$FINAL_OUTPUT" | jq -e '.selection.blocker == true' >/dev/null 2>&1; then
  log ""
  log "!! BLOCKER FLAG: No model achieved 3/3 tool-call successes."
  log "!! Manual evaluation required before proceeding to Story 1.2."
  exit 2
fi

exit 0
