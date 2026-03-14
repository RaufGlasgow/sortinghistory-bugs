#!/usr/bin/env python3
"""
Story 1.4: Backfill training data from existing workflow state files.

Reads all JSON files from state/workflows/, parses attempt_log arrays,
and writes training summary entries to state/training/raw/backfill-YYYY-MM-DD.jsonl.

Uses only Python stdlib (json, os, glob, sys, datetime).
"""

import json
import os
import glob
import sys
from datetime import datetime, timezone


# Default model when state file doesn't specify one
DEFAULT_MODEL = "claude-sonnet-4-5-20250929"

# Map attempt_log result strings to training outcome enum
RESULT_TO_OUTCOME = {
    "success": "compile_passed",
    "compilation_error": "compile_failed",
    "qa_rejected": "qa_rejected",
    "qa_needs_revision": "qa_rejected",
    "quality_gate_fail": "compile_failed",
    "timeout": "timeout",
    "error": "error",
}


def find_matching_usage(models_used, attempt_number):
    """Find the ModelUsageEntry matching this attempt number."""
    step_pattern = f"fix_attempt_{attempt_number}"
    for entry in models_used:
        if entry.get("step") == step_pattern:
            return entry
    return None


def map_outcome(result_str):
    """Map an attempt result string to a TrainingOutcome."""
    return RESULT_TO_OUTCOME.get(result_str, "error")


def determine_workflow_outcome(state):
    """Determine the overall workflow outcome from state."""
    status = state.get("status", "")
    if status == "complete":
        return "qa_passed"

    attempt_log = state.get("attempt_log", [])
    if not attempt_log:
        return "error"

    last_result = attempt_log[-1].get("result", "error")
    return map_outcome(last_result)


def backfill_state_file(filepath, entries):
    """Parse a single state file and append training entries."""
    with open(filepath, "r", encoding="utf-8") as f:
        state = json.load(f)

    workflow_id = state.get("workflow_id", os.path.basename(filepath).replace(".json", ""))
    workflow_type = state.get("workflow_type", "bug_fix")
    attempt_log = state.get("attempt_log", [])
    models_used = state.get("models_used", [])
    qa_results = state.get("qa_results", [])

    if not attempt_log:
        return 0

    count = 0

    # Create a turn entry for each attempt
    for attempt in attempt_log:
        attempt_number = attempt.get("attempt_number", 0)
        model = attempt.get("model", DEFAULT_MODEL)
        result = attempt.get("result", "error")

        # Find matching usage entry
        usage = find_matching_usage(models_used, attempt_number)
        tokens_in = usage.get("input_tokens", 0) if usage else 0
        tokens_out = usage.get("output_tokens", 0) if usage else 0

        entry = {
            "id": f"backfill-{workflow_id}-attempt-{attempt_number}",
            "workflow_id": workflow_id,
            "workflow_type": workflow_type,
            "timestamp": attempt.get("timestamp", datetime.now(timezone.utc).isoformat()),
            "backend": "claude",  # Historical data is all Claude API
            "model": model if model != "n/a" else DEFAULT_MODEL,
            "attempt_number": attempt_number,
            "turn_number": 0,
            "messages_in": [{"role": "user", "content": None}],
            "tools_available": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
            "response": {"content": None, "tool_calls": None},
            "tool_results": [],
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "duration_ms": 0,
            "outcome": map_outcome(result),
        }
        entries.append(entry)
        count += 1

    # Create a summary entry for the workflow
    total_tokens_in = sum(m.get("input_tokens", 0) for m in models_used)
    total_tokens_out = sum(m.get("output_tokens", 0) for m in models_used)

    # Determine QA verdict from qa_results
    qa_verdict = None
    if qa_results:
        last_qa = qa_results[-1]
        qa_verdict = last_qa.get("verdict", None)

    summary = {
        "id": f"backfill-{workflow_id}-summary",
        "workflow_id": workflow_id,
        "outcome": determine_workflow_outcome(state),
        "total_turns": len(attempt_log),
        "total_tokens_in": total_tokens_in,
        "total_tokens_out": total_tokens_out,
        "total_duration_ms": 0,
        "files_modified": [],
        "diff_size_bytes": 0,
        "compile_result": None,
        "qa_verdict": qa_verdict,
        "human_verdict": None,
    }
    entries.append(summary)
    count += 1

    return count


def main():
    # Determine paths relative to script location
    # State files live under Scripts/sdk/state/ (SDK working directory)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    sdk_root = os.path.dirname(script_dir)  # Scripts/sdk/

    workflows_dir = os.path.join(sdk_root, "state", "workflows")
    training_raw_dir = os.path.join(sdk_root, "state", "training", "raw")

    if not os.path.isdir(workflows_dir):
        print(f"Workflows directory not found: {workflows_dir}")
        sys.exit(1)

    # Ensure training directory exists
    os.makedirs(training_raw_dir, exist_ok=True)
    # Also create sibling dirs for future stories
    for sub in ["prepared", "adapters", "merged"]:
        os.makedirs(os.path.join(sdk_root, "state", "training", sub), exist_ok=True)

    # Find all state files
    state_files = sorted(glob.glob(os.path.join(workflows_dir, "*.json")))

    if not state_files:
        print("No state files found in " + workflows_dir)
        sys.exit(0)

    entries = []
    files_processed = 0

    for filepath in state_files:
        try:
            count = backfill_state_file(filepath, entries)
            if count > 0:
                files_processed += 1
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            print(f"WARNING: Skipping {os.path.basename(filepath)}: {e}")
            continue

    if not entries:
        print("No entries to backfill")
        sys.exit(0)

    # Write to backfill JSONL file
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    output_path = os.path.join(training_raw_dir, f"backfill-{today}.jsonl")

    with open(output_path, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry, separators=(",", ":")) + "\n")

    print(f"Backfilled {len(entries)} entries from {files_processed} state files")
    print(f"Output: {output_path}")


if __name__ == "__main__":
    main()
