/**
 * BA-011 Story 3.3: CLI entry point for digest confidence data.
 *
 * Called by the GitHub Actions morning digest workflow to get confidence
 * data from the routing decision log.
 *
 * Usage:
 *   npx tsx Scripts/sdk/lib/digest-confidence-cli.ts [YYYY-MM-DD]
 *
 * Output: JSON to stdout (DigestConfidenceResult)
 *
 * If no date is provided, defaults to today.
 * If the routing log does not exist for the date, outputs a result
 * with source="label_fallback" and empty arrays.
 */
export {};
