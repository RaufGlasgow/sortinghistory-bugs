/**
 * Story PV2-2.2: Quality Gate (Programmatic Diff Analysis)
 *
 * Performs programmatic checks on a git diff before PR creation.
 * Pure string/pattern matching — no AI needed.
 *
 * Checks:
 * 1. No build artifacts (DerivedData/, .build/, *.o, *.dSYM, *.app)
 * 2. No temp files (*.tmp, *.swp, .DS_Store, xcuserdata/)
 * 3. No automation files (.github/, Scripts/, *.yml, *.yaml, *.ts, *.js)
 * 4. Diff proportionality (total lines < configurable max, default 500)
 * 5. No binary files detected in diff
 * 6. Only allowed extensions present
 */
import node_path from "node:path";
// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------
const DEFAULT_MAX_DIFF_LINES = 1500;
const DEFAULT_ALLOWED_EXTENSIONS = [
    ".swift",
    ".json",
    ".strings",
    ".md",
    ".pbxproj",
    ".plist",
    ".xcscheme",
];
// ------------------------------------------------------------------
// Pattern definitions
// ------------------------------------------------------------------
/** Path substrings that indicate build artifacts */
const BUILD_ARTIFACT_PATTERNS = [
    "DerivedData/",
    ".build/",
    ".dSYM/",
];
/** File extensions that indicate build artifacts */
const BUILD_ARTIFACT_EXTENSIONS = new Set([
    ".o",
    ".dSYM",
    ".app",
]);
/** Path substrings that indicate temp files */
const TEMP_FILE_PATTERNS = [
    "xcuserdata/",
];
/** File names that indicate temp files */
const TEMP_FILE_NAMES = new Set([
    ".DS_Store",
]);
/** File extensions that indicate temp files */
const TEMP_FILE_EXTENSIONS = new Set([
    ".tmp",
    ".swp",
]);
/** Path substrings that indicate automation files */
const AUTOMATION_PATH_PATTERNS = [
    ".github/",
    "Scripts/",
    "node_modules/",
];
/** File extensions that indicate automation files */
const AUTOMATION_EXTENSIONS = new Set([
    ".yml",
    ".yaml",
    ".ts",
    ".js",
]);
// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
/**
 * Get the file extension from a path, including the leading dot.
 * Returns empty string if no extension found.
 */
function getExtension(filePath) {
    const ext = node_path.extname(filePath);
    return ext;
}
/**
 * Get the basename from a file path.
 */
function getBasename(filePath) {
    return node_path.basename(filePath);
}
// ------------------------------------------------------------------
// Individual checks
// ------------------------------------------------------------------
/**
 * Check 1: No build artifacts
 * Matches DerivedData/, .build/, *.o, *.dSYM, *.app
 */
function checkNoBuildArtifacts(changedFiles) {
    const offending = [];
    for (const file of changedFiles) {
        // Check path-based patterns
        for (const pattern of BUILD_ARTIFACT_PATTERNS) {
            if (file.includes(pattern)) {
                offending.push(file);
                break;
            }
        }
        // Check extension-based patterns (only if not already flagged)
        if (!offending.includes(file)) {
            const ext = getExtension(file);
            if (BUILD_ARTIFACT_EXTENSIONS.has(ext)) {
                offending.push(file);
            }
        }
    }
    if (offending.length === 0)
        return null;
    return {
        check: "no_build_artifacts",
        description: "Diff contains build artifacts that must not be committed",
        offendingPaths: offending,
    };
}
/**
 * Check 2: No temp files
 * Matches *.tmp, *.swp, .DS_Store, xcuserdata/
 */
function checkNoTempFiles(changedFiles) {
    const offending = [];
    for (const file of changedFiles) {
        // Check path-based patterns
        let matched = false;
        for (const pattern of TEMP_FILE_PATTERNS) {
            if (file.includes(pattern)) {
                offending.push(file);
                matched = true;
                break;
            }
        }
        if (matched)
            continue;
        // Check file name matches
        const basename = getBasename(file);
        if (TEMP_FILE_NAMES.has(basename)) {
            offending.push(file);
            continue;
        }
        // Check extension-based patterns
        const ext = getExtension(file);
        if (TEMP_FILE_EXTENSIONS.has(ext)) {
            offending.push(file);
        }
    }
    if (offending.length === 0)
        return null;
    return {
        check: "no_temp_files",
        description: "Diff contains temporary files that must not be committed",
        offendingPaths: offending,
    };
}
/**
 * Check 3: No automation files
 * Matches .github/, Scripts/, *.yml, *.yaml, *.ts, *.js
 */
function checkNoAutomationFiles(changedFiles) {
    const offending = [];
    for (const file of changedFiles) {
        // Check path-based patterns
        let matched = false;
        for (const pattern of AUTOMATION_PATH_PATTERNS) {
            if (file.includes(pattern)) {
                offending.push(file);
                matched = true;
                break;
            }
        }
        if (matched)
            continue;
        // Check extension-based patterns
        const ext = getExtension(file);
        if (AUTOMATION_EXTENSIONS.has(ext)) {
            offending.push(file);
        }
    }
    if (offending.length === 0)
        return null;
    return {
        check: "no_automation_files",
        description: "Diff contains automation/infrastructure files that must not be in a bug-fix PR",
        offendingPaths: offending,
    };
}
/**
 * Check 4: Diff proportionality
 * Total diff lines must be under the configured maximum.
 */
function checkDiffProportionality(diff, maxLines) {
    // Count non-empty lines in the diff
    const lineCount = diff.split("\n").length;
    if (lineCount <= maxLines)
        return null;
    return {
        check: "diff_proportionality",
        description: "Diff is too large (" +
            lineCount +
            " lines, maximum " +
            maxLines +
            ")",
        offendingPaths: [],
    };
}
/**
 * Check 5: No binary files in diff
 * Looks for "Binary files" markers in git diff output.
 */
function checkNoBinaryFiles(diff) {
    // git diff outputs lines like:
    //   "Binary files a/path/to/file and b/path/to/file differ"
    //   "Binary files /dev/null and b/path/to/file differ"
    const binaryPattern = /^Binary files .+ and (.+) differ$/gm;
    const offending = [];
    let match;
    while ((match = binaryPattern.exec(diff)) !== null) {
        let filePath = match[1].trim();
        // Strip the "b/" prefix that git diff uses
        if (filePath.startsWith("b/")) {
            filePath = filePath.slice(2);
        }
        offending.push(filePath);
    }
    if (offending.length === 0)
        return null;
    return {
        check: "no_binary_files",
        description: "Diff contains binary files that should not be in a bug-fix PR",
        offendingPaths: offending,
    };
}
/**
 * Check 6: Only allowed extensions
 * Every changed file must have an extension in the allowed set.
 */
function checkAllowedExtensions(changedFiles, allowedExtensions) {
    const offending = [];
    for (const file of changedFiles) {
        const ext = getExtension(file);
        if (!ext) {
            // Files with no extension are not allowed
            offending.push(file);
            continue;
        }
        if (!allowedExtensions.has(ext)) {
            offending.push(file);
        }
    }
    if (offending.length === 0)
        return null;
    return {
        check: "allowed_extensions_only",
        description: "Diff contains files with disallowed extensions",
        offendingPaths: offending,
    };
}
// ------------------------------------------------------------------
// Main entry point
// ------------------------------------------------------------------
/**
 * Run all quality gate checks on a diff and list of changed files.
 *
 * @param diff - The raw `git diff` output string
 * @param changedFiles - Array of file paths that were changed
 * @param config - Optional partial config to override defaults
 * @returns QualityGateResult with pass/fail and any failures
 */
export function runQualityGate(diff, changedFiles, config) {
    const maxDiffLines = config?.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES;
    const allowedExtensions = new Set(config?.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS);
    const failures = [];
    // Run all checks and collect failures
    const buildArtifactResult = checkNoBuildArtifacts(changedFiles);
    if (buildArtifactResult)
        failures.push(buildArtifactResult);
    const tempFileResult = checkNoTempFiles(changedFiles);
    if (tempFileResult)
        failures.push(tempFileResult);
    const automationResult = checkNoAutomationFiles(changedFiles);
    if (automationResult)
        failures.push(automationResult);
    const proportionalityResult = checkDiffProportionality(diff, maxDiffLines);
    if (proportionalityResult)
        failures.push(proportionalityResult);
    const binaryResult = checkNoBinaryFiles(diff);
    if (binaryResult)
        failures.push(binaryResult);
    const extensionResult = checkAllowedExtensions(changedFiles, allowedExtensions);
    if (extensionResult)
        failures.push(extensionResult);
    return {
        passed: failures.length === 0,
        failures,
    };
}
