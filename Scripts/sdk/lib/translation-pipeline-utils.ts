/**
 * Story 2.4b: Translation Pipeline Utility Functions
 *
 * Shared helpers for the translation verification/fix pipeline:
 *
 * - validateTranslationFixVersion (FR24/FR42): Validates that the fixer correctly
 *   sets `baseEnVersion` to match English source and increments `version`.
 *
 * - validateTranslationFilePath (FR45): Validates that a fix only modifies files
 *   within `Data/events/<lang>/` directories — no Swift, no root content.
 *
 * - validateTranslationJsonStructure (FR40/AC8): Validates JSON structural
 *   integrity of a translation file — required fields, correct types.
 *
 * - checkDiacriticsPreservation (AC3/AC6): Validates that Portuguese diacritics
 *   density has not decreased after a fixer write.
 *
 * - runTranslationRetryCheck (FR27/AC7): Determines whether a translation
 *   re-verification failure should be retried (max 2 attempts).
 */

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** A single translated event from a category file */
export interface TranslationEvent {
  title: string;
  year: number;
  description: string;
  category: string;
  difficulty: number;
  version: number;
  baseEnVersion: number;
  imageURL?: string | null;
  month?: number;
  day?: number;
  id?: string;
}

/** Result of version validation */
export interface VersionValidationResult {
  valid: boolean;
  versionIncremented: boolean;
  baseEnVersionMatches: boolean;
  details: string;
}

/** Result of file path validation */
export interface FilePathValidationResult {
  valid: boolean;
  invalidPaths: string[];
  details: string;
}

/** Result of JSON structural validation */
export interface StructuralValidationResult {
  valid: boolean;
  errors: string[];
}

/** Result of diacritics preservation check */
export interface DiacriticsCheckResult {
  passed: boolean;
  beforeDensity: number;
  afterDensity: number;
  densityDecreased: boolean;
  details: string;
}

/** Result of retry decision */
export interface RetryDecision {
  shouldRetry: boolean;
  attempt: number;
  maxAttempts: number;
  escalate: boolean;
  reason: string;
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** Maximum retry attempts for translation re-verification (FR27) */
export const MAX_TRANSLATION_RETRY_ATTEMPTS = 2;

/** Allowed translation file path prefix */
const TRANSLATION_PATH_PREFIX = "Data/events/";

/** Known translation language codes */
const TRANSLATION_LANG_CODES = new Set(["de", "nl", "pt", "es", "es-419", "fr"]);

/** Required fields for a translation event */
const REQUIRED_EVENT_FIELDS: Array<{ name: string; type: string }> = [
  { name: "title", type: "string" },
  { name: "year", type: "number" },
  { name: "description", type: "string" },
  { name: "category", type: "string" },
  { name: "difficulty", type: "number" },
  { name: "version", type: "number" },
  { name: "baseEnVersion", type: "number" },
];

// ------------------------------------------------------------------
// FR24 / FR42: Version Validation
// ------------------------------------------------------------------

/**
 * Validate that the fixer correctly updated version fields on a translation event.
 *
 * FR24: `baseEnVersion` must match the current English source `version`.
 * FR42: `version` must be incremented (previous + 1).
 *
 * @param fixedEvent - The event after the fixer ran
 * @param previousVersion - The version before the fix
 * @param currentEnglishVersion - The current English source version
 */
export function validateTranslationFixVersion(
  fixedEvent: TranslationEvent,
  previousVersion: number,
  currentEnglishVersion: number,
): VersionValidationResult {
  const versionIncremented = fixedEvent.version === previousVersion + 1;
  const baseEnVersionMatches = fixedEvent.baseEnVersion === currentEnglishVersion;
  const valid = versionIncremented && baseEnVersionMatches;

  const details: string[] = [];

  if (!versionIncremented) {
    details.push(
      "version not incremented: expected " + (previousVersion + 1) +
      ", got " + fixedEvent.version,
    );
  }

  if (!baseEnVersionMatches) {
    details.push(
      "baseEnVersion mismatch: expected " + currentEnglishVersion +
      " (current English version), got " + fixedEvent.baseEnVersion,
    );
  }

  if (valid) {
    details.push(
      "version correctly incremented to " + fixedEvent.version +
      ", baseEnVersion correctly set to " + fixedEvent.baseEnVersion,
    );
  }

  return {
    valid,
    versionIncremented,
    baseEnVersionMatches,
    details: details.join("; "),
  };
}

// ------------------------------------------------------------------
// FR45: File Path Validation for Translation Fixes
// ------------------------------------------------------------------

/**
 * Validate that a translation fix only modifies files within
 * `Data/events/<lang>/` directories.
 *
 * Translation fixes must NOT modify:
 * - Swift files (*.swift)
 * - Root content files (Data/events/*.json without a lang subdirectory)
 * - Any file outside Data/events/<lang>/
 *
 * @param filePaths - List of file paths from the diff
 */
export function validateTranslationFilePaths(
  filePaths: string[],
): FilePathValidationResult {
  const invalidPaths: string[] = [];

  for (const filePath of filePaths) {
    // Must start with Data/events/
    if (!filePath.startsWith(TRANSLATION_PATH_PREFIX)) {
      invalidPaths.push(filePath);
      continue;
    }

    // Extract the segment after Data/events/
    const remainder = filePath.slice(TRANSLATION_PATH_PREFIX.length);

    // Must have a language subdirectory: <lang>/filename.json
    const segments = remainder.split("/");
    if (segments.length < 2) {
      // No language subdirectory (e.g., Data/events/USHistory.json is English root)
      invalidPaths.push(filePath);
      continue;
    }

    const langCode = segments[0];
    if (!TRANSLATION_LANG_CODES.has(langCode)) {
      invalidPaths.push(filePath);
      continue;
    }

    // Must be a .json file
    if (!filePath.endsWith(".json")) {
      invalidPaths.push(filePath);
      continue;
    }
  }

  const valid = invalidPaths.length === 0 && filePaths.length > 0;

  let details: string;
  if (valid) {
    details = "All " + filePaths.length + " files are within translation directories";
  } else if (filePaths.length === 0) {
    details = "No files in diff";
  } else {
    details = "Invalid paths: " + invalidPaths.join(", ");
  }

  return { valid, invalidPaths, details };
}

// ------------------------------------------------------------------
// FR40 / AC8: JSON Structural Validation
// ------------------------------------------------------------------

/**
 * Validate JSON structural integrity of a translation file.
 *
 * Checks:
 * 1. Valid JSON (can be parsed)
 * 2. Has `events` array
 * 3. Each event has all required fields with correct types
 * 4. `version` and `baseEnVersion` are positive integers
 *
 * @param jsonString - The raw JSON string to validate
 */
export function validateTranslationJsonStructure(
  jsonString: string,
): StructuralValidationResult {
  const errors: string[] = [];

  // Check 1: Valid JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, errors: ["Invalid JSON: " + msg] };
  }

  // Check 2: Has events array
  if (typeof parsed !== "object" || parsed === null) {
    return { valid: false, errors: ["Root must be an object"] };
  }

  const data = parsed as Record<string, unknown>;
  if (!Array.isArray(data.events)) {
    return { valid: false, errors: ["Missing or non-array 'events' field"] };
  }

  // Check 3-4: Validate each event
  const events = data.events as unknown[];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (typeof event !== "object" || event === null) {
      errors.push("Event at index " + i + " is not an object");
      continue;
    }

    const eventObj = event as Record<string, unknown>;

    for (const field of REQUIRED_EVENT_FIELDS) {
      if (!(field.name in eventObj)) {
        errors.push("Event at index " + i + " missing required field: " + field.name);
      } else if (typeof eventObj[field.name] !== field.type) {
        errors.push(
          "Event at index " + i + " field '" + field.name +
          "' has wrong type: expected " + field.type +
          ", got " + typeof eventObj[field.name],
        );
      }
    }

    // Version fields must be positive integers
    if (typeof eventObj.version === "number") {
      if (!Number.isInteger(eventObj.version) || eventObj.version < 1) {
        errors.push("Event at index " + i + " version must be a positive integer, got " + eventObj.version);
      }
    }

    if (typeof eventObj.baseEnVersion === "number") {
      if (!Number.isInteger(eventObj.baseEnVersion) || eventObj.baseEnVersion < 1) {
        errors.push("Event at index " + i + " baseEnVersion must be a positive integer, got " + eventObj.baseEnVersion);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ------------------------------------------------------------------
// AC3 / AC6: Diacritics Preservation Check
// ------------------------------------------------------------------

/**
 * Check whether a fixer write preserved Portuguese diacritics.
 *
 * Compares diacritics density (diacritics per character) before and after
 * the write. If density decreased, the write should be rejected.
 *
 * AC3: PostToolUse hook validates diacritics density has not decreased.
 * AC6: If density decreases after retry, escalate with needs-human-review.
 *
 * @param beforeText - The text before the fixer write
 * @param afterText - The text after the fixer write
 */
export function checkDiacriticsPreservation(
  beforeText: string,
  afterText: string,
): DiacriticsCheckResult {
  const beforeCount = countPortugueseDiacritics(beforeText);
  const afterCount = countPortugueseDiacritics(afterText);

  const beforeDensity = beforeText.length > 0 ? beforeCount / beforeText.length : 0;
  const afterDensity = afterText.length > 0 ? afterCount / afterText.length : 0;

  const densityDecreased = afterDensity < beforeDensity;
  const passed = !densityDecreased;

  let details: string;
  if (passed) {
    details = "Diacritics preserved: before=" + (beforeDensity * 100).toFixed(2) +
      "%, after=" + (afterDensity * 100).toFixed(2) + "%";
  } else {
    details = "Diacritics density DECREASED: before=" + (beforeDensity * 100).toFixed(2) +
      "% (" + beforeCount + " diacritics), after=" + (afterDensity * 100).toFixed(2) +
      "% (" + afterCount + " diacritics). Write should be rejected.";
  }

  return {
    passed,
    beforeDensity,
    afterDensity,
    densityDecreased,
    details,
  };
}

/** Count diacritics characters commonly used in Portuguese */
function countPortugueseDiacritics(text: string): number {
  // Common Portuguese diacritics: accented vowels, cedilla, tilde
  const diacriticsRegex = /[\u00C0-\u00FF\u0100-\u017F]/g;
  const matches = text.match(diacriticsRegex);
  return matches ? matches.length : 0;
}

// ------------------------------------------------------------------
// FR27 / AC7: Translation Retry Decision
// ------------------------------------------------------------------

/**
 * Determine whether a translation re-verification failure should be retried.
 *
 * FR27: Max 2 retry attempts for translation fixes.
 * After max attempts, escalate with needs-human-review.
 *
 * @param currentAttempt - The current attempt number (1-based)
 */
export function makeTranslationRetryDecision(
  currentAttempt: number,
): RetryDecision {
  const shouldRetry = currentAttempt < MAX_TRANSLATION_RETRY_ATTEMPTS;
  const escalate = !shouldRetry;

  let reason: string;
  if (shouldRetry) {
    reason = "Re-verification failed on attempt " + currentAttempt +
      " of " + MAX_TRANSLATION_RETRY_ATTEMPTS + ". Retrying with context from previous failure.";
  } else {
    reason = "All " + MAX_TRANSLATION_RETRY_ATTEMPTS +
      " translation fix attempts exhausted. Escalating with needs-human-review.";
  }

  return {
    shouldRetry,
    attempt: currentAttempt,
    maxAttempts: MAX_TRANSLATION_RETRY_ATTEMPTS,
    escalate,
    reason,
  };
}
