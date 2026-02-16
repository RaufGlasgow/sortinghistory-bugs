/**
 * SDK hooks for the automation pipeline.
 *
 * PreToolUse hooks: run BEFORE tool execution, can block/allow/modify
 * PostToolUse hooks: run AFTER tool execution, for logging/validation
 *
 * All types imported from the SDK to ensure compatibility with query().
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PreToolUseHookInput,
  PostToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

/** Safely extract file_path from a hook's tool_input (typed as unknown in SDK) */
function getFilePath(toolInput: unknown): string | undefined {
  if (typeof toolInput === "object" && toolInput !== null && "file_path" in toolInput) {
    const fp = (toolInput as Record<string, unknown>).file_path;
    return typeof fp === "string" ? fp : undefined;
  }
  return undefined;
}

/** FR45: Prevent writes to Swift/game source files in the automated pipeline */
export function createToolRestrictionHook(): HookCallbackMatcher {
  const restrictSwiftWrites: HookCallback = async (input, _toolUseID, _options) => {
    if (input.hook_event_name !== "PreToolUse") return {};

    const preInput = input as PreToolUseHookInput;
    const filePath = getFilePath(preInput.tool_input);
    if (!filePath) return {};

    const blockedExtensions = [".swift", ".xib", ".storyboard", ".pbxproj", ".xcworkspace"];
    const isBlocked = blockedExtensions.some((ext) => filePath.endsWith(ext));

    if (isBlocked) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: `FR45: Automated pipeline cannot modify game source files (${filePath})`,
        },
      };
    }

    return {};
  };

  return { matcher: "Write|Edit", hooks: [restrictSwiftWrites] };
}

/** FR40: Log JSON writes for audit trail (validation enforced by atomicWrite in state.ts) */
export function createJsonValidationHook(): HookCallbackMatcher {
  const validateJson: HookCallback = async (input, _toolUseID, _options) => {
    if (input.hook_event_name !== "PostToolUse") return {};

    const postInput = input as PostToolUseHookInput;
    const filePath = getFilePath(postInput.tool_input);
    if (!filePath?.endsWith(".json")) return {};

    console.log(`[hook:json-validation] JSON write to ${filePath}`);
    return {};
  };

  return { matcher: "Write|Edit", hooks: [validateJson] };
}

/** Diacritics density check for Portuguese translations (stub — implemented in Story 3.2) */
export function createDiacriticsHook(): HookCallbackMatcher {
  const checkDiacritics: HookCallback = async (input, _toolUseID, _options) => {
    if (input.hook_event_name !== "PostToolUse") return {};

    const postInput = input as PostToolUseHookInput;
    const filePath = getFilePath(postInput.tool_input);
    if (!filePath?.includes("_pt.json")) return {};

    // TODO: Story 3.2 — compare diacritics density before/after write
    // If density decreased, reject write and force retry
    console.log(`[hook:diacritics] Checking Portuguese diacritics in ${filePath}`);
    return {};
  };

  return { matcher: "Write|Edit", hooks: [checkDiacritics] };
}

/** Build the complete hooks configuration for query() options.hooks */
export function buildHooksConfig(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [createToolRestrictionHook()],
    PostToolUse: [createJsonValidationHook(), createDiacriticsHook()],
  };
}

/**
 * Build hooks configuration for bug fix subagents.
 *
 * ALLOWS writes to:
 *   - .swift files (the point of bug fixing)
 *   - Data .json files (content fixes)
 *
 * BLOCKS writes to:
 *   - .github/ directory (workflow files)
 *   - Scripts/ directory (automation code)
 *   - .yml, .yaml, .ts, .js files (automation/config files)
 *   - Package.swift, .pbxproj, .xcworkspace (project config)
 */
export function buildBugFixHooksConfig(gameRepoPath: string): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const blockBugFixWrites: HookCallback = async (input, _toolUseID, _options) => {
    if (input.hook_event_name !== "PreToolUse") return {};

    const preInput = input as PreToolUseHookInput;
    const filePath = getFilePath(preInput.tool_input);
    if (!filePath) return {};

    // Normalize to compare against game repo path
    const normalized = filePath.replace(/\\/g, "/");
    const repoNormalized = gameRepoPath.replace(/\\/g, "/");

    // Resolve relative to game repo for consistent checking
    const relative = normalized.startsWith(repoNormalized)
      ? normalized.slice(repoNormalized.length).replace(/^\//, "")
      : normalized;

    // BLOCK: automation directories
    if (relative.startsWith(".github/") || relative.startsWith("Scripts/")) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: `Bug fix subagent cannot modify automation files (${relative})`,
        },
      };
    }

    // BLOCK: automation/config file extensions
    const blockedExtensions = [".yml", ".yaml", ".ts", ".js"];
    if (blockedExtensions.some((ext) => normalized.endsWith(ext))) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: `Bug fix subagent cannot modify automation files (${normalized})`,
        },
      };
    }

    // BLOCK: project config files
    const blockedFiles = ["Package.swift"];
    const blockedProjectExtensions = [".pbxproj", ".xcworkspace"];
    const baseName = normalized.split("/").pop() ?? "";

    if (blockedFiles.includes(baseName)) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: `Bug fix subagent cannot modify project config (${baseName})`,
        },
      };
    }

    if (blockedProjectExtensions.some((ext) => normalized.endsWith(ext) || normalized.includes(ext + "/"))) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse" as const,
          permissionDecision: "deny" as const,
          permissionDecisionReason: `Bug fix subagent cannot modify project config (${normalized})`,
        },
      };
    }

    // ALLOW: .swift files and .json files (and anything else not blocked above)
    return {};
  };

  return {
    PreToolUse: [{ matcher: "Write|Edit", hooks: [blockBugFixWrites] }],
    PostToolUse: [createJsonValidationHook()],
  };
}
