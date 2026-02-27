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

export const TRIAGE_FIXTURES: TriageFixture[] = [
  {
    id: "test-A",
    // Haiku investigates real data and finds 1969 is correct. It may classify as
    // content_error (report IS about content, even if wrong) or needs_human_review
    // (uncertain because user's claim contradicts data). Both are valid.
    report: "The year for the moon landing says 1968 instead of 1969",
    expected_classification: ["content_error", "needs_human_review"],
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
    // Describes broken game state (wrong results), not app termination.
    // Avoids the word "crash" so the triager classifies on behavior, not keyword.
    report: "When I sort more than 10 events quickly, my score resets to zero and the round restarts",
    expected_classification: "gameplay_bug",
    expected_severity_range: ["P1", "P2"],
  },
  {
    id: "test-E",
    report: "Please add a dark mode option",
    expected_classification: "feature_request",
    expected_severity_range: ["P4"],
  },
  {
    id: "test-F",
    // Intentionally vague — Haiku should lack confidence to classify definitively.
    // needs_human_review is the primary expectation, but content_error is acceptable
    // if Haiku decides the vague mention of "dates" is enough signal.
    report: "Something seems off with some of the dates in the game",
    expected_classification: ["needs_human_review", "content_error"],
    expected_severity_range: ["P3", "P4"],
  },
  {
    id: "test-G",
    // Boundary confusion: could be content_error (date wrong in source) or
    // translation_error (date wrong only in German). Tests triager reasoning.
    report: "The date for the fall of the Berlin Wall is wrong in the German version",
    expected_classification: ["content_error", "translation_error", "needs_human_review"],
    expected_severity_range: ["P2", "P3"],
  },

  // --- BA-011: 3 new classification fixtures ---

  {
    id: "test-H",
    report: "There are two copies of the Boston Tea Party event in US History",
    expected_classification: ["content_duplicate", "content_error"],
    expected_severity_range: ["P2", "P3"],
  },
  {
    id: "test-I",
    report: "The app is really slow when loading the Dutch History category, takes over 10 seconds",
    expected_classification: ["performance_issue", "gameplay_bug"],
    expected_severity_range: ["P2", "P3"],
  },
  {
    id: "test-J",
    // TEA finding: crash-during-gameplay is crash_bug, not gameplay_bug.
    // After Story 2.3 prompt update, this should classify as crash_bug.
    report: "The app crashes immediately when I tap the multiplayer button",
    expected_classification: ["crash_bug", "gameplay_bug"],
    expected_severity_range: ["P1", "P2"],
  },
];
