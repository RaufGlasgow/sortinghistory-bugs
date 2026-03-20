/**
 * Routing Test Fixtures
 *
 * Test fixtures covering all routing paths + idempotency skip + category fallback.
 * Updated for BA-011: Gate 2 unknown classification → safe label (not throw).
 * Used by the routing-test harness (pure logic tests, no API calls, $0.00 cost).
 */
import { ROUTING } from "../config.js";
export const ROUTING_FIXTURES = [
    // --- route-1: content_error -> dispatch sdk-content-verify (AC-1) ---
    {
        id: "route-1",
        description: "content_error routes to sdk-content-verify dispatch",
        input: {
            classification: "content_error",
            severity: "P2",
            confidence: 0.9,
            extracted_context: { category: "US History", event_title: "Moon Landing" },
            issue_number: 42,
        },
        expected: {
            type: "dispatch",
            event_type: ROUTING.DISPATCH_CONTENT_VERIFY,
            repo: ROUTING.PUBLIC_REPO,
            payload_keys: ["workflow_type", "category", "issue_number"],
            payload_values: { workflow_type: "content_verification", category: "US History", issue_number: 42 },
        },
    },
    // --- route-2: translation_error -> dispatch sdk-translation-fix (BA-008.2 AC1) ---
    {
        id: "route-2",
        description: "translation_error routes to sdk-translation-fix dispatch",
        input: {
            classification: "translation_error",
            severity: "P3",
            confidence: 0.85,
            extracted_context: { category: "Ancient Civilizations", language: "German" },
            issue_number: 43,
        },
        expected: {
            type: "dispatch",
            event_type: ROUTING.DISPATCH_TRANSLATION_FIX,
            repo: ROUTING.PUBLIC_REPO,
            payload_keys: ["workflow_type", "language", "issue_number"],
            payload_values: { workflow_type: "translation_verification", language: "German", issue_number: 43 },
        },
    },
    // --- route-3: ui_bug P4 -> label-only + wait for /approve (SDK-BF.3 AC1) ---
    {
        id: "route-3",
        description: "ui_bug P4 routes to label-only (wait for /approve)",
        input: {
            classification: "ui_bug",
            severity: "P4",
            confidence: 0.8,
            extracted_context: { screen: "SettingsView" },
            issue_number: 44,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_UI_BUG, "severity/P4", ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-4: ui_bug P1 -> label-only + wait for /approve (SDK-BF.3 AC1) ---
    {
        id: "route-4",
        description: "ui_bug P1 routes to label-only (wait for /approve)",
        input: {
            classification: "ui_bug",
            severity: "P1",
            confidence: 0.75,
            extracted_context: { screen: "GameView", crash: true },
            issue_number: 45,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_UI_BUG, "severity/P1", ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-5: gameplay_bug -> label-only + wait for /approve (SDK-BF.3 AC2) ---
    {
        id: "route-5",
        description: "gameplay_bug routes to label-only (wait for /approve)",
        input: {
            classification: "gameplay_bug",
            severity: "P2",
            confidence: 0.9,
            extracted_context: { area: "sorting-engine" },
            issue_number: 46,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_GAMEPLAY_BUG, "severity/P2", ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-6: feature_request -> label feature-request (AC-6) ---
    {
        id: "route-6",
        description: "feature_request routes to backlog label",
        input: {
            classification: "feature_request",
            severity: "P4",
            confidence: 0.95,
            extracted_context: { feature: "dark mode" },
            issue_number: 47,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_FEATURE_REQUEST, ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-7: needs_human_review -> label needs-human-review (AC-7) ---
    // Note: confidence raised to 0.75 so this tests the classification route, not the confidence gate
    {
        id: "route-7",
        description: "needs_human_review routes to manual triage queue",
        input: {
            classification: "needs_human_review",
            severity: "P3",
            confidence: 0.75,
            extracted_context: {},
            issue_number: 48,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-8: idempotency — already-routed issue is skipped (AC-10) ---
    {
        id: "route-8",
        description: "already-routed issue is skipped (idempotency)",
        input: {
            classification: "content_error",
            severity: "P2",
            confidence: 0.9,
            extracted_context: { category: "US History" },
            issue_number: 42,
            existing_labels: ["bug", ROUTING.LABEL_ROUTED],
        },
        expected: {
            type: "skip",
        },
    },
    // --- route-9: content_error with no category -> defaults to "unknown" (AC-1 fallback) ---
    {
        id: "route-9",
        description: "content_error with missing category defaults to 'unknown'",
        input: {
            classification: "content_error",
            severity: "P3",
            confidence: 0.7,
            extracted_context: {},
            issue_number: 49,
        },
        expected: {
            type: "dispatch",
            event_type: ROUTING.DISPATCH_CONTENT_VERIFY,
            repo: ROUTING.PUBLIC_REPO,
            payload_keys: ["workflow_type", "category", "issue_number"],
            payload_values: { workflow_type: "content_verification", category: "unknown", issue_number: 49 },
        },
    },
    // --- route-10: ui_bug P2 -> label-only (SDK-BF.3 — verify mid-severity also label-only) ---
    {
        id: "route-10",
        description: "ui_bug P2 routes to label-only (all severities same path)",
        input: {
            classification: "ui_bug",
            severity: "P2",
            confidence: 0.85,
            extracted_context: { screen: "CategorySelectionView" },
            issue_number: 50,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_UI_BUG, "severity/P2", ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-11: gameplay_bug P4 -> label-only (SDK-BF.3 — verify low severity also label-only) ---
    {
        id: "route-11",
        description: "gameplay_bug P4 routes to label-only (all severities same path)",
        input: {
            classification: "gameplay_bug",
            severity: "P4",
            confidence: 0.7,
            extracted_context: { area: "results-screen" },
            issue_number: 51,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_GAMEPLAY_BUG, "severity/P4", ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-content-category-error: content_category_error → label (manual review) ---
    {
        id: "route-content-category-error",
        description: "content_category_error routes to label (needs human review for category move)",
        input: {
            classification: "content_category_error",
            severity: "P2",
            confidence: 0.85,
            extracted_context: { category: "US History", event_title: "Chinese Economic Reforms" },
            issue_number: 55,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_CONTENT_ERROR, "category-mismatch", ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_ROUTED],
        },
    },
    // --- BA-011 Story 2.1: 3 new classification fixtures ---
    // --- route-content-duplicate: content_duplicate → label (no automation) ---
    {
        id: "route-content-duplicate",
        description: "content_duplicate routes to label (needs human review)",
        input: {
            classification: "content_duplicate",
            severity: "P3",
            confidence: 0.85,
            extracted_context: { category: "US History", event_title: "Boston Tea Party" },
            issue_number: 60,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_CONTENT_DUPLICATE, ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-performance-issue: performance_issue → handoff_to_dev ---
    {
        id: "route-performance-issue",
        description: "performance_issue routes to handoff_to_dev",
        input: {
            classification: "performance_issue",
            severity: "P2",
            confidence: 0.80,
            extracted_context: { area: "category-loading" },
            issue_number: 61,
            issue_title: "App is really slow loading Dutch History",
            issue_body: "The app takes 10+ seconds to load the Dutch History category.",
            reasoning: "User reports slow loading of a specific category",
        },
        expected: {
            type: "handoff_to_dev",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_PERFORMANCE_ISSUE, ROUTING.LABEL_NEEDS_DEV_HANDOFF, ROUTING.LABEL_ROUTED],
            classification: "performance_issue",
        },
    },
    // --- route-crash-bug: crash_bug → handoff_to_dev ---
    {
        id: "route-crash-bug",
        description: "crash_bug routes to handoff_to_dev",
        input: {
            classification: "crash_bug",
            severity: "P1",
            confidence: 0.90,
            extracted_context: { screen: "MultiplayerView" },
            issue_number: 62,
            issue_title: "App crashes when selecting multiplayer",
            issue_body: "Every time I tap the multiplayer button, the app immediately crashes.",
            reasoning: "App termination reported by user on specific interaction",
        },
        expected: {
            type: "handoff_to_dev",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_CRASH_BUG, ROUTING.LABEL_NEEDS_DEV_HANDOFF, ROUTING.LABEL_ROUTED],
            classification: "crash_bug",
        },
    },
    // --- route-performance-no-body: performance_issue without issue_body → label fallback ---
    {
        id: "route-performance-no-body",
        description: "performance_issue without issue data → label fallback (defensive)",
        input: {
            classification: "performance_issue",
            severity: "P2",
            confidence: 0.80,
            extracted_context: {},
            issue_number: 63,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_PERFORMANCE_ISSUE, ROUTING.LABEL_NEEDS_DEV_HANDOFF, ROUTING.LABEL_ROUTED],
        },
    },
    // --- BA-011 Gate 2 fixtures: unknown/invalid classifications → safe label ---
    // --- route-gate2-unknown: completely unknown classification → safe label (S1) ---
    {
        id: "route-gate2-unknown",
        description: "Unknown classification 'banana_error' → safe label (Gate 2)",
        input: {
            classification: "banana_error",
            severity: "P1",
            confidence: 0.9,
            extracted_context: {},
            issue_number: 999,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_UNKNOWN_CLASSIFICATION, ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-gate2-empty-string: empty string classification → safe label (TEA edge case) ---
    {
        id: "route-gate2-empty-string",
        description: "Empty string classification → safe label (Gate 2)",
        input: {
            classification: "",
            severity: "P2",
            confidence: 0.8,
            extracted_context: {},
            issue_number: 1000,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_UNKNOWN_CLASSIFICATION, ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-gate2-whitespace: whitespace-padded classification → safe label (TEA edge case) ---
    {
        id: "route-gate2-whitespace",
        description: "Whitespace-padded ' content_error ' → safe label (case-sensitive, no trimming)",
        input: {
            classification: " content_error ",
            severity: "P2",
            confidence: 0.9,
            extracted_context: {},
            issue_number: 1001,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_UNKNOWN_CLASSIFICATION, ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-gate2-wrong-casing: wrong casing classification → safe label (TEA edge case) ---
    {
        id: "route-gate2-wrong-casing",
        description: "Wrong casing 'Content_Error' → safe label (case-sensitive match)",
        input: {
            classification: "Content_Error",
            severity: "P2",
            confidence: 0.85,
            extracted_context: {},
            issue_number: 1002,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_UNKNOWN_CLASSIFICATION, ROUTING.LABEL_ROUTED],
        },
    },
    // --- BA-011 Gate 1 fixtures: low confidence → safe label ---
    // --- route-gate1-low-conf: confidence 0.69 → safe label (strictly less than 0.7) ---
    {
        id: "route-gate1-low-conf",
        description: "content_error with confidence 0.69 → safe label (Gate 1: below 0.7)",
        input: {
            classification: "content_error",
            severity: "P2",
            confidence: 0.69,
            extracted_context: { category: "US History" },
            issue_number: 200,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_LOW_CONFIDENCE, ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-gate1-boundary: confidence 0.70 → routes normally (boundary test) ---
    {
        id: "route-gate1-boundary",
        description: "content_error with confidence 0.70 → routes normally (exactly at threshold)",
        input: {
            classification: "content_error",
            severity: "P2",
            confidence: 0.70,
            extracted_context: { category: "US History" },
            issue_number: 201,
        },
        expected: {
            type: "dispatch",
            event_type: ROUTING.DISPATCH_CONTENT_VERIFY,
            repo: ROUTING.PUBLIC_REPO,
            payload_keys: ["workflow_type", "category", "issue_number"],
            payload_values: { workflow_type: "content_verification", category: "US History", issue_number: 201 },
        },
    },
    // --- gate1-fires-before-gate2: unknown classification + low confidence → Gate 1 (not Gate 2) ---
    {
        id: "gate1-fires-before-gate2",
        description: "Unknown 'banana_error' with confidence 0.3 → Gate 1 (low-confidence, NOT unknown-classification)",
        input: {
            classification: "banana_error",
            severity: "P1",
            confidence: 0.3,
            extracted_context: {},
            issue_number: 202,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_LOW_CONFIDENCE, ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-gate1-exactly-zero: confidence 0.0 → safe label ---
    {
        id: "route-gate1-exactly-zero",
        description: "confidence 0.0 → safe label (Gate 1)",
        input: {
            classification: "ui_bug",
            severity: "P3",
            confidence: 0.0,
            extracted_context: {},
            issue_number: 203,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_LOW_CONFIDENCE, ROUTING.LABEL_ROUTED],
        },
    },
    // --- route-gate1-exactly-one: confidence 1.0 → routes normally ---
    {
        id: "route-gate1-exactly-one",
        description: "feature_request with confidence 1.0 → routes normally",
        input: {
            classification: "feature_request",
            severity: "P4",
            confidence: 1.0,
            extracted_context: {},
            issue_number: 204,
        },
        expected: {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            labels: [ROUTING.LABEL_FEATURE_REQUEST, ROUTING.LABEL_ROUTED],
        },
    },
];
