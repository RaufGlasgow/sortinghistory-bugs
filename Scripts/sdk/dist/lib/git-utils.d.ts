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
export interface SafeGitAddResult {
    /** Files that were staged successfully */
    staged: string[];
    /** Files that were excluded (with reason) */
    excluded: {
        file: string;
        reason: string;
    }[];
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
export declare function safeGitAdd(cwd: string): SafeGitAddResult;
