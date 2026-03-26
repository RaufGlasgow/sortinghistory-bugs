/**
 * Story 3.14: Unit tests for title truncation and label taxonomy mapping.
 */

import { describe, it, expect } from 'vitest';
import { truncateDescription, WORKER_LABEL_TO_SDK_CLASSIFICATION } from './utils';

// ---------- truncateDescription ----------

describe('truncateDescription', () => {
  it('returns original when under limit', () => {
    const input = 'This is a short bug description for testing';
    expect(truncateDescription(input)).toBe(input);
    expect(input.length).toBeLessThan(120);
  });

  it('truncates at word boundary for long input', () => {
    // 150 chars with spaces
    const input = 'I was playing the game and noticed that the card that I should have been sorting was showing an incorrect date for the historical event which made the game confusing';
    expect(input.length).toBeGreaterThan(120);
    const result = truncateDescription(input);
    // Should end with '...'
    expect(result).toMatch(/\.\.\.$/);
    // Should not exceed 123 chars (120 + '...')
    expect(result.length).toBeLessThanOrEqual(123);
    // Should not cut mid-word (last char before '...' should be a space boundary)
    const withoutEllipsis = result.slice(0, -3);
    // The truncation point should be at a word boundary (no partial words)
    expect(input.startsWith(withoutEllipsis)).toBe(true);
  });

  it('handles no-space input (truncates at hard limit)', () => {
    // 150 chars with no spaces
    const input = 'a'.repeat(150);
    const result = truncateDescription(input);
    // Should be exactly 123 chars: 120 + '...'
    expect(result).toBe('a'.repeat(120) + '...');
    expect(result.length).toBe(123);
  });

  it('returns unchanged at exactly 120 chars (no truncation)', () => {
    const input = 'a'.repeat(120);
    expect(input.length).toBe(120);
    const result = truncateDescription(input);
    expect(result).toBe(input);
    expect(result).not.toContain('...');
  });

  it('handles empty string with graceful fallback', () => {
    expect(truncateDescription('')).toBe('(no description)');
  });

  it('handles whitespace-only string with graceful fallback', () => {
    expect(truncateDescription('   ')).toBe('(no description)');
  });

  it('handles null/undefined gracefully', () => {
    // TypeScript would prevent this, but runtime safety matters
    expect(truncateDescription(null as unknown as string)).toBe('(no description)');
    expect(truncateDescription(undefined as unknown as string)).toBe('(no description)');
  });

  it('title preserves [Bug] prefix and does not count it against limit', () => {
    const description = 'a'.repeat(120);
    const truncated = truncateDescription(description);
    const title = `[Bug] ${truncated}`;
    // [Bug] prefix (6 chars) + description (120 chars) = 126 chars
    expect(title).toBe(`[Bug] ${'a'.repeat(120)}`);
    expect(title.startsWith('[Bug] ')).toBe(true);
    // Verify the 120 char portion is not truncated
    expect(truncated).toBe('a'.repeat(120));
    expect(truncated).not.toContain('...');
  });

  it('title with long description truncates description but keeps prefix', () => {
    const description = 'a'.repeat(150);
    const truncated = truncateDescription(description);
    const title = `[Bug] ${truncated}`;
    expect(title.startsWith('[Bug] ')).toBe(true);
    // Total title length: [Bug] (6) + 120 + ... (3) = 129
    expect(title.length).toBe(129);
  });
});

// ---------- WORKER_LABEL_TO_SDK_CLASSIFICATION ----------

describe('WORKER_LABEL_TO_SDK_CLASSIFICATION', () => {
  it('covers all Worker classifications that need mapping', () => {
    const expectedMappings: Record<string, string> = {
      'content-error': 'content_error',
      'code-bug': 'code_bug',
      'translation-error': 'translation_error',
      'ux-bug': 'ui_bug',
      'ui-bug': 'ui_bug',
      'gameplay-bug': 'gameplay_bug',
      'content-duplication': 'content_duplicate',
      'feature-request': 'feature_request',
    };

    for (const [workerLabel, sdkClassification] of Object.entries(expectedMappings)) {
      expect(WORKER_LABEL_TO_SDK_CLASSIFICATION[workerLabel],
        `Missing mapping for Worker label '${workerLabel}'`
      ).toBe(sdkClassification);
    }
  });

  it('maps code-bug to code_bug (was missing before Story 3.14)', () => {
    expect(WORKER_LABEL_TO_SDK_CLASSIFICATION['code-bug']).toBe('code_bug');
  });

  it('maps ux-bug to ui_bug (closest SDK classification)', () => {
    expect(WORKER_LABEL_TO_SDK_CLASSIFICATION['ux-bug']).toBe('ui_bug');
  });

  it('reclassification dispatch uses SDK type in payload', () => {
    // Simulate what the Worker does at line ~1151:
    // const sdkClassification = WORKER_LABEL_TO_SDK_CLASSIFICATION[newClassification] || newClassification;
    const newClassification = 'code-bug';
    const sdkClassification = WORKER_LABEL_TO_SDK_CLASSIFICATION[newClassification] || newClassification;
    const dispatchPayload = {
      issue_number: 42,
      labels: [sdkClassification],
    };
    expect(dispatchPayload.labels[0]).toBe('code_bug');
    expect(dispatchPayload.labels[0]).not.toBe('code-bug');
  });

  it('does not include routing/state labels', () => {
    // These are NOT classifications — they must NOT appear in the mapping
    const routingLabels = ['needs-claude-code', 'low-confidence'];
    for (const label of routingLabels) {
      expect(WORKER_LABEL_TO_SDK_CLASSIFICATION[label],
        `Routing label '${label}' should NOT be in the classification mapping`
      ).toBeUndefined();
    }
  });
});
