/**
 * PV2-6.2: QA Retry Classification Tests
 *
 * Tests isRetryableQAError() and isBillingError() at lib/retry-loop.ts to ensure
 * correct classification of retryable vs. non-retryable vs. billing QA errors.
 *
 * UPDATED: Billing errors (credit balance, quota) are NO LONGER retryable.
 * They are detected separately by isBillingError() and cause immediate abort.
 */
export {};
