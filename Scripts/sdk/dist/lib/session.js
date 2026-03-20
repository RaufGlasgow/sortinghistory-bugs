import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../config.js";
function loadRegistry() {
    if (!fs.existsSync(PATHS.SESSION_REGISTRY)) {
        return { sessions: {} };
    }
    const data = fs.readFileSync(PATHS.SESSION_REGISTRY, "utf-8");
    return JSON.parse(data);
}
/** Save registry atomically: write temp file, validate JSON, rename.
 *  Cleans up the temp file on any failure. */
function saveRegistry(registry) {
    const dir = path.dirname(PATHS.SESSION_REGISTRY);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const data = JSON.stringify(registry, null, 2);
    const tempPath = `${PATHS.SESSION_REGISTRY}.tmp`;
    try {
        // Validate JSON before write
        JSON.parse(data);
    }
    catch (err) {
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        throw err;
    }
    try {
        fs.writeFileSync(tempPath, data, "utf-8");
        fs.renameSync(tempPath, PATHS.SESSION_REGISTRY);
    }
    catch (err) {
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        throw err;
    }
}
/** Save a session entry when a workflow pauses for human approval */
export async function saveSession(workflowId, sessionId, resumeStep) {
    const registry = loadRegistry();
    registry.sessions[workflowId] = {
        session_id: sessionId,
        status: "paused",
        paused_at: new Date().toISOString(),
        resume_step: resumeStep,
    };
    saveRegistry(registry);
}
/** Look up a session for a workflow. Returns null if not found. */
export async function getSession(workflowId) {
    const registry = loadRegistry();
    return registry.sessions[workflowId] ?? null;
}
/** Remove a session entry after workflow completes or session expires */
export async function removeSession(workflowId) {
    const registry = loadRegistry();
    delete registry.sessions[workflowId];
    saveRegistry(registry);
}
/** Mark a session as completed */
export async function completeSession(workflowId) {
    const registry = loadRegistry();
    const entry = registry.sessions[workflowId];
    if (entry) {
        entry.status = "completed";
        saveRegistry(registry);
    }
}
/** List all paused sessions (for digest generation) */
export async function listPausedSessions() {
    const registry = loadRegistry();
    const paused = {};
    for (const [workflowId, entry] of Object.entries(registry.sessions)) {
        if (entry.status === "paused") {
            paused[workflowId] = entry;
        }
    }
    return paused;
}
