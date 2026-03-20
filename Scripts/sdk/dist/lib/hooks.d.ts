/**
 * SDK hooks for the automation pipeline.
 *
 * PreToolUse hooks: run BEFORE tool execution, can block/allow/modify
 * PostToolUse hooks: run AFTER tool execution, for logging/validation
 *
 * All types imported from the SDK to ensure compatibility with query().
 */
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
/** FR45: Prevent writes to Swift/game source files in the automated pipeline */
export declare function createToolRestrictionHook(): HookCallbackMatcher;
/** FR40: Log JSON writes for audit trail (validation enforced by atomicWrite in state.ts) */
export declare function createJsonValidationHook(): HookCallbackMatcher;
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
export declare function createDiacriticsHook(
/** Optional callback to record diacritics violations for test observability */
onViolation?: (filePath: string, before: number, after: number) => void): HookCallbackMatcher;
/** Build the complete hooks configuration for query() options.hooks */
export declare function buildHooksConfig(): Partial<Record<HookEvent, HookCallbackMatcher[]>>;
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
export declare function buildBugFixHooksConfig(gameRepoPath: string): Partial<Record<HookEvent, HookCallbackMatcher[]>>;
