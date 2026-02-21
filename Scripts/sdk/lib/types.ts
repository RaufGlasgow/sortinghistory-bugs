/**
 * Story PV2-6.1: Shared types for triage data interface.
 *
 * Used by both the triage writer (workflows/triage.ts) and the
 * bug-fix reader (workflows/bug-fix.ts) to ensure a typed contract
 * for triage data passed via issue comments.
 */

/** Structured triage data embedded in issue comments as JSON */
export interface TriageData {
  classification: string;
  severity: string;
  confidence: number;
  reasoning: string;
  extracted_context: {
    category: string | null;
    file_path: string | null;
    event_id: string | null;
    expected_behavior: string | null;
    actual_behavior: string | null;
  };
}
