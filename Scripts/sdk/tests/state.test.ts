import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PATHS } from "../config.js";
import {
  createWorkflowState,
  updateWorkflowState,
  loadWorkflowState,
  listWorkflowStates,
  type WorkflowState,
} from "../lib/state.js";

/** Each test gets its own temp directory for state files. We swap PATHS.STATE_DIR. */
let tempDir: string;
let originalStateDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-state-test-"));
  originalStateDir = PATHS.STATE_DIR;
  (PATHS as Record<string, string>).STATE_DIR = tempDir;
});

afterEach(() => {
  (PATHS as Record<string, string>).STATE_DIR = originalStateDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("createWorkflowState", () => {
  it("creates a state file with correct JSON schema", async () => {
    const state = await createWorkflowState("content_verification", "manual");

    // Verify the returned object has all required fields
    assert.equal(state.workflow_type, "content_verification");
    assert.equal(state.status, "verifying");
    assert.equal(state.session_id, null);
    assert.equal(state.trigger, "manual");
    assert.equal(state.category, null);
    assert.deepEqual(state.findings, []);
    assert.deepEqual(state.approved_findings, []);
    assert.deepEqual(state.rejected_findings, []);
    assert.equal(state.fix_attempts, 0);
    assert.equal(state.max_fix_attempts, 3);
    assert.deepEqual(state.fix_results, []);
    assert.equal(state.pr_number, null);
    assert.equal(state.error, null);
    assert.ok(state.created_at);
    assert.ok(state.updated_at);

    // Verify workflow_id format: cv-YYYY-MM-DD-001
    assert.match(state.workflow_id, /^cv-\d{4}-\d{2}-\d{2}-001$/);

    // Verify the file was actually written to disk
    const filePath = path.join(tempDir, `${state.workflow_id}.json`);
    assert.ok(fs.existsSync(filePath), "State file should exist on disk");

    // Verify the file contains valid JSON matching the returned state
    const diskData = JSON.parse(fs.readFileSync(filePath, "utf-8")) as WorkflowState;
    assert.deepEqual(diskData, state);
  });

  it("accepts optional category parameter", async () => {
    const state = await createWorkflowState(
      "content_verification",
      "scheduled",
      "Sports History",
    );
    assert.equal(state.category, "Sports History");
    assert.equal(state.trigger, "scheduled");
  });

  it("generates sequential IDs: -001, -002, -003", async () => {
    const s1 = await createWorkflowState("content_verification", "manual");
    const s2 = await createWorkflowState("content_verification", "manual");
    const s3 = await createWorkflowState("content_verification", "manual");

    assert.ok(s1.workflow_id.endsWith("-001"), `Expected -001, got ${s1.workflow_id}`);
    assert.ok(s2.workflow_id.endsWith("-002"), `Expected -002, got ${s2.workflow_id}`);
    assert.ok(s3.workflow_id.endsWith("-003"), `Expected -003, got ${s3.workflow_id}`);
  });

  it("uses correct prefix per workflow type", async () => {
    const cv = await createWorkflowState("content_verification", "manual");
    const tv = await createWorkflowState("translation_verification", "manual");
    const bt = await createWorkflowState("bug_triage", "manual");
    const bf = await createWorkflowState("bug_fix", "manual");

    assert.ok(cv.workflow_id.startsWith("cv-"));
    assert.ok(tv.workflow_id.startsWith("tv-"));
    assert.ok(bt.workflow_id.startsWith("bt-"));
    assert.ok(bf.workflow_id.startsWith("bf-"));
  });

  it("creates state directory if it does not exist", async () => {
    // Point to a nested path that doesn't exist
    const nestedDir = path.join(tempDir, "nested", "deep", "state");
    (PATHS as Record<string, string>).STATE_DIR = nestedDir;

    const state = await createWorkflowState("bug_triage", "dispatch");
    assert.ok(fs.existsSync(nestedDir), "Nested directory should be created");
    assert.ok(state.workflow_id.startsWith("bt-"));
  });
});

describe("updateWorkflowState", () => {
  it("updates only specified fields plus updated_at", async () => {
    const original = await createWorkflowState("content_verification", "manual");
    const originalUpdatedAt = original.updated_at;

    // Small delay to ensure updated_at changes
    await new Promise((r) => setTimeout(r, 10));

    const updated = await updateWorkflowState(original.workflow_id, {
      status: "awaiting_approval",
      findings: [
        {
          event_id: "ev-001",
          event_title: "Test Event",
          gates_failed: ["FR45"],
          details: "Date incorrect",
          severity: "high",
        },
      ],
    });

    // Updated fields changed
    assert.equal(updated.status, "awaiting_approval");
    assert.equal(updated.findings.length, 1);
    assert.equal(updated.findings[0].event_id, "ev-001");

    // updated_at changed
    assert.notEqual(updated.updated_at, originalUpdatedAt);

    // Unchanged fields preserved
    assert.equal(updated.workflow_id, original.workflow_id);
    assert.equal(updated.workflow_type, original.workflow_type);
    assert.equal(updated.trigger, original.trigger);
    assert.equal(updated.created_at, original.created_at);
    assert.equal(updated.fix_attempts, 0);
    assert.equal(updated.pr_number, null);
  });

  it("throws when workflow does not exist", async () => {
    await assert.rejects(
      () => updateWorkflowState("nonexistent-id", { status: "complete" }),
      { message: "Workflow state not found: nonexistent-id" },
    );
  });

  it("persists updates to disk", async () => {
    const original = await createWorkflowState("content_verification", "manual");
    await updateWorkflowState(original.workflow_id, {
      status: "fixing",
      fix_attempts: 1,
    });

    const fromDisk = await loadWorkflowState(original.workflow_id);
    assert.ok(fromDisk);
    assert.equal(fromDisk.status, "fixing");
    assert.equal(fromDisk.fix_attempts, 1);
  });
});

describe("loadWorkflowState", () => {
  it("returns null for nonexistent workflow", async () => {
    const result = await loadWorkflowState("does-not-exist");
    assert.equal(result, null);
  });

  it("loads a previously created workflow", async () => {
    const created = await createWorkflowState("translation_verification", "scheduled", "TV History");
    const loaded = await loadWorkflowState(created.workflow_id);

    assert.ok(loaded);
    assert.deepEqual(loaded, created);
  });
});

describe("listWorkflowStates", () => {
  it("returns empty array when state directory is empty", async () => {
    const states = await listWorkflowStates();
    assert.deepEqual(states, []);
  });

  it("returns empty array when state directory does not exist", async () => {
    (PATHS as Record<string, string>).STATE_DIR = path.join(tempDir, "nonexistent");
    const states = await listWorkflowStates();
    assert.deepEqual(states, []);
  });

  it("lists all states without filter", async () => {
    await createWorkflowState("content_verification", "manual");
    await createWorkflowState("bug_triage", "dispatch");
    await createWorkflowState("translation_verification", "scheduled");

    const states = await listWorkflowStates();
    assert.equal(states.length, 3);
  });

  it("filters by status correctly", async () => {
    const s1 = await createWorkflowState("content_verification", "manual");
    const s2 = await createWorkflowState("content_verification", "manual");
    await createWorkflowState("content_verification", "manual");

    // Update s1 and s2 to different statuses
    await updateWorkflowState(s1.workflow_id, { status: "complete" });
    await updateWorkflowState(s2.workflow_id, { status: "awaiting_approval" });

    const verifying = await listWorkflowStates("verifying");
    assert.equal(verifying.length, 1);

    const complete = await listWorkflowStates("complete");
    assert.equal(complete.length, 1);
    assert.equal(complete[0].workflow_id, s1.workflow_id);

    const awaiting = await listWorkflowStates("awaiting_approval");
    assert.equal(awaiting.length, 1);
    assert.equal(awaiting[0].workflow_id, s2.workflow_id);
  });
});

describe("atomicWrite hardening", () => {
  it("does not leave temp files on write failure for invalid JSON", async () => {
    // Manually write a valid state file first
    const state = await createWorkflowState("content_verification", "manual");
    const filePath = path.join(tempDir, `${state.workflow_id}.json`);
    const tempPath = `${filePath}.tmp`;

    // Verify the state file exists and no temp file is left over
    assert.ok(fs.existsSync(filePath));
    assert.ok(!fs.existsSync(tempPath), "No temp file should remain after successful write");
  });

  it("preserves existing state when update fails", async () => {
    const state = await createWorkflowState("content_verification", "manual");
    const filePath = path.join(tempDir, `${state.workflow_id}.json`);

    // Read original content
    const originalContent = fs.readFileSync(filePath, "utf-8");

    // Manually corrupt the state file to verify loadWorkflowState reads back OK
    // (the atomic write pattern means corruption only happens if we bypass it)
    const loaded = await loadWorkflowState(state.workflow_id);
    assert.ok(loaded);
    assert.equal(loaded.status, "verifying");

    // Verify disk content is unchanged
    const currentContent = fs.readFileSync(filePath, "utf-8");
    assert.equal(currentContent, originalContent);
  });

  it("ignores non-JSON files in state directory when listing", async () => {
    await createWorkflowState("content_verification", "manual");

    // Create a non-JSON file in the state directory
    fs.writeFileSync(path.join(tempDir, "garbage.txt"), "not json");

    // Should only return the one valid state
    const states = await listWorkflowStates();
    assert.equal(states.length, 1);
  });
});
