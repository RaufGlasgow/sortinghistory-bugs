#!/usr/bin/env python3
"""
prepare-training-data.py — Convert raw training JSONL into MLX chat-format splits.

Reads all .jsonl files from state/training/raw/, groups entries by workflow_id,
applies quality filters, converts to MLX chat format, and splits 80/20 into
state/training/prepared/train.jsonl and val.jsonl.

Quality filter cascade:
  1. Only workflows with human_verdict="approved" or outcome="qa_passed"
  2. Fallback: also include outcome="compile_passed" (if <3 examples)
  3. Fallback: include ALL workflows (if still <3 examples)

Usage:
  python3 Scripts/sdk/scripts/prepare-training-data.py
  python3 Scripts/sdk/scripts/prepare-training-data.py --help
"""

import glob
import json
import os
import random
import sys
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SDK_DIR = os.path.dirname(SCRIPT_DIR)
RAW_DIR = os.path.join(SDK_DIR, "state", "training", "raw")
PREPARED_DIR = os.path.join(SDK_DIR, "state", "training", "prepared")

MIN_EXAMPLES = 3
TRAIN_RATIO = 0.80


def timestamp():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(msg):
    print(f"[{timestamp()}] {msg}")


def err(msg):
    print(f"[{timestamp()}] ERROR: {msg}", file=sys.stderr)


def show_help():
    print(__doc__.strip())
    sys.exit(0)


def load_all_entries():
    """Load all entries from every .jsonl file in the raw directory."""
    entries = []
    pattern = os.path.join(RAW_DIR, "*.jsonl")
    files = sorted(glob.glob(pattern))

    if not files:
        err(f"No .jsonl files found in {RAW_DIR}")
        sys.exit(1)

    for filepath in files:
        log(f"Reading {os.path.basename(filepath)}")
        with open(filepath, "r", encoding="utf-8") as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                    entries.append(entry)
                except json.JSONDecodeError as e:
                    log(f"  Skipping malformed line {line_num}: {e}")

    log(f"Loaded {len(entries)} entries from {len(files)} file(s)")
    return entries


def group_by_workflow(entries):
    """Group entries by workflow_id, separating turns, summaries, and verdicts."""
    workflows = {}

    for entry in entries:
        wf_id = entry.get("workflow_id")
        if not wf_id:
            continue

        if wf_id not in workflows:
            workflows[wf_id] = {"turns": [], "summary": None, "verdicts": []}

        entry_id = entry.get("id", "")

        if entry.get("type") == "verdict_update":
            workflows[wf_id]["verdicts"].append(entry)
        elif entry_id.endswith("-summary"):
            workflows[wf_id]["summary"] = entry
        else:
            workflows[wf_id]["turns"].append(entry)

    log(f"Found {len(workflows)} workflow(s)")

    # Story 1.6: Deduplicate verdicts — when multiple verdicts exist for the
    # same workflow_id (e.g. due to retries), keep only the latest by timestamp.
    dedup_count = 0
    for wf_id, wf_data in workflows.items():
        verdicts = wf_data["verdicts"]
        if len(verdicts) > 1:
            dedup_count += len(verdicts) - 1
            # Sort by timestamp descending, keep only the latest
            verdicts.sort(
                key=lambda v: v.get("timestamp", ""),
                reverse=True,
            )
            wf_data["verdicts"] = [verdicts[0]]
    if dedup_count > 0:
        log(f"Deduplicated {dedup_count} duplicate verdict(s)")

    return workflows


def get_workflow_quality(workflow_data):
    """Determine the quality level of a workflow.

    Returns:
        "approved"       — has human_verdict approved or outcome qa_passed
        "compile_passed" — has outcome compile_passed
        "other"          — everything else
    """
    summary = workflow_data["summary"]
    verdicts = workflow_data["verdicts"]

    # Check verdict entries for human_verdict approved
    for v in verdicts:
        if v.get("human_verdict") == "approved":
            return "approved"

    # Check summary for human_verdict or outcome
    if summary:
        if summary.get("human_verdict") == "approved":
            return "approved"
        if summary.get("outcome") == "qa_passed":
            return "approved"
        if summary.get("outcome") == "compile_passed":
            return "compile_passed"

    return "other"


def filter_workflows(workflows):
    """Apply quality filter cascade, returning qualifying workflow IDs and filter level used."""
    quality_map = {}
    for wf_id, wf_data in workflows.items():
        quality_map[wf_id] = get_workflow_quality(wf_data)

    # Level 1: approved / qa_passed only
    level1 = [wf_id for wf_id, q in quality_map.items() if q == "approved"]
    if len(level1) >= MIN_EXAMPLES:
        log(f"Filter level 1 (approved/qa_passed): {len(level1)} workflow(s)")
        return level1, "approved_only"

    # Level 2: also include compile_passed
    level2 = [wf_id for wf_id, q in quality_map.items() if q in ("approved", "compile_passed")]
    if len(level2) >= MIN_EXAMPLES:
        log(f"WARNING: Only {len(level1)} approved workflow(s), falling back to include compile_passed")
        log(f"Filter level 2 (approved + compile_passed): {len(level2)} workflow(s)")
        return level2, "include_compile_passed"

    # Level 3: include everything
    level3 = list(workflows.keys())
    print()
    log("=" * 60)
    log("WARNING: INSUFFICIENT QUALITY DATA")
    log(f"  Approved workflows: {len(level1)}")
    log(f"  Compile-passed workflows: {len(level2)}")
    log(f"  Total workflows: {len(level3)}")
    log("  Including ALL workflows for training data.")
    log("  Fine-tuned model quality may be poor.")
    log("=" * 60)
    print()
    return level3, "all_data"


def turns_to_chat_messages(turns):
    """Convert a workflow's turn entries to MLX chat format messages list.

    Each turn has messages_in (the conversation so far) and response (the model's reply).
    We reconstruct the full conversation from the last turn's messages_in + response,
    since messages_in accumulates the conversation history.
    """
    if not turns:
        return None

    # Sort turns by turn_number, then attempt_number
    sorted_turns = sorted(turns, key=lambda t: (t.get("attempt_number", 0), t.get("turn_number", 0)))

    # Use the last turn — it has the most complete messages_in
    last_turn = sorted_turns[-1]

    messages = []

    # Add messages_in (the conversation context)
    for msg in last_turn.get("messages_in", []):
        role = msg.get("role", "user")
        content = msg.get("content")
        tool_calls = msg.get("tool_calls")

        entry = {"role": role, "content": content}
        if tool_calls:
            entry["tool_calls"] = tool_calls
        messages.append(entry)

    # Add the model's response
    response = last_turn.get("response", {})
    resp_entry = {"role": "assistant", "content": response.get("content")}
    if response.get("tool_calls"):
        resp_entry["tool_calls"] = response["tool_calls"]
    messages.append(resp_entry)

    # Add tool results if present
    for tool_result in last_turn.get("tool_results", []):
        messages.append({
            "role": "tool",
            "content": tool_result.get("result", ""),
            "tool_call_id": tool_result.get("name", "unknown"),
        })

    # Must have at least 2 messages (input + response) to be useful
    if len(messages) < 2:
        return None

    return messages


def build_training_examples(workflows, qualifying_ids):
    """Build MLX chat-format training examples from qualifying workflows."""
    examples = []

    for wf_id in qualifying_ids:
        wf_data = workflows[wf_id]
        turns = wf_data["turns"]

        if not turns:
            log(f"  Skipping {wf_id}: no turn entries")
            continue

        messages = turns_to_chat_messages(turns)
        if messages is None:
            log(f"  Skipping {wf_id}: no meaningful content in turns")
            continue

        examples.append({"messages": messages})

    return examples


def split_and_write(examples):
    """Split examples 80/20 and write to train.jsonl and val.jsonl."""
    os.makedirs(PREPARED_DIR, exist_ok=True)

    # Shuffle for randomness
    random.seed(42)
    shuffled = list(examples)
    random.shuffle(shuffled)

    split_idx = max(1, int(len(shuffled) * TRAIN_RATIO))

    # Ensure at least 1 validation example if we have >= 2 total
    if len(shuffled) >= 2 and split_idx == len(shuffled):
        split_idx = len(shuffled) - 1

    train = shuffled[:split_idx]
    val = shuffled[split_idx:]

    train_path = os.path.join(PREPARED_DIR, "train.jsonl")
    val_path = os.path.join(PREPARED_DIR, "val.jsonl")

    with open(train_path, "w", encoding="utf-8") as f:
        for ex in train:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    with open(val_path, "w", encoding="utf-8") as f:
        for ex in val:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    log(f"Wrote {len(train)} training example(s) to {train_path}")
    log(f"Wrote {len(val)} validation example(s) to {val_path}")

    return len(train), len(val)


def main():
    if "--help" in sys.argv or "-h" in sys.argv:
        show_help()

    log("=== prepare-training-data.py ===")
    log(f"Raw directory: {RAW_DIR}")
    log(f"Output directory: {PREPARED_DIR}")
    print()

    # Step 1: Load all entries
    entries = load_all_entries()

    # Step 2: Group by workflow
    workflows = group_by_workflow(entries)

    if not workflows:
        err("No workflows found in training data")
        sys.exit(1)

    # Step 3: Apply quality filter
    qualifying_ids, filter_level = filter_workflows(workflows)

    if not qualifying_ids:
        err("No qualifying workflows after filtering")
        sys.exit(1)

    log(f"Filter level used: {filter_level}")
    print()

    # Step 4: Build training examples
    examples = build_training_examples(workflows, qualifying_ids)

    if not examples:
        err("No training examples could be built from qualifying workflows")
        sys.exit(1)

    # Step 5: Split and write
    n_train, n_val = split_and_write(examples)

    print()
    log(f"Prepared {n_train} training examples, {n_val} validation examples from {len(qualifying_ids)} workflows")
    log("Done.")


if __name__ == "__main__":
    main()
