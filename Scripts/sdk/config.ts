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
  | "bug_fix"
  | "triage"
  | "qa_review";

// ---------------------------------------------------------------------------
// Story 1.3: Workflow backend routing
// ---------------------------------------------------------------------------

/** Workflow type -> default backend (local inference vs Claude API) */
export const WORKFLOW_BACKENDS: Record<WorkflowType, "local" | "claude"> = {
  bug_fix: "local",
  bug_triage: "claude",
  triage: "claude",
  qa_review: "claude",
  content_verification: "claude",
  translation_verification: "claude",
};

// ---------------------------------------------------------------------------
// Story 1.3: Local model configuration
// ---------------------------------------------------------------------------

/** Local model definitions — model IDs are placeholders until Story 1.1 benchmark runs */
export const LOCAL_MODELS = {
  PRIMARY: {
    id: "qwen3-coder-30b-a3b-q4",
    backend: "local" as const,
    endpoint: process.env.LOCAL_MODEL_ENDPOINT || "http://localhost:8080/v1",
    context_window: 131072,
    cost_per_mtok_input: 0,
    cost_per_mtok_output: 0,
  },
  BACKUP: {
    id: "devstral-small-2-24b-q4",
    backend: "local" as const,
    endpoint: process.env.LOCAL_MODEL_ENDPOINT || "http://localhost:8080/v1",
    context_window: 131072,
    cost_per_mtok_input: 0,
    cost_per_mtok_output: 0,
  },
} as const;

/** Inference server connection settings */
export const INFERENCE_SERVER = {
  host: "localhost",
  port: 8080,
  startup_timeout_ms: 120000,
} as const;

/** Fallback chain for local inference: primary -> backup -> cloud (if allowed) */
export const LOCAL_FALLBACK_CHAIN = {
  primary: LOCAL_MODELS.PRIMARY.id,
  backup: LOCAL_MODELS.BACKUP.id,
  cloud_fallback: "claude-sonnet-4-5-20250929",
  allow_cloud_fallback: false, // Disabled by default
} as const;

/** Number of attempts for each fallback stage */
export const FALLBACK_ATTEMPTS = {
  backup: 1,
  cloud: 1,
} as const;

/** Workflow status transitions: verifying → awaiting_approval → fixing → re_verifying → complete | escalated | fix_failed | error
 *  Story 3.2: Added `fix_failed` (fix attempt failed, retryable) and `error` (unrecoverable, e.g. API exhaustion) */
export type WorkflowStatus =
  | "verifying"
  | "awaiting_approval"
  | "fixing"
  | "re_verifying"
  | "complete"
  | "escalated"
  | "fix_failed"
  | "error";

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
  "code_bug",
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
  DISPATCH_TRANSLATION_FIX: "sdk-translation-fix",
  DISPATCH_TRANSLATION_RESUME: "sdk-translation-resume",

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
  LABEL_CODE_BUG: "code-bug",
  LABEL_CRASH_BUG: "crash-bug",
  LABEL_NEEDS_DEV_HANDOFF: "needs-dev-handoff",
  /** Story 3.2: Label for failed fix attempts (retryable) */
  LABEL_FIX_FAILED: "fix-failed",
  /** Story 3.2: Label for in-progress workflows */
  LABEL_IN_PROGRESS: "in-progress",
} as const;

// ---------------------------------------------------------------------------
// Story 3.2: Model pricing and cost estimation (Architecture Section 7.1)
// ---------------------------------------------------------------------------

/** Per-model pricing in USD per million tokens (input, output) */
export const MODEL_PRICING: Record<string, { input_per_mtok: number; output_per_mtok: number }> = {
  // Haiku 4.5: $1/$5 per MTok
  "claude-haiku-4-5-20251001": { input_per_mtok: 1.0, output_per_mtok: 5.0 },
  // Sonnet 4.5: $3/$15 per MTok
  "claude-sonnet-4-5-20250929": { input_per_mtok: 3.0, output_per_mtok: 15.0 },
  // Opus 4.6: $5/$25 per MTok (complex bugs only)
  "claude-opus-4-6": { input_per_mtok: 5.0, output_per_mtok: 25.0 },
  // Local models: $0 (runs on-device)
  [LOCAL_MODELS.PRIMARY.id]: { input_per_mtok: 0, output_per_mtok: 0 },
  [LOCAL_MODELS.BACKUP.id]: { input_per_mtok: 0, output_per_mtok: 0 },
};

/**
 * Estimate cost in USD for a subagent call based on token usage.
 * Falls back to Sonnet pricing for unknown models (safe default).
 *
 * @param model - Model ID string
 * @param inputTokens - Number of input tokens consumed
 * @param outputTokens - Number of output tokens consumed
 * @returns Estimated cost in USD (rounded to 6 decimal places)
 */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING[MODELS.FIXER]; // fallback to Sonnet
  const inputCost = (inputTokens / 1_000_000) * pricing.input_per_mtok;
  const outputCost = (outputTokens / 1_000_000) * pricing.output_per_mtok;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}

/**
 * Truncate an error message to a maximum length.
 * Story 3.2 AC: error_output should be truncated to 500 characters max.
 */
export function truncateError(error: string, maxLength: number = 500): string {
  if (error.length <= maxLength) return error;
  return error.slice(0, maxLength - 3) + "...";
}
