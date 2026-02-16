/**
 * Routing Test Fixtures
 *
 * 11 test fixtures covering all routing paths + idempotency skip + category fallback.
 * Updated for SDK-BF.3: ui_bug and gameplay_bug now label-only (wait for /approve).
 * Used by the routing-test harness (pure logic tests, no API calls, $0.00 cost).
 */

import type { RoutingInput, RoutingAction } from "../lib/routing.js";
import { ROUTING } from "../config.js";

export interface RoutingFixture {
  id: string;
  description: string;
  input: RoutingInput;
  expected: ExpectedAction;
}

/** What we expect the routing decision to produce */
export type ExpectedAction =
  | { type: "dispatch"; event_type: string; repo: string; payload_keys: string[]; payload_values?: Record<string, unknown> }
  | { type: "label"; repo: string; labels: string[] }
  | { type: "label_and_state"; repo: string; labels: string[]; workflow_type: string }
  | { type: "skip" };

export const ROUTING_FIXTURES: RoutingFixture[] = [
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

  // --- route-2: translation_error -> label + state (AC-2) ---
  {
    id: "route-2",
    description: "translation_error routes to label + workflow state",
    input: {
      classification: "translation_error",
      severity: "P3",
      confidence: 0.85,
      extracted_context: { category: "Ancient Civilizations", language: "German" },
      issue_number: 43,
    },
    expected: {
      type: "label_and_state",
      repo: ROUTING.PRIVATE_REPO,
      labels: [ROUTING.LABEL_TRANSLATION_ERROR, ROUTING.LABEL_ROUTED],
      workflow_type: "translation_verification",
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
  {
    id: "route-7",
    description: "needs_human_review routes to manual triage queue",
    input: {
      classification: "needs_human_review",
      severity: "P3",
      confidence: 0.5,
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
];
