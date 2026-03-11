/**
 * Story 4.1: Bug Triager Subagent
 *
 * Spawns a Haiku subagent to classify bug reports into one of 6 categories:
 * content_error, translation_error, ui_bug, gameplay_bug, feature_request, needs_human_review
 *
 * Returns structured JSON with classification, severity, confidence,
 * reasoning, extracted_context, and routing_recommendation.
 *
 * JSON parsing uses the proven regex + brace fallback from proof.ts (ATT-004).
 *
 * Exit codes:
 * - 0: Success (valid triage result returned)
 * - 1: Failure (subagent error, invalid JSON, missing required fields)
 */
/** Structured triage result from the subagent */
export interface TriageResult {
    classification: string;
    confidence: number;
    severity: string;
    reasoning: string;
    extracted_context: Record<string, unknown>;
    routing_recommendation: string;
}
/** Input for the triage workflow */
export interface TriageInput {
    report_text: string;
    report_id?: string;
    /** Optional screenshots extracted from the bug report (base64 image data) */
    images?: import("../lib/image-extract.js").ExtractedImage[];
    /** Optional model override — used by Story 3.11 to escalate to Sonnet on re-triage with corrections */
    model?: string;
}
/** Run the bug triage workflow */
export declare function runTriage(input: TriageInput): Promise<TriageResult>;
