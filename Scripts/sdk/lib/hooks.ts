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

/**
 * Diacritics density check for Portuguese translations (Story 2.4a).
 *
 * PostToolUse hook that validates diacritics density has not decreased
 * after a Write/Edit to a Portuguese translation file (_pt.json).
 * If the fixer strips diacritics, the hook logs the rejection.
 *
 * NOTE: PostToolUse hooks cannot actually reject writes (the write already happened).
 * The hook records the violation so the orchestrator can detect it and retry.
 * For true blocking, a PreToolUse hook is needed (Story 3.2).
 */
export function createDiacriticsHook(
  /** Optional callback to record diacritics violations for test observability */
  onViolation?: (filePath: string, before: number, after: number) => void,
): HookCallbackMatcher {
  /** Store pre-write diacritics counts keyed by file path */
  const preWriteCounts = new Map<string, number>();

  const recordPreWrite: HookCallback = async (input, _toolUseID, _options) => {
    if (input.hook_event_name !== "PreToolUse") return {};

    const preInput = input as PreToolUseHookInput;
    const filePath = getFilePath(preInput.tool_input);
    if (!filePath?.includes("_pt.json") && !filePath?.includes("_pt-")) return {};

    // Read file content before the write to count diacritics
    try {
      const fs = await import("node:fs");
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        const diacriticsRegex = /[\u00C0-\u00FF\u0100-\u017F]/g;
        const matches = content.match(diacriticsRegex);
        const count = matches ? matches.length : 0;
        preWriteCounts.set(filePath, count);
        console.log(`[hook:diacritics] Pre-write diacritics count for ${filePath}: ${count}`);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[hook:diacritics] WARNING: Could not read pre-write content: ${errMsg}`);
    }

    return {};
  };

  const checkDiacritics: HookCallback = async (input, _toolUseID, _options) => {
    if (input.hook_event_name !== "PostToolUse") return {};

    const postInput = input as PostToolUseHookInput;
    const filePath = getFilePath(postInput.tool_input);
    if (!filePath?.includes("_pt.json") && !filePath?.includes("_pt-")) return {};

    console.log(`[hook:diacritics] Checking Portuguese diacritics in ${filePath}`);

    // Read file content after the write to count diacritics
    try {
      const fs = await import("node:fs");
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        const diacriticsRegex = /[\u00C0-\u00FF\u0100-\u017F]/g;
        const matches = content.match(diacriticsRegex);
        const afterCount = matches ? matches.length : 0;
        const beforeCount = preWriteCounts.get(filePath) ?? afterCount;

        console.log(`[hook:diacritics] Post-write diacritics count: ${afterCount} (was ${beforeCount})`);

        // If diacritics decreased by more than 10%, flag as violation
        if (beforeCount > 0 && afterCount < beforeCount * 0.9) {
          const message = `DIACRITICS VIOLATION: Portuguese diacritics decreased from ${beforeCount} to ${afterCount} in ${filePath}. Write should be rejected.`;
          console.error(`[hook:diacritics] ${message}`);

          if (onViolation) {
            onViolation(filePath, beforeCount, afterCount);
          }

          // Record violation in hook output
          return {
            hookSpecificOutput: {
              hookEventName: "PostToolUse" as const,
              diacriticsViolation: true,
              beforeCount,
              afterCount,
              message,
            },
          };
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[hook:diacritics] WARNING: Could not check post-write diacritics: ${errMsg}`);
    }

    return {};
  };

  return { matcher: "Write|Edit", hooks: [recordPreWrite, checkDiacritics] };
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
