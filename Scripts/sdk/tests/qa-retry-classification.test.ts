/**
 * PV2-6.2: QA Retry Classification Tests
 *
 * Tests isRetryableQAError() and isBillingError() at lib/retry-loop.ts to ensure
 * correct classification of retryable vs. non-retryable vs. billing QA errors.
 *
 * UPDATED: Billing errors (credit balance, quota) are NO LONGER retryable.
 * They are detected separately by isBillingError() and cause immediate abort.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { isRetryableQAError, isBillingError } from "../lib/retry-loop.js";

describe("qa-retry-classification: retryable errors", () => {
  it('"rate limit exceeded" → retryable', () => {
    assert.equal(isRetryableQAError("rate limit exceeded"), true);
  });

  it('"HTTP 429 Too Many Requests" → retryable', () => {
    assert.equal(isRetryableQAError("HTTP 429 Too Many Requests"), true);
  });

  it('"Connection refused ECONNREFUSED" → retryable', () => {
    assert.equal(isRetryableQAError("Connection refused ECONNREFUSED"), true);
  });

  it('"Request timeout after 30s" → retryable', () => {
    assert.equal(isRetryableQAError("Request timeout after 30s"), true);
  });

  it('"HTTP 502 Bad Gateway" → retryable', () => {
    assert.equal(isRetryableQAError("HTTP 502 Bad Gateway"), true);
  });
});

describe("qa-retry-classification: billing errors (never retryable)", () => {
  it('"credit balance is too low" → NOT retryable', () => {
    assert.equal(isRetryableQAError("credit balance is too low"), false);
  });

  it('"credit balance is too low" → detected as billing error', () => {
    assert.equal(isBillingError("credit balance is too low"), true);
  });

  it('"insufficient_quota" → detected as billing error', () => {
    assert.equal(isBillingError("insufficient_quota"), true);
  });

  it('"API billing error: Credit balance is too low" → detected as billing error', () => {
    assert.equal(isBillingError("API billing error: Credit balance is too low"), true);
  });

  it('"quota exceeded for this month" → detected as billing error', () => {
    assert.equal(isBillingError("quota exceeded for this month"), true);
  });
});

describe("qa-retry-classification: non-retryable errors", () => {
  it('"Missing prompt file: qa-reviewer-code.md" → not retryable', () => {
    assert.equal(
      isRetryableQAError("Missing prompt file: qa-reviewer-code.md"),
      false,
    );
  });

  it('"Invalid config: qaProfile must be code or content" → not retryable', () => {
    assert.equal(
      isRetryableQAError("Invalid config: qaProfile must be code or content"),
      false,
    );
  });

  it("empty string → not retryable", () => {
    assert.equal(isRetryableQAError(""), false);
  });

  it('"Unexpected JSON parse error in response" → not retryable', () => {
    assert.equal(
      isRetryableQAError("Unexpected JSON parse error in response"),
      false,
    );
  });

  it("normal error → not a billing error", () => {
    assert.equal(isBillingError("Connection refused"), false);
  });

  it("empty string → not a billing error", () => {
    assert.equal(isBillingError(""), false);
  });
});
