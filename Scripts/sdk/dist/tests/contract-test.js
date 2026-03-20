/**
 * Story 2.2: Classification-to-Route Contract Test (BA-011 FR8, FR20, NFR14)
 *
 * Verifies that EVERY classification in CLASSIFICATIONS has:
 *   1. A `case "X":` in routeByClassification() in routing.ts
 *   2. At least one fixture in routing-fixtures.ts with that classification
 *   3. A `### X` heading in bug-triager.md
 *   4. Triage validation via CLASSIFICATION_SET from config.ts (no hardcoded set)
 *
 * Reads SOURCE files (.ts and .md), not compiled JavaScript.
 * This means it catches issues before build — even if the code does not compile.
 *
 * Cost: $0.00 (pure file reads, no API calls)
 *
 * Exit codes:
 * - 0: All classifications pass the 4-file check (silent pass)
 * - 1: One or more classifications are missing from one or more files
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CLASSIFICATIONS } from "../config.js";
import { ROUTING_FIXTURES } from "./routing-fixtures.js";
// ---------------------------------------------------------------------------
// Resolve repo root
// ---------------------------------------------------------------------------
function resolveRepoRoot() {
    const envRoot = process.env.GITHUB_WORKSPACE ?? process.env.SDK_REPO_ROOT;
    if (envRoot)
        return envRoot;
    let root = process.cwd();
    if (root.includes(path.join("Scripts", "sdk"))) {
        root = root.split(path.join("Scripts", "sdk"))[0];
    }
    return root;
}
// ---------------------------------------------------------------------------
// Check 1: routing.ts has a `case "X":` for each classification
// ---------------------------------------------------------------------------
function checkRoutingCases(repoRoot) {
    const routingPath = path.join(repoRoot, "Scripts", "sdk", "lib", "routing.ts");
    const source = fs.readFileSync(routingPath, "utf-8");
    const missing = [];
    for (const cls of CLASSIFICATIONS) {
        // Match `case "classification_name":` in the switch statement
        const pattern = 'case "' + cls + '":';
        if (!source.includes(pattern)) {
            missing.push(cls);
        }
    }
    return missing;
}
// ---------------------------------------------------------------------------
// Check 2: routing-fixtures.ts has at least one fixture per classification
// ---------------------------------------------------------------------------
function checkRoutingFixtures() {
    const coveredClassifications = new Set();
    for (const fixture of ROUTING_FIXTURES) {
        coveredClassifications.add(fixture.input.classification);
    }
    const missing = [];
    for (const cls of CLASSIFICATIONS) {
        if (!coveredClassifications.has(cls)) {
            missing.push(cls);
        }
    }
    return missing;
}
// ---------------------------------------------------------------------------
// Check 3: bug-triager.md has a `### classification_name` heading per type
// ---------------------------------------------------------------------------
function checkPromptHeadings(repoRoot) {
    const promptPath = path.join(repoRoot, "Scripts", "sdk", "prompts", "bug-triager.md");
    const source = fs.readFileSync(promptPath, "utf-8");
    const missing = [];
    for (const cls of CLASSIFICATIONS) {
        // Match `### classification_name` as a markdown heading
        const pattern = "### " + cls;
        if (!source.includes(pattern)) {
            missing.push(cls);
        }
    }
    return missing;
}
// ---------------------------------------------------------------------------
// Check 4: bug-triage.ts uses CLASSIFICATION_SET from config.ts, not hardcoded
// ---------------------------------------------------------------------------
function checkTriageValidator(repoRoot) {
    const triagePath = path.join(repoRoot, "Scripts", "sdk", "workflows", "bug-triage.ts");
    const source = fs.readFileSync(triagePath, "utf-8");
    const errors = [];
    // Must import CLASSIFICATION_SET from config
    if (!source.includes("CLASSIFICATION_SET")) {
        errors.push("bug-triage.ts does not reference CLASSIFICATION_SET from config.ts");
    }
    // Must NOT have a hardcoded set of classifications (e.g. new Set(["content_error", ...]))
    // Check for inline Set construction with classification strings
    const hardcodedSetPattern = /new Set\(\s*\[\s*"(content_error|translation_error|ui_bug|gameplay_bug|feature_request|needs_human_review)/;
    if (hardcodedSetPattern.test(source)) {
        errors.push("bug-triage.ts contains a hardcoded classification set instead of using CLASSIFICATION_SET from config.ts");
    }
    return errors;
}
// ---------------------------------------------------------------------------
// Main — run all checks, report failures, exit 0 or 1
// ---------------------------------------------------------------------------
export function runContractTest() {
    const repoRoot = resolveRepoRoot();
    let hasFailure = false;
    // Check 1: routing cases
    const missingRoutes = checkRoutingCases(repoRoot);
    if (missingRoutes.length > 0) {
        hasFailure = true;
        console.error("[contract] FAIL: Missing case in routing.ts for: " + missingRoutes.join(", "));
    }
    // Check 2: routing fixtures
    const missingFixtures = checkRoutingFixtures();
    if (missingFixtures.length > 0) {
        hasFailure = true;
        console.error("[contract] FAIL: Missing fixture in routing-fixtures.ts for: " + missingFixtures.join(", "));
    }
    // Check 3: prompt headings
    const missingPrompt = checkPromptHeadings(repoRoot);
    if (missingPrompt.length > 0) {
        hasFailure = true;
        console.error("[contract] FAIL: Missing ### heading in bug-triager.md for: " + missingPrompt.join(", "));
    }
    // Check 4: triage validator
    const validatorErrors = checkTriageValidator(repoRoot);
    if (validatorErrors.length > 0) {
        hasFailure = true;
        for (const err of validatorErrors) {
            console.error("[contract] FAIL: " + err);
        }
    }
    if (hasFailure) {
        console.error("");
        console.error("[contract] CONTRACT TEST FAILED — classifications are out of sync across files");
        console.error("[contract] NFR14 requires changes in exactly 4 files: config.ts, routing.ts, routing-fixtures.ts, bug-triager.md");
        process.exit(1);
    }
    // AC3: silent pass — exit 0, no output
}
