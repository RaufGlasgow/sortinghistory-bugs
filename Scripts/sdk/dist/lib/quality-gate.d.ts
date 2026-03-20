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
export interface QualityGateConfig {
    /** Maximum number of lines allowed in the diff (default 500) */
    maxDiffLines: number;
    /** File extensions that are permitted in the diff (default: .swift, .json, .strings, .md, .pbxproj, .plist, .xcscheme) */
    allowedExtensions: string[];
}
export interface QualityFailure {
    /** Machine-readable check name, e.g. "no_build_artifacts" */
    check: string;
    /** Human-readable description of the failure */
    description: string;
    /** File paths that triggered this failure */
    offendingPaths: string[];
}
export interface QualityGateResult {
    /** True if all checks passed */
    passed: boolean;
    /** List of failures (empty when passed is true) */
    failures: QualityFailure[];
}
/**
 * Run all quality gate checks on a diff and list of changed files.
 *
 * @param diff - The raw `git diff` output string
 * @param changedFiles - Array of file paths that were changed
 * @param config - Optional partial config to override defaults
 * @returns QualityGateResult with pass/fail and any failures
 */
export declare function runQualityGate(diff: string, changedFiles: string[], config?: Partial<QualityGateConfig>): QualityGateResult;
