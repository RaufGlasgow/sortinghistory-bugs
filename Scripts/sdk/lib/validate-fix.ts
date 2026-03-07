import { readFileSync } from "node:fs";

/**
 * validate-fix.ts — Pre-PR validation gate for pipeline-generated fixes.
 *
 * Pure computation: reads issue data + diff file, returns a structured result.
 * NO state-mutating GitHub API calls (AC13). Read-only API calls are OK.
 *
 * Architecture ref: Section 5.3, lines 362-399
 * Story: 2.0b
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structured validation result (AC7) */
export interface ValidationResult {
  valid: boolean;
  reason?: string;
  details?: string;
}

/** Issue data needed for validation (fetched by caller or passed directly) */
export interface IssueData {
  number: number;
  body: string;
  labels: string[];
}

/** Parsed diff information */
export interface DiffInfo {
  files: string[];
  raw: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Allowed file extensions for content/translation fixes */
const ALLOWED_EXTENSIONS = [".json"];

/** Known locale codes used in file paths */
const ALL_LOCALE_CODES = ["en", "de", "fr", "nl", "pt", "es", "es-419"];

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Parse a unified diff file and extract the list of changed file paths.
 * Supports standard `diff --git a/path b/path` format and `--- a/path` / `+++ b/path`.
 */
export function parseDiffFiles(diffContent: string): string[] {
  const files: string[] = [];
  const lines = diffContent.split("\n");

  for (const line of lines) {
    // Match: diff --git a/some/path b/some/path
    const gitDiffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitDiffMatch) {
      const filePath = gitDiffMatch[2];
      if (!files.includes(filePath)) {
        files.push(filePath);
      }
    }
  }

  // Fallback: if no git diff headers found, try +++ b/ lines
  if (files.length === 0) {
    for (const line of lines) {
      const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);
      if (plusMatch) {
        const filePath = plusMatch[1];
        if (!files.includes(filePath)) {
          files.push(filePath);
        }
      }
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

/**
 * Extract the language code from issue labels.
 * Looks for labels matching `lang:XX` pattern (e.g., `lang:de`, `lang:es-419`).
 */
export function extractLangLabel(labels: string[]): string | null {
  for (const label of labels) {
    const match = label.match(/^lang:(.+)$/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Determine bug type from issue labels.
 * Returns "content-error", "translation-error", or null if neither.
 */
export function extractBugType(labels: string[]): "content-error" | "translation-error" | null {
  for (const label of labels) {
    if (label === "content-error") return "content-error";
    if (label === "translation-error") return "translation-error";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation checks
// ---------------------------------------------------------------------------

/**
 * AC3: Language gate — diff must only modify files matching the issue's lang:XX label.
 * For content-error: skip if no lang label (AC11).
 * For translation-error: fail if no lang label (AC12).
 */
function checkLanguageMatch(
  bugType: "content-error" | "translation-error",
  langCode: string | null,
  files: string[],
): ValidationResult {
  // AC12: translation-error requires a lang label
  if (bugType === "translation-error" && !langCode) {
    return {
      valid: false,
      reason: "missing-language-label",
      details: "Translation-error issues require a lang:XX label but none was found.",
    };
  }

  // AC11: content-error without lang label — skip check
  if (!langCode) {
    return { valid: true };
  }

  // Check each file belongs to the expected language path
  const wrongFiles: string[] = [];
  for (const file of files) {
    // A file matches the language if it contains /langCode/ or starts with langCode/
    // or contains /langCode.json or langCode.lproj/
    const matchesLang =
      file.includes("/" + langCode + "/") ||
      file.startsWith(langCode + "/") ||
      file.includes("/" + langCode + ".json") ||
      file.endsWith("/" + langCode + ".json") ||
      file === langCode + ".json" ||
      file.includes(langCode + ".lproj/");

    // For content-error, files in Data/ root (no locale path) are also OK
    const isRootContentFile =
      bugType === "content-error" &&
      !ALL_LOCALE_CODES.some(
        (code) =>
          file.includes("/" + code + "/") ||
          file.startsWith(code + "/") ||
          file.includes(code + ".lproj/"),
      );

    if (!matchesLang && !isRootContentFile) {
      wrongFiles.push(file);
    }
  }

  if (wrongFiles.length > 0) {
    return {
      valid: false,
      reason: "language-mismatch",
      details:
        "Expected changes in " +
        langCode +
        " paths only. Files outside scope: " +
        wrongFiles.join(", "),
    };
  }

  return { valid: true };
}

/**
 * AC4: Diff-vs-claim check — diff must modify content relevant to issue description.
 * Extracts identifiers (event IDs, key names) from issue body and checks the diff touches them.
 *
 * This is a heuristic check — looks for numeric IDs and quoted strings mentioned in the issue.
 */
function checkDiffVsClaim(issueBody: string, diffContent: string, files: string[]): ValidationResult {
  // Extract potential event IDs from issue body (numbers that look like IDs)
  // Common patterns: "event 42", "event_id: 42", "#42", "ID 42"
  const idMatches = issueBody.match(/(?:event|id|event_id|#)\s*[:=]?\s*(\d+)/gi);
  const claimedIds: string[] = [];
  if (idMatches) {
    for (const m of idMatches) {
      const numMatch = m.match(/(\d+)/);
      if (numMatch) {
        claimedIds.push(numMatch[1]);
      }
    }
  }

  // Extract quoted key names from issue body (e.g., "wrong_key", 'bad_value')
  const quotedMatches = issueBody.match(/["'`]([a-zA-Z0-9_.-]+)["'`]/g);
  const claimedKeys: string[] = [];
  if (quotedMatches) {
    for (const q of quotedMatches) {
      // Strip quotes
      claimedKeys.push(q.slice(1, -1));
    }
  }

  // If no identifiable claims in the issue body, skip this check
  if (claimedIds.length === 0 && claimedKeys.length === 0) {
    return { valid: true };
  }

  // Check if the diff content references any of the claimed IDs or keys
  let foundMatch = false;

  for (const id of claimedIds) {
    if (diffContent.includes(id)) {
      foundMatch = true;
      break;
    }
  }

  if (!foundMatch) {
    for (const key of claimedKeys) {
      if (diffContent.includes(key)) {
        foundMatch = true;
        break;
      }
    }
  }

  if (!foundMatch) {
    const claimed = [...claimedIds, ...claimedKeys].join(", ");
    return {
      valid: false,
      reason: "diff-claim-mismatch",
      details:
        "Issue references [" +
        claimed +
        "] but diff does not modify any matching content. " +
        "Files changed: " +
        files.join(", "),
    };
  }

  return { valid: true };
}

/**
 * AC5: File type gate — only .json content files allowed.
 * Rejects .ts, .swift, .yml, .md, or any non-content file.
 */
function checkFileTypes(files: string[]): ValidationResult {
  const forbidden: string[] = [];

  for (const file of files) {
    const ext = "." + file.split(".").pop();
    if (!ALLOWED_EXTENSIONS.includes(ext.toLowerCase())) {
      forbidden.push(file);
    }
  }

  if (forbidden.length > 0) {
    return {
      valid: false,
      reason: "forbidden-file-type",
      details:
        "Only .json content files are allowed. Forbidden files: " +
        forbidden.join(", "),
    };
  }

  return { valid: true };
}

/**
 * AC6: Empty diff detection.
 */
function checkEmptyDiff(files: string[], diffContent: string): ValidationResult {
  if (files.length === 0 || diffContent.trim().length === 0) {
    return {
      valid: false,
      reason: "empty-diff",
      details: "The diff is empty — no files were modified.",
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Main validation function (AC1, AC2)
// ---------------------------------------------------------------------------

/**
 * Validate a fix diff against the original issue before PR creation.
 *
 * AC1: Exported from Scripts/sdk/lib/validate-fix.ts
 * AC2: Accepts issueData (containing number, body, labels) and diffPath
 * AC13: Pure computation — no state-mutating GitHub API calls
 *
 * @param issueData - Issue details (number, body, labels). Caller fetches this.
 * @param diffPath - Local file path to the generated diff.
 * @returns Structured validation result.
 */
export function validateFix(issueData: IssueData, diffPath: string): ValidationResult {
  // Read the diff file
  let diffContent: string;
  try {
    diffContent = readFileSync(diffPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      reason: "diff-read-error",
      details: "Could not read diff file at " + diffPath + ": " + msg,
    };
  }

  // Parse files from diff
  const files = parseDiffFiles(diffContent);

  // AC6: Empty diff
  const emptyCheck = checkEmptyDiff(files, diffContent);
  if (!emptyCheck.valid) return emptyCheck;

  // Determine bug type
  const bugType = extractBugType(issueData.labels);
  if (!bugType) {
    // Validator only applies to content-error and translation-error
    return { valid: true };
  }

  // Extract language label
  const langCode = extractLangLabel(issueData.labels);

  // AC3: Language gate
  const langCheck = checkLanguageMatch(bugType, langCode, files);
  if (!langCheck.valid) return langCheck;

  // AC5: File type gate
  const fileTypeCheck = checkFileTypes(files);
  if (!fileTypeCheck.valid) return fileTypeCheck;

  // AC4: Diff-vs-claim
  const claimCheck = checkDiffVsClaim(issueData.body, diffContent, files);
  if (!claimCheck.valid) return claimCheck;

  // AC6: All checks passed
  return { valid: true };
}
