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
 */
export function extractJson(text: string): string {
  const jsonText = text.trim();

  // Try 1: Extract ```json ... ``` block from anywhere in response
  const codeBlockMatch = jsonText.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }

  // Try 2: If response doesn't start with {, find first { and last }
  if (!jsonText.startsWith("{")) {
    const firstBrace = jsonText.indexOf("{");
    const lastBrace = jsonText.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return jsonText.slice(firstBrace, lastBrace + 1);
    }
  }

  // Already looks like raw JSON — return as-is
  return jsonText;
}
