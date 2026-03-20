/**
 * Shared JSON extraction utility for Haiku subagent responses.
 *
 * Haiku does NOT reliably output raw JSON even when instructed to.
 * This parser handles narrative text wrapping using the proven
 * approach from ATT-004:
 *   1. Try regex extraction of ```json ... ``` code block
 *   2. Fallback: find first { and last } as JSON boundaries
 *   3. Pass through if response already starts with {
 *
 * Used by: proof.ts, bug-triage.ts, pause-resume-proof.ts
 */
/**
 * Extract JSON text from a Haiku response that may contain narrative text.
 *
 * Does NOT parse — returns the extracted JSON string for the caller to parse.
 * This allows callers to use their own type assertions.
 *
 * When requiredKey is provided, finds the JSON object that contains that key.
 * This prevents extracting the wrong JSON when Haiku outputs multiple objects
 * (e.g., event data during investigation + triage result at the end).
 */
export declare function extractJson(text: string, requiredKey?: string): string;
