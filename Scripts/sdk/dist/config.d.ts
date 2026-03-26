/** Model IDs for SDK subagents — from Architecture Section 5.1 */
export declare const MODELS: {
    /** Sonnet 4.5 — orchestration, coordination, fix generation */
    readonly ORCHESTRATOR: "claude-sonnet-4-5-20250929";
    /** Haiku 4.5 — read-only verification, pattern matching, triage */
    readonly VERIFIER: "claude-haiku-4-5-20251001";
    /** Sonnet 4.5 — content/translation fixes (needs write capability) */
    readonly FIXER: "claude-sonnet-4-5-20250929";
};
/** Workflow types handled by the orchestrator */
export type WorkflowType = "content_verification" | "translation_verification" | "bug_triage" | "bug_fix" | "triage" | "qa_review";
/** Workflow type -> default backend (local inference vs Claude API) */
export declare const WORKFLOW_BACKENDS: Record<WorkflowType, "local" | "claude">;
/** Local model definitions — model IDs are placeholders until Story 1.1 benchmark runs */
export declare const LOCAL_MODELS: {
    readonly PRIMARY: {
        readonly id: "qwen3-coder-30b-a3b-q4";
        readonly backend: "local";
        readonly endpoint: string;
        readonly context_window: 131072;
        readonly cost_per_mtok_input: 0;
        readonly cost_per_mtok_output: 0;
    };
    readonly BACKUP: {
        readonly id: "devstral-small-2-24b-q4";
        readonly backend: "local";
        readonly endpoint: string;
        readonly context_window: 131072;
        readonly cost_per_mtok_input: 0;
        readonly cost_per_mtok_output: 0;
    };
};
/** Inference server connection settings */
export declare const INFERENCE_SERVER: {
    readonly host: "localhost";
    readonly port: 8080;
    readonly startup_timeout_ms: 120000;
};
/** Fallback chain for local inference: primary -> backup -> cloud (if allowed) */
export declare const LOCAL_FALLBACK_CHAIN: {
    readonly primary: "qwen3-coder-30b-a3b-q4";
    readonly backup: "devstral-small-2-24b-q4";
    readonly cloud_fallback: "claude-sonnet-4-5-20250929";
    readonly allow_cloud_fallback: false;
};
/** Number of attempts for each fallback stage */
export declare const FALLBACK_ATTEMPTS: {
    readonly backup: 1;
    readonly cloud: 1;
};
/** Workflow status transitions: verifying → awaiting_approval → fixing → re_verifying → complete | escalated | fix_failed | error
 *  Story 3.2: Added `fix_failed` (fix attempt failed, retryable) and `error` (unrecoverable, e.g. API exhaustion) */
export type WorkflowStatus = "verifying" | "awaiting_approval" | "fixing" | "re_verifying" | "complete" | "escalated" | "fix_failed" | "error";
/** File paths — relative to repo root (sortinghistory-bugs/).
 *  Override via environment variables for testing or CI where paths may differ. */
export declare const PATHS: {
    STATE_DIR: string;
    DIGEST_DIR: string;
    SESSION_REGISTRY: string;
    ARCHIVE_DIR: string;
    /** Private game repo checked out by Actions */
    GAME_REPO: string;
    /** Routing decision log directory (BA-011 NFR4: public repo, JSONL format) */
    ROUTING_LOG_DIR: string;
    /** Pipeline error log directory (JSONL format, cross-run tracking) */
    LOG_DIR: string;
    /** Training data directory (Story 1.4: raw JSONL, prepared splits, adapters, merged) */
    TRAINING_DATA_DIR: string;
};
/** Workflow limits from Architecture Section 4.1 */
export declare const LIMITS: {
    readonly MAX_FIX_ATTEMPTS: 3;
    readonly SESSION_TIMEOUT_MINUTES: 30;
    /** Maximum API cost in USD for a single bug fix pipeline run.
     *  Abort + notify if cumulative cost exceeds this. ($30/month budget) */
    readonly MAX_PER_BUG_COST_USD: 3;
};
/** Minimum fix attempts with 100% failure rate before auto-bypass triggers.
 *  The actual check lives in sdk-bug-fix.yml (not in TS — can't import from YAML).
 *  This constant is the documented source of truth; keep the YAML value in sync. */
export declare const AUTO_BYPASS_THRESHOLD = 5;
/** Master switch for auto-bypass. Set to false to disable bypass and always attempt fixes. */
export declare const AUTO_BYPASS_ENABLED = true;
/** Classifications that ALWAYS route to handoff, regardless of fix history.
 *  crash_bug = P0 severity, too critical for LLM guessing.
 *  purchase_error = P0 severity, monetization bugs are existential threats.
 *  The actual check lives in sdk-bug-fix.yml; keep the YAML list in sync. */
export declare const ALWAYS_HANDOFF_CLASSIFICATIONS: readonly Classification[];
/** Read-only tools for verifier subagents */
export declare const VERIFIER_TOOLS: readonly ["Read", "Glob", "Grep", "Bash"];
/** Minimal tools for proof workflow — truly read-only, no Bash */
export declare const PROOF_TOOLS: readonly ["Read", "Glob", "Grep"];
/** No tools for triage subagent — classify from text + screenshots only (PV2-5.1) */
export declare const TRIAGE_TOOLS: readonly [];
/** Read-only tools for QA review subagent — no Write, Edit, or Bash (Story PV2-3.1) */
export declare const QA_TOOLS: readonly ["Read", "Glob", "Grep"];
/** Read-write tools for fixer subagents (restricted to Data/ directory via hooks) */
export declare const FIXER_TOOLS: readonly ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];
/** Read-write tools for bug fix subagents (Swift + JSON via buildBugFixHooksConfig) */
export declare const BUG_FIX_TOOLS: readonly ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];
/** Canonical classification list — single source of truth (BA-011 AC1).
 *  Adding a classification requires changes in exactly 4 files:
 *  config.ts, bug-triager.md, routing.ts, routing-fixtures.ts (NFR14). */
export declare const CLASSIFICATIONS: readonly ["content_error", "content_category_error", "content_duplicate", "translation_error", "ui_bug", "gameplay_bug", "code_bug", "performance_issue", "crash_bug", "purchase_error", "data_corruption", "multiplayer_error", "feature_request", "needs_human_review"];
/** Union type of all valid classifications */
export type Classification = (typeof CLASSIFICATIONS)[number];
/** Set for O(1) membership checks — derived from CLASSIFICATIONS (AC1) */
export declare const CLASSIFICATION_SET: ReadonlySet<string>;
/** Confidence threshold for routing gate (BA-011 FR6, FR25).
 *  Strictly less-than comparison: 0.70 passes, 0.69 is blocked.
 *  Change this single constant to adjust — no routing logic or prompt changes needed. */
export declare const CONFIDENCE_THRESHOLD = 0.7;
/** Routing constants — repos, labels, dispatch event types (Story 4.2) */
export declare const ROUTING: {
    /** GitHub repos */
    readonly PRIVATE_REPO: "RaufGlasgow/Sorting-History";
    readonly PUBLIC_REPO: "RaufGlasgow/sortinghistory-bugs";
    /** Dispatch event types */
    readonly DISPATCH_CONTENT_VERIFY: "sdk-content-verify";
    readonly DISPATCH_CONTENT_RESUME: "sdk-content-resume";
    readonly DISPATCH_APPROVE: "approve";
    readonly DISPATCH_SDK_BUG_FIX: "sdk-bug-fix";
    readonly DISPATCH_TRANSLATION_FIX: "sdk-translation-fix";
    readonly DISPATCH_TRANSLATION_RESUME: "sdk-translation-resume";
    /** Labels applied by routing */
    readonly LABEL_ROUTED: "sdk-routed";
    readonly LABEL_CONTENT_ERROR: "content-error";
    readonly LABEL_TRANSLATION_ERROR: "translation-error";
    readonly LABEL_UI_BUG: "ui-bug";
    readonly LABEL_GAMEPLAY_BUG: "gameplay-bug";
    readonly LABEL_NEEDS_CLAUDE_CODE: "needs-claude-code";
    readonly LABEL_FEATURE_REQUEST: "feature-request";
    readonly LABEL_NEEDS_HUMAN_REVIEW: "needs-human-review";
    readonly LABEL_NEEDS_TRIAGE: "needs-triage";
    /** BA-011: Labels for unknown/unrecognized classifications */
    readonly LABEL_UNKNOWN_CLASSIFICATION: "unknown-classification";
    /** BA-011: Label for low-confidence classifications (below CONFIDENCE_THRESHOLD) */
    readonly LABEL_LOW_CONFIDENCE: "low-confidence";
    /** BA-011 Story 2.1: New classification labels */
    readonly LABEL_CONTENT_DUPLICATE: "content-duplicate";
    readonly LABEL_PERFORMANCE_ISSUE: "performance-issue";
    readonly LABEL_CODE_BUG: "code-bug";
    readonly LABEL_CRASH_BUG: "crash-bug";
    readonly LABEL_PURCHASE_ERROR: "purchase-error";
    readonly LABEL_DATA_CORRUPTION: "data-corruption";
    readonly LABEL_MULTIPLAYER_ERROR: "multiplayer-error";
    readonly LABEL_NEEDS_DEV_HANDOFF: "needs-dev-handoff";
    /** Story 3.2: Label for failed fix attempts (retryable) */
    readonly LABEL_FIX_FAILED: "fix-failed";
    /** Story 3.2: Label for in-progress workflows */
    readonly LABEL_IN_PROGRESS: "in-progress";
};
/** Per-model pricing in USD per million tokens (input, output) */
export declare const MODEL_PRICING: Record<string, {
    input_per_mtok: number;
    output_per_mtok: number;
}>;
/**
 * Estimate cost in USD for a subagent call based on token usage.
 * Falls back to Sonnet pricing for unknown models (safe default).
 *
 * @param model - Model ID string
 * @param inputTokens - Number of input tokens consumed
 * @param outputTokens - Number of output tokens consumed
 * @returns Estimated cost in USD (rounded to 6 decimal places)
 */
export declare function estimateCost(model: string, inputTokens: number, outputTokens: number): number;
/**
 * Truncate an error message to a maximum length.
 * Story 3.2 AC: error_output should be truncated to 500 characters max.
 */
export declare function truncateError(error: string, maxLength?: number): string;
