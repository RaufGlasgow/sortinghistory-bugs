/**
 * Story 2.2: Classification-to-Route Contract Test (BA-011 FR8, FR20, NFR14)
 *
 * Verifies that EVERY classification in CLASSIFICATIONS has:
 *   1. A `case "X":` in routeByClassification() in routing.ts
 *   2. At least one fixture in routing-fixtures.ts with that classification
 *   3. A `### X` heading in bug-triager.md
 *   4. Triage validation via CLASSIFICATION_SET from config.ts (no hardcoded set)
 *
 * Reads SOURCE files (.ts and .md), not compiled JavaScript.
 * This means it catches issues before build — even if the code does not compile.
 *
 * Cost: $0.00 (pure file reads, no API calls)
 *
 * Exit codes:
 * - 0: All classifications pass the 4-file check (silent pass)
 * - 1: One or more classifications are missing from one or more files
 */
export declare function runContractTest(): void;
