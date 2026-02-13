/**
 * Story 4.1: Bug Triager Test Fixtures
 *
 * 5 test reports with expected classifications and acceptable severity ranges.
 * Used by both local testing and CI validation.
 */

export interface TriageFixture {
  id: string;
  report: string;
  expected_classification: string;
  expected_severity_range: string[];
}

export const TRIAGE_FIXTURES: TriageFixture[] = [
  {
    id: "test-A",
    // Note: Haiku may investigate real data and find the moon landing IS 1969,
    // rating this as P4 (false positive report). That's valid triager behavior.
    report: "The year for the moon landing says 1968 instead of 1969",
    expected_classification: "content_error",
    expected_severity_range: ["P2", "P3", "P4"],
  },
  {
    id: "test-B",
    report: "In the German translation of Ancient Civilizations, the event 'Unification of Egypt' description has a grammatical error — it uses 'vereint' instead of 'vereinigt'",
    expected_classification: "translation_error",
    expected_severity_range: ["P2", "P3"],
  },
  {
    id: "test-C",
    report: "The help bubble doesn't show on first launch",
    expected_classification: "ui_bug",
    expected_severity_range: ["P3", "P4"],
  },
  {
    id: "test-D",
    report: "Game crashes when sorting more than 10 events quickly",
    expected_classification: "gameplay_bug",
    expected_severity_range: ["P1", "P2"],
  },
  {
    id: "test-E",
    report: "Please add a dark mode option",
    expected_classification: "feature_request",
    expected_severity_range: ["P4"],
  },
];
