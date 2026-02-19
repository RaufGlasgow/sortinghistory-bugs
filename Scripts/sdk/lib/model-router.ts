/**
 * Story PV2-2.1: Smart Model Router
 *
 * Determines the correct Claude model for fix generation and QA review
 * based on bug profile classification and attempt number.
 *
 * Cost optimization: uses the cheapest model that can handle the job,
 * escalating to more capable (and expensive) models only on retry.
 *
 * Model tiers (cheapest to most capable):
 *   Haiku 4.5 < Sonnet 4.5 < Opus 4.6
 *
 * QA model rule: QA model is always <= fix model tier.
 * (Never use Opus for QA when fix uses Sonnet.)
 */

import { MODELS, LIMITS } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bug profile — determines model escalation path */
export type BugProfile =
  | "content_simple"
  | "content_complex"
  | "code_simple"
  | "code_complex";

/** QA profile — determines which QA checks to run */
export type QAProfile = "code" | "content" | "both";

/** Input for determineBugProfile() */
export interface BugProfileInput {
  /** Triage classification (e.g. "content_error", "ui_bug", "gameplay_bug", "translation_error") */
  classification: string;
  /** Triage confidence score, 0-1 */
  confidence: number;
  /** File extensions of files likely to change (e.g. [".json", ".swift"]) */
  fileExtensions: string[];
}

/** Output from selectModels() — everything needed to configure fix + QA subagents */
export interface ModelSelection {
  /** Model ID for the fix generation subagent */
  fixModel: string;
  /** Model ID for the QA review subagent */
  qaModel: string;
  /** Max agentic turns for the fix subagent */
  fixMaxTurns: number;
  /** Max agentic turns for the QA subagent */
  qaMaxTurns: number;
  /** QA profile: determines which checks to run */
  qaProfile: QAProfile;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Content-related triage classifications */
const CONTENT_CLASSIFICATIONS = new Set([
  "content_error",
  "translation_error",
]);

/** Code file extensions — used to determine QA profile */
const CODE_EXTENSIONS = new Set([
  ".swift",
  ".pbxproj",
  ".plist",
  ".storyboard",
  ".xib",
  ".entitlements",
  ".xcconfig",
]);

/** Content file extensions — used to determine QA profile */
const CONTENT_EXTENSIONS = new Set([
  ".json",
  ".strings",
  ".stringsdict",
]);

/**
 * Model escalation paths per bug profile.
 *
 * Each array is indexed by attempt number (0-based): attempt 1 = index 0, etc.
 * fix = model for fix generation, qa = model for QA review, fixTurns/qaTurns = max turns.
 *
 * Content simple:  Haiku  -> Sonnet -> Opus   (cheapest path)
 * Content complex: Sonnet -> Opus   -> Opus   (starts higher)
 * Code simple:     Sonnet -> Opus   -> Opus   (code needs at least Sonnet)
 * Code complex:    Opus   -> Opus   -> Opus   (always Opus, increasing context)
 */
const ESCALATION_PATHS: Record<
  BugProfile,
  Array<{ fix: string; qa: string; fixTurns: number; qaTurns: number }>
> = {
  content_simple: [
    { fix: MODELS.VERIFIER, qa: MODELS.VERIFIER, fixTurns: 8, qaTurns: 5 },
    { fix: MODELS.FIXER, qa: MODELS.VERIFIER, fixTurns: 12, qaTurns: 6 },
    { fix: MODELS.COMPLEX_BUG, qa: MODELS.FIXER, fixTurns: 15, qaTurns: 8 },
  ],
  content_complex: [
    { fix: MODELS.FIXER, qa: MODELS.VERIFIER, fixTurns: 12, qaTurns: 6 },
    { fix: MODELS.COMPLEX_BUG, qa: MODELS.FIXER, fixTurns: 15, qaTurns: 8 },
    { fix: MODELS.COMPLEX_BUG, qa: MODELS.FIXER, fixTurns: 20, qaTurns: 10 },
  ],
  code_simple: [
    { fix: MODELS.FIXER, qa: MODELS.VERIFIER, fixTurns: 12, qaTurns: 6 },
    { fix: MODELS.COMPLEX_BUG, qa: MODELS.FIXER, fixTurns: 15, qaTurns: 8 },
    { fix: MODELS.COMPLEX_BUG, qa: MODELS.FIXER, fixTurns: 20, qaTurns: 10 },
  ],
  code_complex: [
    { fix: MODELS.COMPLEX_BUG, qa: MODELS.FIXER, fixTurns: 15, qaTurns: 8 },
    { fix: MODELS.COMPLEX_BUG, qa: MODELS.FIXER, fixTurns: 20, qaTurns: 10 },
    { fix: MODELS.COMPLEX_BUG, qa: MODELS.FIXER, fixTurns: 25, qaTurns: 12 },
  ],
} as const;

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Classify a bug into one of 4 profiles based on triage output.
 *
 * Profile rules:
 * - content_error or translation_error with confidence >= 0.8 -> content_simple
 * - content_error or translation_error with confidence < 0.8  -> content_complex
 * - ui_bug, gameplay_bug, or other code bugs with single file -> code_simple
 * - ui_bug, gameplay_bug, or other code bugs with multiple files -> code_complex
 */
export function determineBugProfile(input: BugProfileInput): BugProfile {
  const { classification, confidence, fileExtensions } = input;

  if (CONTENT_CLASSIFICATIONS.has(classification)) {
    return confidence >= 0.8 ? "content_simple" : "content_complex";
  }

  // All other classifications are code bugs (ui_bug, gameplay_bug, etc.)
  // Single file = simple, multiple files = complex
  const uniqueExtensions = new Set(fileExtensions);
  return uniqueExtensions.size <= 1 ? "code_simple" : "code_complex";
}

/**
 * Determine the QA profile based on which file types will be modified.
 *
 * - "code" for .swift/.pbxproj/etc changes only
 * - "content" for .json/.strings changes only
 * - "both" for mixed changes
 */
export function determineQAProfile(fileExtensions: string[]): QAProfile {
  let hasCode = false;
  let hasContent = false;

  for (const ext of fileExtensions) {
    const normalized = ext.startsWith(".") ? ext : "." + ext;
    if (CODE_EXTENSIONS.has(normalized)) {
      hasCode = true;
    }
    if (CONTENT_EXTENSIONS.has(normalized)) {
      hasContent = true;
    }
  }

  if (hasCode && hasContent) return "both";
  if (hasCode) return "code";
  return "content";
}

/**
 * Select models and configuration for fix generation and QA review.
 *
 * @param profile - Bug profile from determineBugProfile()
 * @param attemptNumber - Current attempt (1-based, clamped to MAX_FIX_ATTEMPTS)
 * @param fileExtensions - File extensions to determine QA profile
 * @returns ModelSelection with fix/QA models, turn limits, and QA profile
 */
export function selectModels(
  profile: BugProfile,
  attemptNumber: number,
  fileExtensions: string[],
): ModelSelection {
  const path = ESCALATION_PATHS[profile];

  // Clamp attempt to valid range (1-based input, 0-based index)
  const maxAttempts = Math.min(path.length, LIMITS.MAX_FIX_ATTEMPTS);
  const index = Math.max(0, Math.min(attemptNumber - 1, maxAttempts - 1));

  const config = path[index];

  return {
    fixModel: config.fix,
    qaModel: config.qa,
    fixMaxTurns: config.fixTurns,
    qaMaxTurns: config.qaTurns,
    qaProfile: determineQAProfile(fileExtensions),
  };
}
