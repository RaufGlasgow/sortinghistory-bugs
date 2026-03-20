/**
 * Bug Triager Test Fixtures
 *
 * 10 test reports with expected classifications and acceptable severity ranges.
 * BA-011: Added content_duplicate, performance_issue, crash_bug fixtures.
 * Used by both local testing and CI validation.
 */
export interface TriageFixture {
    id: string;
    report: string;
    /** Single classification or array of acceptable classifications (for ambiguous reports) */
    expected_classification: string | string[];
    expected_severity_range: string[];
}
export declare const TRIAGE_FIXTURES: TriageFixture[];
