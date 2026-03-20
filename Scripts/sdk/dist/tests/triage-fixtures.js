/**
 * Bug Triager Test Fixtures
 *
 * 10 test reports with expected classifications and acceptable severity ranges.
 * BA-011: Added content_duplicate, performance_issue, crash_bug fixtures.
 * Used by both local testing and CI validation.
 */
export const TRIAGE_FIXTURES = [
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
    // --- Story 3.5: Vague reports with contextual signals ---
    {
        id: "test-K",
        // Vague report but mentions a game mode ("history epic" = Epic mode) and
        // a category name ("ancient history"). Contextual analysis should classify
        // as content_category_error (event from wrong category appearing in Epic round).
        report: "I was playing history epic and ancient history card came up\n\nCurrentScreen: BugReportView",
        expected_classification: ["content_category_error", "content_error", "needs_human_review"],
        expected_severity_range: ["P3", "P4"],
    },
    {
        id: "test-L",
        // Report mentions sharing context + screen freeze. CurrentScreen confirms
        // the location. Should classify as ui_bug or crash_bug.
        report: "Game froze when I shared my score\n\nCurrentScreen: ShareCardView",
        expected_classification: ["ui_bug", "crash_bug", "performance_issue"],
        expected_severity_range: ["P2", "P3"],
    },
    {
        id: "test-M",
        // Mentions "translation" keyword + daily challenge game mode + German language.
        // Should classify as translation_error with moderate confidence.
        report: "The translation looks weird on the daily challenge screen\n\n## Device Info\n- Language: de\n- Model: iPhone 15\n- OS Version: iOS 17.4",
        expected_classification: ["translation_error", "ui_bug", "needs_human_review"],
        expected_severity_range: ["P3", "P4"],
    },
];
