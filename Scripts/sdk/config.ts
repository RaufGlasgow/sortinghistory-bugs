/** Model IDs for SDK subagents — from Architecture Section 5.1 */
export const MODELS = {
  /** Sonnet 4.5 — orchestration, coordination, fix generation */
  ORCHESTRATOR: "claude-sonnet-4-5-20250929",
  /** Haiku 4.5 — read-only verification, pattern matching, triage */
  VERIFIER: "claude-haiku-4-5-20251001",
  /** Sonnet 4.5 — content/translation fixes (needs write capability) */
  FIXER: "claude-sonnet-4-5-20250929",
} as const;

/** Workflow types handled by the orchestrator */
export type WorkflowType =
  | "content_verification"
  | "translation_verification"
  | "bug_triage"
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
  /** Routing decision log directory (BA-011 NFR4: public repo, JSONL format) */
  ROUTING_LOG_DIR: process.env.SDK_ROUTING_LOG_DIR ?? "state/routing-log",
  /** Pipeline error log directory (JSONL format, cross-run tracking) */
  LOG_DIR: process.env.SDK_LOG_DIR ?? "state/logs",
};

/** Workflow limits from Architecture Section 4.1 */
export const LIMITS = {
  MAX_FIX_ATTEMPTS: 3,
  SESSION_TIMEOUT_MINUTES: 30,
  /** Maximum API cost in USD for a single bug fix pipeline run.
   *  Abort + notify if cumulative cost exceeds this. ($30/month budget) */
  MAX_PER_BUG_COST_USD: 3,
} as const;

/** Read-only tools for verifier subagents */
export const VERIFIER_TOOLS = ["Read", "Glob", "Grep", "Bash"] as const;

/** Minimal tools for proof workflow — truly read-only, no Bash */
export const PROOF_TOOLS = ["Read", "Glob", "Grep"] as const;

/** No tools for triage subagent — classify from text + screenshots only (PV2-5.1) */
export const TRIAGE_TOOLS = [] as const;

/** Read-only tools for QA review subagent — no Write, Edit, or Bash (Story PV2-3.1) */
export const QA_TOOLS = ["Read", "Glob", "Grep"] as const;

/** Read-write tools for fixer subagents (restricted to Data/ directory via hooks) */
export const FIXER_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] as const;

/** Read-write tools for bug fix subagents (Swift + JSON via buildBugFixHooksConfig) */
export const BUG_FIX_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] as const;

/** Canonical classification list — single source of truth (BA-011 AC1).
 *  Adding a classification requires changes in exactly 4 files:
 *  config.ts, bug-triager.md, routing.ts, routing-fixtures.ts (NFR14). */
export const CLASSIFICATIONS = [
  "content_error",
  "content_category_error",
  "content_duplicate",
  "translation_error",
  "ui_bug",
  "gameplay_bug",
  "performance_issue",
  "crash_bug",
  "feature_request",
  "needs_human_review",
] as const;

/** Union type of all valid classifications */
export type Classification = (typeof CLASSIFICATIONS)[number];

/** Set for O(1) membership checks — derived from CLASSIFICATIONS (AC1) */
export const CLASSIFICATION_SET: ReadonlySet<string> = new Set(CLASSIFICATIONS);

/** Confidence threshold for routing gate (BA-011 FR6, FR25).
 *  Strictly less-than comparison: 0.70 passes, 0.69 is blocked.
 *  Change this single constant to adjust — no routing logic or prompt changes needed. */
export const CONFIDENCE_THRESHOLD = 0.7;

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
  /** BA-011: Labels for unknown/unrecognized classifications */
  LABEL_UNKNOWN_CLASSIFICATION: "unknown-classification",
  /** BA-011: Label for low-confidence classifications (below CONFIDENCE_THRESHOLD) */
  LABEL_LOW_CONFIDENCE: "low-confidence",
  /** BA-011 Story 2.1: New classification labels */
  LABEL_CONTENT_DUPLICATE: "content-duplicate",
  LABEL_PERFORMANCE_ISSUE: "performance-issue",
  LABEL_CRASH_BUG: "crash-bug",
  LABEL_NEEDS_DEV_HANDOFF: "needs-dev-handoff",
} as const;
