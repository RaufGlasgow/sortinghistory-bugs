/**
 * Shared utility functions for the bug-webhook Worker.
 * Extracted to enable unit testing (Story 3.14).
 */

// Truncate a description to maxLength characters, preferring word boundaries.
// Story 3.14: Increased from 50 to 120 chars. [Bug] prefix is NOT counted against the limit.
export function truncateDescription(description: string, maxLength: number = 120): string {
  if (!description || description.trim().length === 0) return '(no description)';
  if (description.length <= maxLength) return description;
  // Find last space before maxLength to avoid mid-word cut
  const truncated = description.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  // Only use word boundary if it preserves at least 70% of the allowed length
  if (lastSpace > maxLength * 0.7) {
    return truncated.slice(0, lastSpace) + '...';
  }
  return truncated + '...';
}

// SYNC REQUIRED: Every entry in sortinghistory-bugs/Scripts/sdk/config.ts CLASSIFICATIONS
// must have a corresponding entry here. See docs/architecture-automation-system.md Section 5.7a.
//
// Worker label (hyphenated) → SDK classification (underscored) mapping
// Used when constructing dispatch payloads so the SDK receives its canonical type.
// Worker labels are human-readable GitHub labels; SDK classifications are internal type identifiers.
export const WORKER_LABEL_TO_SDK_CLASSIFICATION: Record<string, string> = {
  'content-error': 'content_error',
  'content-category-error': 'content_category_error',
  'code-bug': 'code_bug',
  'translation-error': 'translation_error',
  'ux-bug': 'ui_bug',           // ux-bug maps to ui_bug (closest SDK classification)
  'ui-bug': 'ui_bug',
  'gameplay-bug': 'gameplay_bug',
  'content-duplication': 'content_duplicate',
  'feature-request': 'feature_request',
  'crash-bug': 'crash_bug',
  'purchase-error': 'purchase_error',
  'data-corruption': 'data_corruption',
  'multiplayer-error': 'multiplayer_error',
  'performance-issue': 'performance_issue',
  'needs-human-review': 'needs_human_review',
};
