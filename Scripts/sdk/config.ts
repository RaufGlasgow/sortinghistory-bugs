/** Model IDs for SDK subagents — from Architecture Section 5.1 */
export const MODELS = {
  /** Sonnet 4.5 — orchestration, coordination, fix generation */
  ORCHESTRATOR: "claude-sonnet-4-5-20250929",
  /** Haiku 4.5 — read-only verification, pattern matching, triage */
  VERIFIER: "claude-haiku-4-5-20251001",
  /** Sonnet 4.5 — content/translation fixes (needs write capability) */
  FIXER: "claude-sonnet-4-5-20250929",
  /** Opus 4.6 — complex bug diagnosis, deep reasoning */
  COMPLEX_BUG: "claude-opus-4-6",
} as const;

/** Workflow types handled by the orchestrator */
export type WorkflowType =
  | "content_verification"
  | "translation_verification"
  | "bug_triage"
  | "complex_bug"
  | "bug_fix";

/** Workflow status transitions: verifying → awaiting_approval → fixing → re_verifying → complete | escalated */
export type WorkflowStatus =
  | "verifying"
  | "awaiting_approval"
  | "fixing"
  | "re_verifying"
  | "complete"
  | "escalated";

/** File paths — relative to repo root (sortinghistory-bugs/).
 *  Override via environment variables for testing or CI where paths may differ. */
export const PATHS = {
  STATE_DIR: process.env.SDK_STATE_DIR ?? "state/workflows",
  DIGEST_DIR: process.env.SDK_DIGEST_DIR ?? "state/digests",
  SESSION_REGISTRY: process.env.SDK_SESSION_REGISTRY ?? "state/sessions.json",
  ARCHIVE_DIR: process.env.SDK_ARCHIVE_DIR ?? "state/archive",
  /** Private game repo checked out by Actions */
  GAME_REPO: process.env.SDK_GAME_REPO ?? "game-repo",
};

/** Workflow limits from Architecture Section 4.1 */
export const LIMITS = {
  MAX_FIX_ATTEMPTS: 3,
  SESSION_TIMEOUT_MINUTES: 30,
} as const;

/** Read-only tools for verifier subagents */
export const VERIFIER_TOOLS = ["Read", "Glob", "Grep", "Bash"] as const;

/** Minimal tools for proof workflow — truly read-only, no Bash */
export const PROOF_TOOLS = ["Read", "Glob", "Grep"] as const;

/** Read-only tools for triage subagent — no Bash needed */
export const TRIAGE_TOOLS = ["Read", "Glob", "Grep"] as const;

/** Read-write tools for fixer subagents (restricted to Data/ directory via hooks) */
export const FIXER_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] as const;

/** Read-write tools for bug fix subagents (Swift + JSON via buildBugFixHooksConfig) */
export const BUG_FIX_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] as const;

/** Routing constants — repos, labels, dispatch event types (Story 4.2) */
export const ROUTING = {
  /** GitHub repos */
  PRIVATE_REPO: "RaufGlasgow/Sorting-History",
  PUBLIC_REPO: "RaufGlasgow/sortinghistory-bugs",

  /** Dispatch event types */
  DISPATCH_CONTENT_VERIFY: "sdk-content-verify",
  DISPATCH_CONTENT_RESUME: "sdk-content-resume",
  DISPATCH_APPROVE: "approve",
  DISPATCH_SDK_BUG_FIX: "sdk-bug-fix",

  /** Labels applied by routing */
  LABEL_ROUTED: "sdk-routed",
  LABEL_CONTENT_ERROR: "content-error",
  LABEL_TRANSLATION_ERROR: "translation-error",
  LABEL_UI_BUG: "ui-bug",
  LABEL_GAMEPLAY_BUG: "gameplay-bug",
  LABEL_NEEDS_CLAUDE_CODE: "needs-claude-code",
  LABEL_FEATURE_REQUEST: "feature-request",
  LABEL_NEEDS_HUMAN_REVIEW: "needs-human-review",
  LABEL_NEEDS_TRIAGE: "needs-triage",
} as const;
