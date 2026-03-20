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
 *   Haiku 4.5 < Sonnet 4.5
 *
 * QA model rule: QA model is always <= fix model tier.
 */
import { MODELS, LIMITS, LOCAL_MODELS, WORKFLOW_BACKENDS } from "../config.js";
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
 * COST CONSTRAINT: $30/month budget. Max model is Sonnet.
 *
 * Content simple:  Haiku  -> Haiku  -> Sonnet (cheapest path)
 * Content complex: Haiku  -> Sonnet -> Sonnet (starts low, escalates once)
 * Code simple:     Sonnet -> Sonnet -> Sonnet (code needs at least Sonnet)
 * Code complex:    Sonnet -> Sonnet -> Sonnet (always Sonnet, increasing context)
 *
 * Turn limits: Fix needs 15-30 turns for explore->fix->compile.
 * QA needs 15-20 turns for Read/Glob/Grep inspection + JSON output.
 * QA (Haiku) is cheap (~$0.08/call), so generous turn limits are fine.
 */
const ESCALATION_PATHS = {
    content_simple: [
        { fix: MODELS.VERIFIER, qa: MODELS.VERIFIER, fixTurns: 10, qaTurns: 10 },
        { fix: MODELS.VERIFIER, qa: MODELS.VERIFIER, fixTurns: 12, qaTurns: 15 },
        { fix: MODELS.FIXER, qa: MODELS.VERIFIER, fixTurns: 15, qaTurns: 15 },
    ],
    content_complex: [
        { fix: MODELS.VERIFIER, qa: MODELS.VERIFIER, fixTurns: 12, qaTurns: 15 },
        { fix: MODELS.FIXER, qa: MODELS.VERIFIER, fixTurns: 15, qaTurns: 15 },
        { fix: MODELS.FIXER, qa: MODELS.VERIFIER, fixTurns: 20, qaTurns: 20 },
    ],
    code_simple: [
        { fix: MODELS.FIXER, qa: MODELS.VERIFIER, fixTurns: 15, qaTurns: 15 },
        { fix: MODELS.FIXER, qa: MODELS.VERIFIER, fixTurns: 20, qaTurns: 15 },
        { fix: MODELS.FIXER, qa: MODELS.VERIFIER, fixTurns: 25, qaTurns: 20 },
    ],
    code_complex: [
        { fix: MODELS.FIXER, qa: MODELS.VERIFIER, fixTurns: 20, qaTurns: 15 },
        { fix: MODELS.FIXER, qa: MODELS.VERIFIER, fixTurns: 25, qaTurns: 20 },
        { fix: MODELS.FIXER, qa: MODELS.VERIFIER, fixTurns: 30, qaTurns: 20 },
    ],
};
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
export function determineBugProfile(input) {
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
export function determineQAProfile(fileExtensions) {
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
    if (hasCode && hasContent)
        return "both";
    if (hasCode)
        return "code";
    if (hasContent)
        return "content";
    return "code"; // Safe default: code QA reviews logic correctness for all fix types
}
/**
 * Select models and configuration for fix generation and QA review.
 *
 * @param profile - Bug profile from determineBugProfile()
 * @param attemptNumber - Current attempt (1-based, clamped to MAX_FIX_ATTEMPTS)
 * @param fileExtensions - File extensions to determine QA profile
 * @param options - Optional: backend override for local inference routing (Story 1.3)
 * @returns ModelSelection with fix/QA models, turn limits, and QA profile
 */
export function selectModels(profile, attemptNumber, fileExtensions, options) {
    // Story 1.3: If backend is "local", return local model IDs
    const backend = options?.backend
        ?? (options?.workflowType ? WORKFLOW_BACKENDS[options.workflowType] : undefined);
    if (backend === "local") {
        const escalationPath = ESCALATION_PATHS[profile];
        const maxAttempts = Math.min(escalationPath.length, LIMITS.MAX_FIX_ATTEMPTS);
        const index = Math.max(0, Math.min(attemptNumber - 1, maxAttempts - 1));
        const config = escalationPath[index];
        return {
            fixModel: LOCAL_MODELS.PRIMARY.id,
            qaModel: config.qa, // QA still uses Claude (separate workflow)
            fixMaxTurns: config.fixTurns,
            qaMaxTurns: config.qaTurns,
            qaProfile: determineQAProfile(fileExtensions),
        };
    }
    const escalationPath = ESCALATION_PATHS[profile];
    // Clamp attempt to valid range (1-based input, 0-based index)
    const maxAttempts = Math.min(escalationPath.length, LIMITS.MAX_FIX_ATTEMPTS);
    const index = Math.max(0, Math.min(attemptNumber - 1, maxAttempts - 1));
    const config = escalationPath[index];
    return {
        fixModel: config.fix,
        qaModel: config.qa,
        fixMaxTurns: config.fixTurns,
        qaMaxTurns: config.qaTurns,
        qaProfile: determineQAProfile(fileExtensions),
    };
}
