import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PATHS } from "../config.js";
import {
  saveSession,
  getSession,
  removeSession,
  completeSession,
  listPausedSessions,
  type SessionEntry,
  type SessionRegistry,
} from "../lib/session.js";

/** Each test gets its own temp directory. We swap PATHS.SESSION_REGISTRY. */
let tempDir: string;
let originalRegistry: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-session-test-"));
  originalRegistry = PATHS.SESSION_REGISTRY;
  (PATHS as Record<string, string>).SESSION_REGISTRY = path.join(tempDir, "sessions.json");
});

afterEach(() => {
  (PATHS as Record<string, string>).SESSION_REGISTRY = originalRegistry;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("saveSession", () => {
  it("creates the registry file on first save", async () => {
    assert.ok(!fs.existsSync(PATHS.SESSION_REGISTRY), "Registry should not exist yet");

    await saveSession("cv-2026-02-12-001", "claude-sdk-session-abc123", "fix_approved_findings");

    assert.ok(fs.existsSync(PATHS.SESSION_REGISTRY), "Registry file should be created");
  });

  it("saves session with correct schema matching Architecture Section 4.3", async () => {
    await saveSession("cv-2026-02-12-001", "claude-sdk-session-abc123", "fix_approved_findings");

    const raw = JSON.parse(fs.readFileSync(PATHS.SESSION_REGISTRY, "utf-8")) as SessionRegistry;

    // Top-level should have "sessions" key
    assert.ok("sessions" in raw, "Registry must have 'sessions' key");
    assert.ok(typeof raw.sessions === "object" && raw.sessions !== null);

    // Session entry should match the Architecture Section 4.3 schema
    const entry = raw.sessions["cv-2026-02-12-001"];
    assert.ok(entry, "Entry should exist for workflow ID");
    assert.equal(entry.session_id, "claude-sdk-session-abc123");
    assert.equal(entry.status, "paused");
    assert.ok(entry.paused_at, "paused_at should be set");
    assert.equal(entry.resume_step, "fix_approved_findings");

    // Validate paused_at is an ISO timestamp
    const parsed = new Date(entry.paused_at as string);
    assert.ok(!isNaN(parsed.getTime()), "paused_at should be valid ISO date");
  });

  it("saves multiple sessions to the same registry", async () => {
    await saveSession("cv-2026-02-12-001", "session-aaa", "step_a");
    await saveSession("tv-2026-02-12-001", "session-bbb", "step_b");

    const raw = JSON.parse(fs.readFileSync(PATHS.SESSION_REGISTRY, "utf-8")) as SessionRegistry;
    assert.equal(Object.keys(raw.sessions).length, 2);
    assert.ok(raw.sessions["cv-2026-02-12-001"]);
    assert.ok(raw.sessions["tv-2026-02-12-001"]);
  });

  it("creates parent directories if they do not exist", async () => {
    const nested = path.join(tempDir, "deep", "nested", "sessions.json");
    (PATHS as Record<string, string>).SESSION_REGISTRY = nested;

    await saveSession("cv-2026-02-12-001", "session-123", "verify");

    assert.ok(fs.existsSync(nested), "Registry file should be created in nested path");
  });
});

describe("getSession", () => {
  it("returns correct session data for saved session", async () => {
    await saveSession("cv-2026-02-12-001", "session-abc", "fix_step");

    const entry = await getSession("cv-2026-02-12-001");
    assert.ok(entry);
    assert.equal(entry.session_id, "session-abc");
    assert.equal(entry.status, "paused");
    assert.equal(entry.resume_step, "fix_step");
  });

  it("returns null for nonexistent session", async () => {
    const entry = await getSession("does-not-exist");
    assert.equal(entry, null);
  });

  it("returns null when registry file does not exist", async () => {
    // SESSION_REGISTRY points to temp dir but file doesn't exist
    const entry = await getSession("cv-2026-02-12-001");
    assert.equal(entry, null);
  });
});

describe("removeSession", () => {
  it("removes a session from the registry", async () => {
    await saveSession("cv-2026-02-12-001", "session-abc", "fix_step");
    await saveSession("tv-2026-02-12-001", "session-def", "verify_step");

    await removeSession("cv-2026-02-12-001");

    const removed = await getSession("cv-2026-02-12-001");
    assert.equal(removed, null, "Removed session should be null");

    const remaining = await getSession("tv-2026-02-12-001");
    assert.ok(remaining, "Other session should still exist");
  });

  it("does not throw when removing nonexistent session", async () => {
    // No sessions saved yet, removing should not throw
    await assert.doesNotReject(() => removeSession("nonexistent"));
  });
});

describe("completeSession", () => {
  it("changes session status to completed", async () => {
    await saveSession("cv-2026-02-12-001", "session-abc", "fix_step");

    await completeSession("cv-2026-02-12-001");

    const entry = await getSession("cv-2026-02-12-001");
    assert.ok(entry);
    assert.equal(entry.status, "completed");
  });

  it("does not throw when completing nonexistent session", async () => {
    // No sessions — completeSession checks for entry existence, does nothing if missing
    await assert.doesNotReject(() => completeSession("nonexistent"));
  });

  it("preserves other session fields after completion", async () => {
    await saveSession("cv-2026-02-12-001", "session-abc", "fix_step");

    await completeSession("cv-2026-02-12-001");

    const entry = await getSession("cv-2026-02-12-001");
    assert.ok(entry);
    assert.equal(entry.session_id, "session-abc");
    assert.equal(entry.resume_step, "fix_step");
    assert.ok(entry.paused_at);
  });
});

describe("listPausedSessions", () => {
  it("returns only paused sessions", async () => {
    await saveSession("cv-001", "session-1", "step_1");
    await saveSession("cv-002", "session-2", "step_2");
    await saveSession("cv-003", "session-3", "step_3");

    // Complete one, leave two paused
    await completeSession("cv-002");

    const paused = await listPausedSessions();
    const keys = Object.keys(paused);

    assert.equal(keys.length, 2);
    assert.ok(paused["cv-001"]);
    assert.ok(paused["cv-003"]);
    assert.ok(!paused["cv-002"], "Completed session should not appear in paused list");
  });

  it("returns empty object when no sessions exist", async () => {
    const paused = await listPausedSessions();
    assert.deepEqual(paused, {});
  });

  it("returns empty object when all sessions are completed", async () => {
    await saveSession("cv-001", "session-1", "step_1");
    await completeSession("cv-001");

    const paused = await listPausedSessions();
    assert.deepEqual(paused, {});
  });
});

describe("registry schema validation (Architecture Section 4.3)", () => {
  it("matches the exact schema from Architecture docs", async () => {
    await saveSession("cv-2026-02-12-001", "claude-sdk-session-abc123", "fix_approved_findings");

    const raw = JSON.parse(fs.readFileSync(PATHS.SESSION_REGISTRY, "utf-8"));

    // Top-level: must be an object with a "sessions" key
    assert.equal(typeof raw, "object");
    assert.ok(!Array.isArray(raw));
    const topKeys = Object.keys(raw);
    assert.deepEqual(topKeys, ["sessions"]);

    // Session entry: must have exactly session_id, status, paused_at, resume_step
    const entry = raw.sessions["cv-2026-02-12-001"];
    const entryKeys = Object.keys(entry).sort();
    assert.deepEqual(entryKeys, ["paused_at", "resume_step", "session_id", "status"]);

    // Value types
    assert.equal(typeof entry.session_id, "string");
    assert.equal(typeof entry.status, "string");
    assert.equal(typeof entry.paused_at, "string");
    assert.equal(typeof entry.resume_step, "string");
  });
});

describe("saveRegistry hardening", () => {
  it("does not leave temp files after successful save", async () => {
    await saveSession("cv-001", "session-1", "step_1");

    const tempPath = `${PATHS.SESSION_REGISTRY}.tmp`;
    assert.ok(!fs.existsSync(tempPath), "Temp file should not remain after successful save");
  });
});
