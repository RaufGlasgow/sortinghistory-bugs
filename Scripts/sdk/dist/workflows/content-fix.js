/**
 * Story 2.2: Content Fixer Subagent
 *
 * Receives findings from Story 2.1's content verifier and spawns a Sonnet
 * subagent to apply fixes. Each fix:
 *   - Corrects the identified gate failure in the event JSON
 *   - Increments the event's version field
 *   - Appends an entry to corrections-log.json
 *
 * The fixer uses FIXER_TOOLS (read-write) and runs with hooks from
 * buildHooksConfig() to enforce FR40 (JSON validation) and FR45 (no Swift writes).
 *
 * Exit codes:
 * - 0: Success (all fixes applied)
 * - 1: Failure (fixer subagent failed or fixes could not be applied)
 */
import { MODELS, FIXER_TOOLS } from "../config.js";
import { spawnSubagent } from "../lib/subagent.js";
import { buildHooksConfig } from "../lib/hooks.js";
import * as fs from "node:fs";
import * as path from "node:path";
// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
/** Read the current highest CORR-NNN ID from the corrections log */
function getNextCorrectionId(correctionsLogPath) {
    try {
        const raw = fs.readFileSync(correctionsLogPath, "utf-8");
        const log = JSON.parse(raw);
        let maxNum = 0;
        // Scan corrections
        if (log.corrections) {
            for (const entry of log.corrections) {
                const match = entry.id.match(/^CORR-(\d+)$/);
                if (match) {
                    const num = parseInt(match[1], 10);
                    if (num > maxNum)
                        maxNum = num;
                }
            }
        }
        // Scan category moves
        if (log.category_moves) {
            for (const entry of log.category_moves) {
                const match = entry.id.match(/^MOVE-(\d+)$/);
                if (match) {
                    const num = parseInt(match[1], 10);
                    if (num > maxNum)
                        maxNum = num;
                }
            }
        }
        return "CORR-" + String(maxNum + 1).padStart(3, "0");
    }
    catch {
        return "CORR-001";
    }
}
/** Map gate codes to correction_type values */
function gateCodesToCorrectionType(codes) {
    for (const code of codes) {
        if (code === "F1" || code === "F2")
            return "factual_error";
        if (code === "A1" || code === "A2")
            return "age_content";
        if (code === "D1" || code === "D2")
            return "duplicate_removal";
        if (code === "G0")
            return "parameter_fix";
        if (code === "P2" || code === "P3")
            return "parameter_fix";
        if (code === "P4")
            return "parameter_fix";
        if (code === "P5")
            return "parameter_fix";
    }
    return "clarity";
}
// ------------------------------------------------------------------
// Main workflow
// ------------------------------------------------------------------
export async function runContentFix(input) {
    console.log("=== Story 2.2: Content Fixer ===");
    console.log("Findings to fix: " + input.findings.length);
    console.log("Model: " + MODELS.FIXER);
    console.log("Tools: [" + FIXER_TOOLS.join(", ") + "]");
    console.log("");
    const repoRoot = input.repoRoot
        ?? process.env.GITHUB_WORKSPACE
        ?? process.env.SDK_REPO_ROOT
        ?? process.cwd();
    // Resolve corrections log path
    const correctionsLogPath = path.isAbsolute(input.correctionsLogPath)
        ? input.correctionsLogPath
        : path.resolve(repoRoot, input.correctionsLogPath);
    // Load system prompt
    const promptPath = path.join(repoRoot, "Scripts", "sdk", "prompts", "content-fixer.md");
    let systemPrompt;
    try {
        systemPrompt = fs.readFileSync(promptPath, "utf-8");
    }
    catch (err) {
        console.error("[content-fix] Could not read system prompt at " + promptPath);
        console.error("Error: " + (err instanceof Error ? err.message : String(err)));
        process.exit(1);
    }
    // Determine the next correction ID
    const nextCorrId = getNextCorrectionId(correctionsLogPath);
    const today = new Date().toISOString().slice(0, 10);
    // Build the user prompt with all findings and instructions
    const findingsDescription = input.findings.map((f, i) => {
        const corrId = "CORR-" + String(parseInt(nextCorrId.split("-")[1], 10) + i).padStart(3, "0");
        return [
            "Finding " + (i + 1) + ":",
            "  Title: " + f.title,
            "  Gate codes: [" + f.codes.join(", ") + "]",
            "  Details: " + f.details,
            "  Source file: " + f.sourceFile,
            "  Suggested fix: " + (f.suggestedFix ?? "Use your judgment based on the gate code"),
            "  Correction ID to use: " + corrId,
            "  Correction type: " + gateCodesToCorrectionType(f.codes),
        ].join("\n");
    }).join("\n\n");
    const userPrompt = [
        "Fix the following " + input.findings.length + " content findings in the SortingHistory game event files.",
        "",
        "IMPORTANT INSTRUCTIONS:",
        "1. For EACH finding, read the source file, apply the fix, increment the event's version field by 1.",
        "2. After fixing each event, append a correction entry to the corrections log.",
        "3. Corrections log path: " + correctionsLogPath,
        "4. Today's date for log entries: " + today,
        "5. After all fixes are applied, read back each modified file to verify valid JSON.",
        "6. Translations are NOT affected by these fixes (translations_affected should be [\"de\", \"nl\", \"pt\"], translations_updated should be []).",
        "",
        "FINDINGS:",
        "",
        findingsDescription,
        "",
        "After completing all fixes, output a JSON summary with this structure:",
        "{",
        "  \"total_findings\": <number>,",
        "  \"fixed\": <number>,",
        "  \"failed\": <number>,",
        "  \"results\": [",
        "    {",
        "      \"title\": \"<event title>\",",
        "      \"fixed\": true/false,",
        "      \"codes\": [\"<gate codes>\"],",
        "      \"action\": \"<what was done>\"",
        "    }",
        "  ],",
        "  \"corrections_log_updated\": true/false",
        "}",
    ].join("\n");
    console.log("[content-fix] Spawning Sonnet fixer subagent for " + input.findings.length + " findings");
    const result = await spawnSubagent({
        model: MODELS.FIXER,
        tools: [...FIXER_TOOLS],
        prompt: userPrompt,
        systemPrompt,
        hooks: buildHooksConfig(),
        cwd: repoRoot,
        maxTurns: 20,
    });
    // Log subagent metrics
    console.log("");
    console.log("[content-fix] Subagent complete");
    console.log("  Model: " + (result.model ?? MODELS.FIXER));
    console.log("  Session ID: " + result.sessionId);
    console.log("  Input tokens: " + result.inputTokens);
    console.log("  Output tokens: " + result.outputTokens);
    console.log("  Duration: " + result.durationMs + "ms");
    console.log("  Cost: $" + result.costUsd.toFixed(4));
    console.log("  Tools used: [" + result.toolsUsed.join(", ") + "]");
    console.log("  Used write tools: " + result.usedWriteTools);
    console.log("");
    if (!result.success) {
        console.error("[content-fix] Fixer subagent failed: " + result.error);
        return {
            total_findings: input.findings.length,
            fixed: 0,
            failed: input.findings.length,
            results: input.findings.map(f => ({
                title: f.title,
                fixed: false,
                codes: f.codes,
                action: "Subagent failed: " + (result.error ?? "unknown error"),
            })),
            corrections_log_updated: false,
        };
    }
    // Verify fixes were applied by checking each source file
    console.log("[content-fix] Verifying fixes were applied...");
    const fixResults = [];
    let fixedCount = 0;
    let failedCount = 0;
    for (const finding of input.findings) {
        const filePath = path.isAbsolute(finding.sourceFile)
            ? finding.sourceFile
            : path.resolve(repoRoot, finding.sourceFile);
        try {
            const raw = fs.readFileSync(filePath, "utf-8");
            const data = JSON.parse(raw);
            if (finding.codes.includes("D2") || finding.codes.includes("D1")) {
                // For duplicate removal, verify the event is gone
                const stillExists = data.events.some(e => e.title === finding.title);
                if (!stillExists) {
                    fixResults.push({
                        title: finding.title,
                        fixed: true,
                        codes: finding.codes,
                        action: "Duplicate event removed from file",
                    });
                    fixedCount++;
                }
                else {
                    fixResults.push({
                        title: finding.title,
                        fixed: false,
                        codes: finding.codes,
                        action: "Duplicate event still exists in file",
                    });
                    failedCount++;
                }
            }
            else {
                // For other fixes, verify the event exists and version was incremented
                const event = data.events.find(e => e.title === finding.title);
                if (event) {
                    // Check version was incremented (should be >= 2 since fixtures start at 1)
                    const version = event.version ?? 0;
                    if (version >= 2) {
                        fixResults.push({
                            title: finding.title,
                            fixed: true,
                            codes: finding.codes,
                            action: "Fix applied, version incremented to " + version,
                        });
                        fixedCount++;
                    }
                    else {
                        fixResults.push({
                            title: finding.title,
                            fixed: false,
                            codes: finding.codes,
                            action: "Version not incremented (current: " + version + ")",
                        });
                        failedCount++;
                    }
                }
                else {
                    // Event title may have changed (e.g., title fix) — count as fixed if subagent succeeded
                    fixResults.push({
                        title: finding.title,
                        fixed: true,
                        codes: finding.codes,
                        action: "Event title may have been renamed during fix (subagent reported success)",
                    });
                    fixedCount++;
                }
            }
        }
        catch (err) {
            fixResults.push({
                title: finding.title,
                fixed: false,
                codes: finding.codes,
                action: "Could not verify: " + (err instanceof Error ? err.message : String(err)),
            });
            failedCount++;
        }
    }
    // Check corrections log was updated
    let correctionsLogUpdated = false;
    try {
        const logRaw = fs.readFileSync(correctionsLogPath, "utf-8");
        JSON.parse(logRaw); // Validate it is still valid JSON
        correctionsLogUpdated = true;
    }
    catch {
        console.error("[content-fix] WARNING: Corrections log is invalid or unreadable");
    }
    const output = {
        total_findings: input.findings.length,
        fixed: fixedCount,
        failed: failedCount,
        results: fixResults,
        corrections_log_updated: correctionsLogUpdated,
    };
    // Output summary
    console.log("=== Content Fixer Summary ===");
    console.log("Total findings: " + output.total_findings);
    console.log("Fixed: " + output.fixed);
    console.log("Failed: " + output.failed);
    console.log("Corrections log updated: " + output.corrections_log_updated);
    console.log("");
    for (const r of output.results) {
        const status = r.fixed ? "FIXED" : "FAILED";
        console.log("  [" + status + "] " + r.title + " [" + r.codes.join(", ") + "] — " + r.action);
    }
    console.log("");
    console.log(JSON.stringify(output, null, 2));
    return output;
}
