/**
 * Routing Test Harness
 *
 * Validates all routing fixtures by running them through decideRoute()
 * and comparing the returned RoutingAction against expected values.
 *
 * Pure logic test — NO Anthropic API calls, NO GitHub API calls.
 * Cost: $0.00
 *
 * BA-011 update: unknown classifications now return safe label (not throw).
 *
 * Exit codes:
 * - 0: All tests pass
 * - 1: One or more tests fail
 */
/** Run the routing test suite */
export declare function runRoutingTest(): Promise<void>;
