/**
 * Routing Test Fixtures
 *
 * Test fixtures covering all routing paths + idempotency skip + category fallback.
 * Updated for BA-011: Gate 2 unknown classification → safe label (not throw).
 * Used by the routing-test harness (pure logic tests, no API calls, $0.00 cost).
 */
import type { RoutingInput } from "../lib/routing.js";
export interface RoutingFixture {
    id: string;
    description: string;
    input: RoutingInput;
    expected: ExpectedAction;
}
/** What we expect the routing decision to produce */
export type ExpectedAction = {
    type: "dispatch";
    event_type: string;
    repo: string;
    payload_keys: string[];
    payload_values?: Record<string, unknown>;
} | {
    type: "label";
    repo: string;
    labels: string[];
} | {
    type: "label_and_state";
    repo: string;
    labels: string[];
    workflow_type: string;
} | {
    type: "skip";
} | {
    type: "handoff_to_dev";
    repo: string;
    labels: string[];
    classification: string;
};
export declare const ROUTING_FIXTURES: RoutingFixture[];
