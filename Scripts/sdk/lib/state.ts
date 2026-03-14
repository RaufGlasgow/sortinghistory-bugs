import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS, LIMITS, type WorkflowType, type WorkflowStatus } from "../config.js";

/** A single finding from a verification pass */
export interface WorkflowFinding {
  event_id: string;
  event_title: string;
  gates_failed: string[];
  details: string;
  severity: string;
}

/** Log entry for a single fix attempt (Story PV2-2.4) */
export interface AttemptLogEntry {
  /** 1-based attempt number */
  attempt_number: number;
  /** Model ID used for this attempt */
  model: string;
  /** Description of the fix approach taken */
  approach: string;
  /** Outcome: "success", "compilation_error", "qa_rejected", "qa_needs_revision", "quality_gate_fail", "timeout", "error" */
  result: string;
  /** Compiler or runtime error output, if any */
  error_output: string | null;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** QA verdict for a single attempt (Story PV2-2.4) */
export interface QAVerdictEntry {
  /** 1-based attempt number this verdict applies to */
  attempt_number: number;
  /** QA verdict: "pass", "fail", "partial" */
  verdict: string;
  /** Array of specific findings from QA review */
  findings: string[];
  /** Human-readable summary of QA review */
  summary: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Token usage and cost tracking per SDK call (Story PV2-2.4) */
export interface ModelUsageEntry {
  /** Pipeline step (e.g. "fix_attempt_1", "qa_review_1", "triage") */
  step: string;
  /** Model ID used */
  model: string;
  /** Input tokens consumed */
  input_tokens: number;
  /** Output tokens consumed */
  output_tokens: number;
  /** Estimated cost in USD */
  cost_estimate: number;
  /** ISO 8601 timestamp */
  timestamp: string;
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
  issue_number: number | null;
  /** Detailed log of each fix attempt (PV2-2.4) */
  attempt_log: AttemptLogEntry[];
  /** QA review results per attempt (PV2-2.4) */
  qa_results: QAVerdictEntry[];
  /** Token/cost tracking per SDK call (PV2-2.4) */
  models_used: ModelUsageEntry[];
}

/** Generate a workflow ID: {prefix}-{date}-{sequence} with true sequential numbering */
function generateWorkflowId(type: WorkflowType): string {
  const prefixMap: Record<WorkflowType, string> = {
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
  issueNumber?: number,
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
    max_fix_attempts: LIMITS.MAX_FIX_ATTEMPTS,
    fix_results: [],
    pr_number: null,
    error: null,
    issue_number: issueNumber ?? null,
    attempt_log: [],
    qa_results: [],
    models_used: [],
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

/** Apply backward compatibility defaults for PV2-2.4 fields to a parsed state object.
 *  Old state files may be missing attempt_log, qa_results, and models_used. */
function applyStateDefaults(raw: Record<string, unknown>): WorkflowState {
  if (!Array.isArray(raw.attempt_log)) {
    raw.attempt_log = [];
  }
  if (!Array.isArray(raw.qa_results)) {
    raw.qa_results = [];
  }
  if (!Array.isArray(raw.models_used)) {
    raw.models_used = [];
  }
  return raw as unknown as WorkflowState;
}

/** Load a workflow state file by ID. Returns null if not found.
 *  Backward compatible: old state files missing PV2-2.4 fields get empty-array defaults. */
export async function loadWorkflowState(workflowId: string): Promise<WorkflowState | null> {
  const filePath = path.join(PATHS.STATE_DIR, `${workflowId}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const data = fs.readFileSync(filePath, "utf-8");
  const raw = JSON.parse(data) as Record<string, unknown>;

  return applyStateDefaults(raw);
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
    const raw = JSON.parse(data) as Record<string, unknown>;
    const state = applyStateDefaults(raw);
    if (!statusFilter || state.status === statusFilter) {
      states.push(state);
    }
  }

  return states;
}

/** Find the most recent workflow state for a given issue number. Returns null if none found. */
export async function findWorkflowByIssue(issueNumber: number): Promise<WorkflowState | null> {
  const allStates = await listWorkflowStates();
  const matching = allStates
    .filter(s => s.issue_number === issueNumber)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return matching[0] ?? null;
}
