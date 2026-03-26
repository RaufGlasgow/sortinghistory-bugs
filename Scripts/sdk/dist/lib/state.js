import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS, LIMITS } from "../config.js";
/** Generate a workflow ID: {prefix}-{date}-{sequence} with true sequential numbering */
function generateWorkflowId(type) {
    const prefixMap = {
        content_verification: "cv",
        translation_verification: "tv",
        bug_triage: "bt",
        bug_fix: "bf",
        triage: "tr",
        qa_review: "qr",
    };
    const prefix = prefixMap[type];
    const date = new Date().toISOString().slice(0, 10);
    const pattern = `${prefix}-${date}-`;
    // Scan existing state files to find the next sequence number
    let maxSeq = 0;
    if (fs.existsSync(PATHS.STATE_DIR)) {
        for (const file of fs.readdirSync(PATHS.STATE_DIR)) {
            if (file.startsWith(pattern) && file.endsWith(".json")) {
                const seqStr = file.slice(pattern.length, -5);
                const seq = parseInt(seqStr, 10);
                if (!isNaN(seq) && seq > maxSeq) {
                    maxSeq = seq;
                }
            }
        }
    }
    return `${prefix}-${date}-${String(maxSeq + 1).padStart(3, "0")}`;
}
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}
/** Atomic write: write to temp file, validate JSON, rename. Prevents corruption.
 *  Cleans up the temp file on any failure (JSON validation or rename). */
function atomicWrite(filePath, data) {
    const tempPath = `${filePath}.tmp`;
    try {
        // Validate JSON round-trip before touching disk (FR40)
        JSON.parse(data);
    }
    catch (err) {
        // JSON validation failed — clean up temp file if a previous attempt left one
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        throw err;
    }
    try {
        fs.writeFileSync(tempPath, data, "utf-8");
        fs.renameSync(tempPath, filePath);
    }
    catch (err) {
        // Write or rename failed — clean up temp file if it exists
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        throw err;
    }
}
/** Create a new workflow state file */
export async function createWorkflowState(type, trigger, category, issueNumber) {
    const state = {
        workflow_id: generateWorkflowId(type),
        workflow_type: type,
        status: "verifying",
        session_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        trigger,
        category: category ?? null,
        findings: [],
        approved_findings: [],
        rejected_findings: [],
        fix_attempts: 0,
        max_fix_attempts: LIMITS.MAX_FIX_ATTEMPTS,
        fix_results: [],
        pr_number: null,
        error: null,
        issue_number: issueNumber ?? null,
        attempt_log: [],
        qa_results: [],
        models_used: [],
        stale_translations: null,
    };
    ensureDir(PATHS.STATE_DIR);
    const filePath = path.join(PATHS.STATE_DIR, `${state.workflow_id}.json`);
    atomicWrite(filePath, JSON.stringify(state, null, 2));
    return state;
}
/** Update an existing workflow state file (partial update) */
export async function updateWorkflowState(workflowId, updates) {
    const current = await loadWorkflowState(workflowId);
    if (!current) {
        throw new Error(`Workflow state not found: ${workflowId}`);
    }
    const updated = {
        ...current,
        ...updates,
        updated_at: new Date().toISOString(),
    };
    const filePath = path.join(PATHS.STATE_DIR, `${workflowId}.json`);
    atomicWrite(filePath, JSON.stringify(updated, null, 2));
    return updated;
}
/** Apply backward compatibility defaults for PV2-2.4 fields to a parsed state object.
 *  Old state files may be missing attempt_log, qa_results, and models_used. */
function applyStateDefaults(raw) {
    if (!Array.isArray(raw.attempt_log)) {
        raw.attempt_log = [];
    }
    if (!Array.isArray(raw.qa_results)) {
        raw.qa_results = [];
    }
    if (!Array.isArray(raw.models_used)) {
        raw.models_used = [];
    }
    if (raw.stale_translations === undefined) {
        raw.stale_translations = null;
    }
    return raw;
}
/** Load a workflow state file by ID. Returns null if not found.
 *  Backward compatible: old state files missing PV2-2.4 fields get empty-array defaults. */
export async function loadWorkflowState(workflowId) {
    const filePath = path.join(PATHS.STATE_DIR, `${workflowId}.json`);
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const data = fs.readFileSync(filePath, "utf-8");
    const raw = JSON.parse(data);
    return applyStateDefaults(raw);
}
/** List all workflow state files, optionally filtered by status */
export async function listWorkflowStates(statusFilter) {
    if (!fs.existsSync(PATHS.STATE_DIR)) {
        return [];
    }
    const files = fs.readdirSync(PATHS.STATE_DIR).filter((f) => f.endsWith(".json"));
    const states = [];
    for (const file of files) {
        const data = fs.readFileSync(path.join(PATHS.STATE_DIR, file), "utf-8");
        const raw = JSON.parse(data);
        const state = applyStateDefaults(raw);
        if (!statusFilter || state.status === statusFilter) {
            states.push(state);
        }
    }
    return states;
}
/** Find the most recent workflow state for a given issue number. Returns null if none found. */
export async function findWorkflowByIssue(issueNumber) {
    const allStates = await listWorkflowStates();
    const matching = allStates
        .filter(s => s.issue_number === issueNumber)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return matching[0] ?? null;
}
