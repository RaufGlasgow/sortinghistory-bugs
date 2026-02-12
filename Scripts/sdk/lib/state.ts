import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS, type WorkflowType, type WorkflowStatus } from "../config.js";

/** A single finding from a verification pass */
export interface WorkflowFinding {
  event_id: string;
  event_title: string;
  gates_failed: string[];
  details: string;
  severity: string;
}

/** Workflow instance state — persists between SDK sessions across approval gates */
export interface WorkflowState {
  workflow_id: string;
  workflow_type: WorkflowType;
  status: WorkflowStatus;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  trigger: "scheduled" | "dispatch" | "manual";
  category: string | null;
  findings: WorkflowFinding[];
  approved_findings: WorkflowFinding[];
  rejected_findings: WorkflowFinding[];
  fix_attempts: number;
  max_fix_attempts: number;
  fix_results: unknown[];
  pr_number: number | null;
  error: string | null;
}

/** Generate a workflow ID: {prefix}-{date}-{sequence} with true sequential numbering */
function generateWorkflowId(type: WorkflowType): string {
  const prefixMap: Record<WorkflowType, string> = {
    content_verification: "cv",
    translation_verification: "tv",
    bug_triage: "bt",
    complex_bug: "cb",
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

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/** Atomic write: write to temp file, validate JSON, rename. Prevents corruption.
 *  Cleans up the temp file on any failure (JSON validation or rename). */
function atomicWrite(filePath: string, data: string): void {
  const tempPath = `${filePath}.tmp`;
  try {
    // Validate JSON round-trip before touching disk (FR40)
    JSON.parse(data);
  } catch (err) {
    // JSON validation failed — clean up temp file if a previous attempt left one
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw err;
  }
  try {
    fs.writeFileSync(tempPath, data, "utf-8");
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    // Write or rename failed — clean up temp file if it exists
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
    throw err;
  }
}

/** Create a new workflow state file */
export async function createWorkflowState(
  type: WorkflowType,
  trigger: "scheduled" | "dispatch" | "manual",
  category?: string,
): Promise<WorkflowState> {
  const state: WorkflowState = {
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
    max_fix_attempts: 2,
    fix_results: [],
    pr_number: null,
    error: null,
  };

  ensureDir(PATHS.STATE_DIR);
  const filePath = path.join(PATHS.STATE_DIR, `${state.workflow_id}.json`);
  atomicWrite(filePath, JSON.stringify(state, null, 2));
  return state;
}

/** Update an existing workflow state file (partial update) */
export async function updateWorkflowState(
  workflowId: string,
  updates: Partial<WorkflowState>,
): Promise<WorkflowState> {
  const current = await loadWorkflowState(workflowId);
  if (!current) {
    throw new Error(`Workflow state not found: ${workflowId}`);
  }

  const updated: WorkflowState = {
    ...current,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  const filePath = path.join(PATHS.STATE_DIR, `${workflowId}.json`);
  atomicWrite(filePath, JSON.stringify(updated, null, 2));
  return updated;
}

/** Load a workflow state file by ID. Returns null if not found. */
export async function loadWorkflowState(workflowId: string): Promise<WorkflowState | null> {
  const filePath = path.join(PATHS.STATE_DIR, `${workflowId}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const data = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(data) as WorkflowState;
}

/** List all workflow state files, optionally filtered by status */
export async function listWorkflowStates(
  statusFilter?: WorkflowStatus,
): Promise<WorkflowState[]> {
  if (!fs.existsSync(PATHS.STATE_DIR)) {
    return [];
  }

  const files = fs.readdirSync(PATHS.STATE_DIR).filter((f) => f.endsWith(".json"));
  const states: WorkflowState[] = [];

  for (const file of files) {
    const data = fs.readFileSync(path.join(PATHS.STATE_DIR, file), "utf-8");
    const state = JSON.parse(data) as WorkflowState;
    if (!statusFilter || state.status === statusFilter) {
      states.push(state);
    }
  }

  return states;
}
