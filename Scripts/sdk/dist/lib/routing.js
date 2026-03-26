/**
 * Story 4.2: Routing Logic
 *
 * Pure routing decision function + GitHub API executor.
 *
 * decideRoute() is a PURE function — zero side effects. Takes a RoutingInput
 * and returns a RoutingAction describing what to do.
 *
 * executeRoute() is the side-effect layer — calls GitHub API via native fetch().
 * Supports DRY_RUN mode: logs but does not execute.
 *
 * Idempotency: issues with `sdk-routed` label are skipped entirely.
 *
 * CRITICAL: Uses PRIVATE_REPO_PAT for all GitHub API calls.
 * github.token CANNOT trigger repository_dispatch (proven lesson — CLAUDE.md rule).
 */
import { ROUTING, CLASSIFICATION_SET, CONFIDENCE_THRESHOLD } from "../config.js";
import { createWorkflowState } from "./state.js";
import { generateTriageHandoff, buildFallbackHandoffComment } from "./handoff-generator.js";
// ---------------------------------------------------------------------------
// Pure routing decision function
// ---------------------------------------------------------------------------
/**
 * Decide the routing action for a triage result.
 *
 * This is a PURE function: no I/O, no API calls, no randomness.
 * Returns a RoutingAction describing what to do.
 *
 * 3-gate system (BA-011):
 *   Gate 1: Low confidence → safe label (S4, AC3)
 *   Gate 2: Unknown classification → safe label (S1)
 *   Route: Known classification → routeByClassification()
 */
export function decideRoute(input) {
    // Idempotency: skip if already routed (AC-10)
    if (input.existing_labels?.includes(ROUTING.LABEL_ROUTED)) {
        return {
            type: "skip",
            reason: "already routed, skipping issue #" + input.issue_number,
            issue_number: input.issue_number,
        };
    }
    // Gate 1 (BA-011 S4): Low confidence → safe label, cheapest action
    // Strictly less-than: 0.70 passes, 0.69 is blocked (FR6)
    // Story 3.5: Carry triage_handoff through so the human reviewer gets signal context
    if (input.confidence < CONFIDENCE_THRESHOLD) {
        console.log("[routing] Gate 1: Low confidence " + input.confidence.toFixed(2) + " (threshold " + CONFIDENCE_THRESHOLD + ") for issue #" + input.issue_number + " — safe label fallback");
        return {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            issue_number: input.issue_number,
            labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_LOW_CONFIDENCE, ROUTING.LABEL_ROUTED],
            triage_handoff: input.triage_handoff,
        };
    }
    // Gate 2 (BA-011 S1): Unknown classification → safe label, never crash
    if (!CLASSIFICATION_SET.has(input.classification)) {
        console.log("[routing] Gate 2: Unknown classification \"" + input.classification + "\" for issue #" + input.issue_number + " — safe label fallback");
        return {
            type: "label",
            repo: ROUTING.PRIVATE_REPO,
            issue_number: input.issue_number,
            labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_UNKNOWN_CLASSIFICATION, ROUTING.LABEL_ROUTED],
        };
    }
    return routeByClassification(input.classification, input);
}
/**
 * Route a known classification to its action (ARCH-5).
 *
 * Uses TypeScript exhaustive switch with `never` assertion —
 * adding a classification to CLASSIFICATIONS without a case here
 * causes a compile error.
 */
function routeByClassification(classification, input) {
    switch (classification) {
        case "content_error": {
            // AC-1: dispatch sdk-content-verify to public repo
            // HIGH-4 fix: also apply sdk-routed + content-error labels on the private repo issue
            const category = (typeof input.extracted_context.category === "string" && input.extracted_context.category !== "")
                ? input.extracted_context.category
                : "unknown";
            return {
                type: "dispatch",
                event_type: ROUTING.DISPATCH_CONTENT_VERIFY,
                repo: ROUTING.PUBLIC_REPO,
                payload: {
                    workflow_type: "content_verification",
                    category,
                    issue_number: input.issue_number,
                },
                issue_labels: {
                    repo: ROUTING.PRIVATE_REPO,
                    issue_number: input.issue_number,
                    labels: [ROUTING.LABEL_ROUTED, ROUTING.LABEL_CONTENT_ERROR],
                },
            };
        }
        case "content_category_error": {
            // Event is in the wrong category — needs manual review (no automated handler for category moves)
            return {
                type: "label",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_CONTENT_ERROR, "category-mismatch", ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_ROUTED],
            };
        }
        case "content_duplicate": {
            // BA-011: Duplicate event — needs human review to decide which copy to keep
            return {
                type: "label",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_CONTENT_DUPLICATE, ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_ROUTED],
            };
        }
        case "translation_error": {
            // BA-008.2 AC1: dispatch sdk-translation-fix to public repo (replaces label_and_state)
            const language = (typeof input.extracted_context.language === "string" && input.extracted_context.language !== "")
                ? input.extracted_context.language
                : "unknown";
            return {
                type: "dispatch",
                event_type: ROUTING.DISPATCH_TRANSLATION_FIX,
                repo: ROUTING.PUBLIC_REPO,
                payload: {
                    workflow_type: "translation_verification",
                    language,
                    issue_number: input.issue_number,
                },
                issue_labels: {
                    repo: ROUTING.PRIVATE_REPO,
                    issue_number: input.issue_number,
                    labels: [ROUTING.LABEL_ROUTED, ROUTING.LABEL_TRANSLATION_ERROR],
                },
            };
        }
        case "code_bug": {
            // Story 3.14: code_bug routes same as ui_bug/gameplay_bug — label + wait for /approve
            return {
                type: "label",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_CODE_BUG, "severity/" + input.severity, ROUTING.LABEL_ROUTED],
            };
        }
        case "ui_bug": {
            // SDK-BF.3 AC1: ALL ui_bug severities → label with classification + severity, wait for /approve
            return {
                type: "label",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_UI_BUG, "severity/" + input.severity, ROUTING.LABEL_ROUTED],
            };
        }
        case "gameplay_bug": {
            // SDK-BF.3 AC2: ALL gameplay_bug severities → label with classification + severity, wait for /approve
            return {
                type: "label",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_GAMEPLAY_BUG, "severity/" + input.severity, ROUTING.LABEL_ROUTED],
            };
        }
        case "performance_issue": {
            // BA-011: Needs code analysis/profiling — handoff to developer
            if (!input.issue_title || !input.issue_body) {
                // Defensive: if issue data not provided, fall back to label-only (TEA recommendation)
                console.log("[routing] handoff_to_dev for performance_issue missing issue_title/issue_body — falling back to label-only");
                return {
                    type: "label",
                    repo: ROUTING.PRIVATE_REPO,
                    issue_number: input.issue_number,
                    labels: [ROUTING.LABEL_PERFORMANCE_ISSUE, ROUTING.LABEL_NEEDS_DEV_HANDOFF, ROUTING.LABEL_ROUTED],
                };
            }
            return {
                type: "handoff_to_dev",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_PERFORMANCE_ISSUE, ROUTING.LABEL_NEEDS_DEV_HANDOFF, ROUTING.LABEL_ROUTED],
                triage_data: {
                    classification: "performance_issue",
                    confidence: input.confidence,
                    severity: input.severity,
                    reasoning: input.reasoning ?? "",
                    extracted_context: input.extracted_context,
                    issue_title: input.issue_title,
                    issue_body: input.issue_body,
                },
            };
        }
        case "crash_bug": {
            // BA-011: Needs investigation — handoff to developer
            if (!input.issue_title || !input.issue_body) {
                console.log("[routing] handoff_to_dev for crash_bug missing issue_title/issue_body — falling back to label-only");
                return {
                    type: "label",
                    repo: ROUTING.PRIVATE_REPO,
                    issue_number: input.issue_number,
                    labels: [ROUTING.LABEL_CRASH_BUG, ROUTING.LABEL_NEEDS_DEV_HANDOFF, ROUTING.LABEL_ROUTED],
                };
            }
            return {
                type: "handoff_to_dev",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_CRASH_BUG, ROUTING.LABEL_NEEDS_DEV_HANDOFF, ROUTING.LABEL_ROUTED],
                triage_data: {
                    classification: "crash_bug",
                    confidence: input.confidence,
                    severity: input.severity,
                    reasoning: input.reasoning ?? "",
                    extracted_context: input.extracted_context,
                    issue_title: input.issue_title,
                    issue_body: input.issue_body,
                },
            };
        }
        case "purchase_error": {
            // Story 4.1: Purchase/subscription errors — always P0, handoff to dev
            // ENFORCE P0 severity regardless of triage AI assignment (monetization = existential)
            if (!input.issue_title || !input.issue_body) {
                console.log("[routing] handoff_to_dev for purchase_error missing issue_title/issue_body — falling back to label-only");
                return {
                    type: "label",
                    repo: ROUTING.PRIVATE_REPO,
                    issue_number: input.issue_number,
                    labels: [ROUTING.LABEL_PURCHASE_ERROR, ROUTING.LABEL_NEEDS_DEV_HANDOFF, "severity/P0", ROUTING.LABEL_ROUTED],
                };
            }
            return {
                type: "handoff_to_dev",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_PURCHASE_ERROR, ROUTING.LABEL_NEEDS_DEV_HANDOFF, "severity/P0", ROUTING.LABEL_ROUTED],
                triage_data: {
                    classification: "purchase_error",
                    confidence: input.confidence,
                    severity: "P0",
                    reasoning: input.reasoning ?? "",
                    extracted_context: input.extracted_context,
                    issue_title: input.issue_title,
                    issue_body: input.issue_body,
                },
            };
        }
        case "data_corruption": {
            // Story 4.2: Data corruption — always P1, handoff to dev
            // ENFORCE P1 minimum severity (progress loss = uninstall)
            if (!input.issue_title || !input.issue_body) {
                console.log("[routing] handoff_to_dev for data_corruption missing issue_title/issue_body — falling back to label-only");
                return {
                    type: "label",
                    repo: ROUTING.PRIVATE_REPO,
                    issue_number: input.issue_number,
                    labels: [ROUTING.LABEL_DATA_CORRUPTION, ROUTING.LABEL_NEEDS_DEV_HANDOFF, "severity/P1", ROUTING.LABEL_ROUTED],
                };
            }
            return {
                type: "handoff_to_dev",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_DATA_CORRUPTION, ROUTING.LABEL_NEEDS_DEV_HANDOFF, "severity/P1", ROUTING.LABEL_ROUTED],
                triage_data: {
                    classification: "data_corruption",
                    confidence: input.confidence,
                    severity: "P1",
                    reasoning: input.reasoning ?? "",
                    extracted_context: input.extracted_context,
                    issue_title: input.issue_title,
                    issue_body: input.issue_body,
                },
            };
        }
        case "multiplayer_error": {
            // Story 4.3: Multiplayer/networking bugs (incl. Pass & Play) — handoff to dev
            // ENFORCE P2 minimum severity; keep P1 if triage AI assigned it (data loss)
            const mpSeverity = input.severity === "P1" ? "P1" : "P2";
            if (!input.issue_title || !input.issue_body) {
                console.log("[routing] handoff_to_dev for multiplayer_error missing issue_title/issue_body — falling back to label-only");
                return {
                    type: "label",
                    repo: ROUTING.PRIVATE_REPO,
                    issue_number: input.issue_number,
                    labels: [ROUTING.LABEL_MULTIPLAYER_ERROR, ROUTING.LABEL_NEEDS_DEV_HANDOFF, "severity/" + mpSeverity, ROUTING.LABEL_ROUTED],
                };
            }
            return {
                type: "handoff_to_dev",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_MULTIPLAYER_ERROR, ROUTING.LABEL_NEEDS_DEV_HANDOFF, "severity/" + mpSeverity, ROUTING.LABEL_ROUTED],
                triage_data: {
                    classification: "multiplayer_error",
                    confidence: input.confidence,
                    severity: mpSeverity,
                    reasoning: (input.reasoning ?? "") + "\n\nSee docs/bugs/MULTIPLAYER-BUG-TRACKER.md for multiplayer baseline context.",
                    extracted_context: input.extracted_context,
                    issue_title: input.issue_title,
                    issue_body: input.issue_body,
                },
            };
        }
        case "feature_request": {
            // AC-6: backlog
            return {
                type: "label",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_FEATURE_REQUEST, ROUTING.LABEL_ROUTED],
            };
        }
        case "needs_human_review": {
            // AC-7: manual triage queue
            // Story 3.5: Attach triage_handoff when present (contextual signals analysis)
            return {
                type: "label",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_ROUTED],
                triage_handoff: input.triage_handoff,
            };
        }
        default: {
            // Exhaustive check — TypeScript will error if a Classification case is missing
            const _exhaustive = classification;
            // This line should be unreachable. If somehow reached at runtime, safe fallback.
            console.error("[routing] Exhaustive check failed for: " + String(_exhaustive));
            return {
                type: "label",
                repo: ROUTING.PRIVATE_REPO,
                issue_number: input.issue_number,
                labels: [ROUTING.LABEL_NEEDS_HUMAN_REVIEW, ROUTING.LABEL_UNKNOWN_CLASSIFICATION, ROUTING.LABEL_ROUTED],
            };
        }
    }
}
// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------
function getGitHubToken() {
    const token = process.env.PRIVATE_REPO_PAT ?? process.env.GH_TOKEN;
    if (!token) {
        throw new Error("No GitHub token found. Set PRIVATE_REPO_PAT or GH_TOKEN environment variable. " +
            "CRITICAL: github.token CANNOT trigger repository_dispatch — use a PAT.");
    }
    return token;
}
/** POST repository_dispatch event to a GitHub repo (H10: 30s timeout) */
async function githubDispatch(repo, eventType, clientPayload) {
    const token = getGitHubToken();
    const url = "https://api.github.com/repos/" + repo + "/dispatches";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + token,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                event_type: eventType,
                client_payload: clientPayload,
            }),
            signal: controller.signal,
        });
        // repository_dispatch returns 204 on success
        if (!response.ok) {
            const body = await response.text();
            throw new Error("GitHub dispatch failed: " + response.status + " " + response.statusText + " — " + body);
        }
        console.log("[routing] Dispatched " + eventType + " to " + repo);
    }
    finally {
        clearTimeout(timeoutId);
    }
}
/** POST labels to a GitHub issue (H10: 30s timeout) */
async function githubLabel(repo, issueNumber, labels) {
    const token = getGitHubToken();
    const url = "https://api.github.com/repos/" + repo + "/issues/" + issueNumber + "/labels";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + token,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ labels }),
            signal: controller.signal,
        });
        if (!response.ok) {
            const body = await response.text();
            throw new Error("GitHub label failed: " + response.status + " " + response.statusText + " — " + body);
        }
        console.log("[routing] Applied labels [" + labels.join(", ") + "] to " + repo + "#" + issueNumber);
    }
    finally {
        clearTimeout(timeoutId);
    }
}
/** POST a comment on a GitHub issue (BA-011 AC5: same auth as githubLabel/githubDispatch).
 *  Uses AbortController with 30s timeout per NFR10. */
async function githubPostComment(repo, issueNumber, body) {
    const token = getGitHubToken();
    const url = "https://api.github.com/repos/" + repo + "/issues/" + issueNumber + "/comments";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + token,
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ body }),
            signal: controller.signal,
        });
        if (!response.ok) {
            const responseBody = await response.text();
            throw new Error("GitHub comment failed: " + response.status + " " + response.statusText + " — " + responseBody);
        }
        console.log("[routing] Posted comment on " + repo + "#" + issueNumber);
    }
    finally {
        clearTimeout(timeoutId);
    }
}
// ---------------------------------------------------------------------------
// Route executor (side-effect layer)
// ---------------------------------------------------------------------------
/**
 * Execute a routing action against the GitHub API.
 *
 * When dryRun is true, logs the action but does NOT make API calls (AC-9).
 * Throws on non-2xx API responses (AC-11).
 */
export async function executeRoute(action, dryRun) {
    if (action.type === "skip") {
        console.log("[routing] SKIP: " + action.reason);
        return;
    }
    if (dryRun) {
        console.log("[routing] DRY RUN — would execute:");
        console.log("[routing]   type: " + action.type);
        if (action.type === "dispatch") {
            console.log("[routing]   event_type: " + action.event_type);
            console.log("[routing]   repo: " + action.repo);
            console.log("[routing]   payload: " + JSON.stringify(action.payload));
            if (action.issue_labels) {
                console.log("[routing]   issue_labels: [" + action.issue_labels.labels.join(", ") + "] on " + action.issue_labels.repo + "#" + action.issue_labels.issue_number);
            }
        }
        else if (action.type === "label") {
            console.log("[routing]   repo: " + action.repo);
            console.log("[routing]   issue_number: " + action.issue_number);
            console.log("[routing]   labels: [" + action.labels.join(", ") + "]");
            if (action.triage_handoff) {
                console.log("[routing]   triage_handoff.best_guess: " + action.triage_handoff.best_guess_classification);
                console.log("[routing]   triage_handoff.signals_found: " + action.triage_handoff.signals_found.length);
            }
        }
        else if (action.type === "label_and_state") {
            console.log("[routing]   repo: " + action.repo);
            console.log("[routing]   issue_number: " + action.issue_number);
            console.log("[routing]   labels: [" + action.labels.join(", ") + "]");
            console.log("[routing]   workflow_type: " + action.workflow_type);
            if (action.category) {
                console.log("[routing]   category: " + action.category);
            }
        }
        else if (action.type === "handoff_to_dev") {
            console.log("[routing]   repo: " + action.repo);
            console.log("[routing]   issue_number: " + action.issue_number);
            console.log("[routing]   labels: [" + action.labels.join(", ") + "]");
            console.log("[routing]   triage_data.classification: " + action.triage_data.classification);
        }
        return;
    }
    switch (action.type) {
        case "dispatch":
            // H1 fix: dispatch FIRST, then label. If dispatch fails, no label is applied,
            // so idempotency guard (sdk-routed) doesn't block retry.
            // Previous order (label then dispatch) caused issues to get stuck forever.
            await githubDispatch(action.repo, action.event_type, action.payload);
            // Dispatch succeeded — now apply labels (including sdk-routed for idempotency)
            if (action.issue_labels) {
                await githubLabel(action.issue_labels.repo, action.issue_labels.issue_number, action.issue_labels.labels);
            }
            break;
        case "label":
            await githubLabel(action.repo, action.issue_number, action.labels);
            break;
        case "label_and_state":
            await githubLabel(action.repo, action.issue_number, action.labels);
            await createWorkflowState(action.workflow_type, "dispatch", action.category, action.issue_number);
            console.log("[routing] Created workflow state for " + action.workflow_type + " (issue #" + action.issue_number + ")");
            break;
        case "handoff_to_dev": {
            // BA-011 Story 3.1: Generate handoff, post comment, apply labels
            await githubLabel(action.repo, action.issue_number, action.labels);
            // Generate structured handoff document
            let handoffMarkdown;
            try {
                const handoffInput = {
                    issueNumber: action.issue_number,
                    issueTitle: action.triage_data.issue_title,
                    issueBody: action.triage_data.issue_body,
                    classification: action.triage_data.classification,
                    confidence: action.triage_data.confidence,
                    severity: action.triage_data.severity,
                    reasoning: action.triage_data.reasoning,
                    extractedContext: action.triage_data.extracted_context,
                };
                handoffMarkdown = generateTriageHandoff(handoffInput);
            }
            catch (genErr) {
                // AC3: Generation failed → apply handoff-generation-failed label + fallback comment
                const genErrMsg = genErr instanceof Error ? genErr.message : String(genErr);
                console.error("[routing] Handoff generation failed for issue #" + action.issue_number + ": " + genErrMsg);
                try {
                    await githubLabel(action.repo, action.issue_number, ["handoff-generation-failed"]);
                }
                catch { /* best-effort label */ }
                const fallback = buildFallbackHandoffComment(action.triage_data.classification, action.triage_data.confidence, action.triage_data.severity, action.triage_data.reasoning, genErrMsg);
                try {
                    await githubPostComment(action.repo, action.issue_number, fallback);
                }
                catch { /* best-effort fallback comment */ }
                break;
            }
            // Post handoff comment with single retry (AC4)
            try {
                await githubPostComment(action.repo, action.issue_number, handoffMarkdown);
            }
            catch (postErr) {
                const postErrMsg = postErr instanceof Error ? postErr.message : String(postErr);
                console.error("[routing] Handoff comment post failed (attempt 1) for issue #" + action.issue_number + ": " + postErrMsg);
                // Retry once
                try {
                    await githubPostComment(action.repo, action.issue_number, handoffMarkdown);
                    console.log("[routing] Handoff comment posted on retry for issue #" + action.issue_number);
                }
                catch (retryErr) {
                    // Both attempts failed — apply delivery-failed label + fallback
                    const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                    console.error("[routing] Handoff comment retry also failed for issue #" + action.issue_number + ": " + retryErrMsg);
                    try {
                        await githubLabel(action.repo, action.issue_number, ["delivery-failed"]);
                    }
                    catch { /* best-effort label */ }
                    const fallback = buildFallbackHandoffComment(action.triage_data.classification, action.triage_data.confidence, action.triage_data.severity, action.triage_data.reasoning, "Comment delivery failed after 2 attempts: " + retryErrMsg);
                    try {
                        await githubPostComment(action.repo, action.issue_number, fallback);
                    }
                    catch { /* best-effort — if this also fails, the labels are the signal */ }
                }
            }
            console.log("[routing] Handoff-to-dev complete for issue #" + action.issue_number);
            break;
        }
    }
}
