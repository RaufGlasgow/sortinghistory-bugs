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
export function extractJson(text: string, requiredKey?: string): string {
  const jsonText = text.trim();

  // If requiredKey is set, find ALL candidate JSON blocks and return the one with the key
  if (requiredKey) {
    const candidates: string[] = [];

    // Collect code blocks
    const codeBlockRegex = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/g;
    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(jsonText)) !== null) {
      if (match[1]) candidates.push(match[1].trim());
    }

    // Collect brace-delimited blocks (find each top-level { ... })
    // String-aware: skips braces inside JSON string values to avoid
    // mismatched depth from text like "value is {something}"
    let depth = 0;
    let start = -1;
    let inString = false;
    for (let i = 0; i < jsonText.length; i++) {
      const ch = jsonText[i];
      if (inString) {
        if (ch === "\\" ) {
          i++; // skip escaped character
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"" && depth > 0) {
        inString = true;
      } else if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(jsonText.slice(start, i + 1));
          start = -1;
        }
      }
    }

    // Try each candidate — return first that parses and has the required key
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (typeof parsed === "object" && parsed !== null && requiredKey in parsed) {
          return candidate;
        }
      } catch {
        // Not valid JSON, skip
      }
    }
  }

  // Original behavior (no requiredKey, or requiredKey not found in any candidate)

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
