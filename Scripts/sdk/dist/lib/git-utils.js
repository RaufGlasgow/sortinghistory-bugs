/**
 * Story PV2-1.3: Safe Git Add
 *
 * Replaces dangerous `git add -A` with a filtered staging function
 * that only stages files matching allowed extensions and rejects
 * paths matching exclusion patterns (DerivedData, .build, etc.).
 *
 * This prevents build artifacts from being committed into PRs
 * (the root cause of PR #90 containing DerivedData files).
 */
import { execSync } from "node:child_process";
// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------
/** File extensions that are safe to stage */
const ALLOWED_EXTENSIONS = new Set([
    ".swift",
    ".json",
    ".strings",
    ".md",
    ".plist",
    ".pbxproj",
    ".xcscheme",
]);
/** Path patterns that must NEVER be staged (matched as substrings) */
const EXCLUSION_PATTERNS = [
    "DerivedData/",
    ".build/",
    ".dSYM/",
    "xcuserdata/",
    "node_modules/",
    ".DS_Store",
];
/** File extensions that must NEVER be staged */
const EXCLUDED_EXTENSIONS = new Set([
    ".o",
    ".dSYM",
]);
// ------------------------------------------------------------------
// Implementation
// ------------------------------------------------------------------
/**
 * Get the file extension from a path, including the leading dot.
 * Returns empty string if no extension found.
 */
function getExtension(filePath) {
    const basename = filePath.split("/").pop() ?? filePath;
    const dotIndex = basename.lastIndexOf(".");
    if (dotIndex <= 0)
        return "";
    return basename.slice(dotIndex);
}
/**
 * Check if a file path matches any exclusion pattern.
 * Returns the matched pattern or null.
 */
function matchesExclusion(filePath) {
    // Check path-based exclusions (substring match)
    for (const pattern of EXCLUSION_PATTERNS) {
        if (filePath.includes(pattern)) {
            return pattern;
        }
    }
    // Check extension-based exclusions
    const ext = getExtension(filePath);
    if (EXCLUDED_EXTENSIONS.has(ext)) {
        return ext;
    }
    // Check if the filename itself is an excluded pattern (e.g., ".DS_Store")
    const basename = filePath.split("/").pop() ?? filePath;
    for (const pattern of EXCLUSION_PATTERNS) {
        if (basename === pattern) {
            return pattern;
        }
    }
    return null;
}
/**
 * Check if a file has an allowed extension.
 */
function hasAllowedExtension(filePath) {
    const ext = getExtension(filePath);
    return ALLOWED_EXTENSIONS.has(ext);
}
/**
 * Safely stage changed files, filtering by allowed extensions
 * and rejecting excluded path patterns.
 *
 * Uses `git status --porcelain` to discover all changed/untracked files,
 * then filters and stages each one individually with `git add`.
 *
 * @param cwd - Working directory (repo root)
 * @returns Object with arrays of staged and excluded files
 */
export function safeGitAdd(cwd) {
    const staged = [];
    const excluded = [];
    // Get all changed and untracked files via porcelain output
    // Format: XY filename (or XY original -> renamed)
    let porcelainOutput;
    try {
        porcelainOutput = execSync("git status --porcelain", {
            cwd,
            encoding: "utf-8",
        }).trim();
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[git-utils] Failed to run git status: " + errMsg);
        return { staged, excluded };
    }
    if (!porcelainOutput) {
        console.log("[git-utils] No changed files detected");
        return { staged, excluded };
    }
    // Parse porcelain output lines
    const lines = porcelainOutput.split("\n");
    const changedFiles = [];
    for (const line of lines) {
        if (line.length < 3)
            continue;
        // Porcelain format: XY filename
        // For renames: XY original -> renamed
        let filePath = line.slice(3);
        // Handle renames (R  old -> new)
        if (filePath.includes(" -> ")) {
            filePath = filePath.split(" -> ").pop();
        }
        // Trim any surrounding whitespace/quotes
        filePath = filePath.trim().replace(/^"(.*)"$/, "$1");
        if (filePath) {
            changedFiles.push(filePath);
        }
    }
    console.log("[git-utils] Found " + changedFiles.length + " changed file(s)");
    // Filter and stage
    for (const file of changedFiles) {
        // Check exclusions first
        const exclusionMatch = matchesExclusion(file);
        if (exclusionMatch) {
            excluded.push({ file, reason: "excluded pattern: " + exclusionMatch });
            console.log("[git-utils] EXCLUDED: " + file + " (matches " + exclusionMatch + ")");
            continue;
        }
        // Check if extension is allowed
        if (!hasAllowedExtension(file)) {
            const ext = getExtension(file) || "(no extension)";
            excluded.push({ file, reason: "extension not allowed: " + ext });
            console.log("[git-utils] EXCLUDED: " + file + " (extension " + ext + " not in allowlist)");
            continue;
        }
        // Stage the file
        try {
            execSync("git add -- " + JSON.stringify(file), {
                cwd,
                encoding: "utf-8",
            });
            staged.push(file);
            console.log("[git-utils] STAGED: " + file);
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            excluded.push({ file, reason: "git add failed: " + errMsg });
            console.error("[git-utils] FAILED to stage: " + file + " -- " + errMsg);
        }
    }
    console.log("[git-utils] Summary: " +
        staged.length +
        " staged, " +
        excluded.length +
        " excluded");
    return { staged, excluded };
}
