/**
 * Story 1.3: First Subagent Proof (Haiku Read-Only)
 *
 * THE CRITICAL PROOF POINT. Spawns a Haiku subagent that:
 * 1. Reads game-repo/Data/Events/USHistory.json
 * 2. Counts the events
 * 3. Extracts the first event's title, year, and category
 * 4. Returns structured JSON
 *
 * Validates:
 * - The subagent returns valid JSON
 * - No write/edit tools were used (read-only enforcement)
 * - Logs model, token usage, and duration
 *
 * Exit codes:
 * - 0: Success (all validations passed)
 * - 1: Failure (any validation failed)
 */
/** Run the Story 1.3 proof workflow */
export declare function runProof(): Promise<void>;
