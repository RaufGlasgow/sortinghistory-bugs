/**
 * PV2-6.2: QA Retry Classification Tests
 *
 * Tests isRetryableQAError() at lib/retry-loop.ts to ensure correct
 * classification of retryable vs. non-retryable QA errors.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { isRetryableQAError } from "../lib/retry-loop.js";

describe("qa-retry-classification: retryable errors", () => {
  it('"credit balance is too low" → retryable', () => {
    assert.equal(isRetryableQAError("credit balance is too low"), true);
  });

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
});
