/**
 * Local tool executor for the agent loop.
 *
 * Implements the 6 tools (Read, Write, Edit, Glob, Grep, Bash) using
 * Node.js built-ins and child processes. Enforces path restrictions
 * for file tools and integrates with the SDK hook system for safety.
 */
import type { HookEvent, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
/** Result returned by executeTool */
export interface ToolResult {
    success: boolean;
    output: string;
}
/** Options for the tool executor */
export interface ToolExecutorOptions {
    /** Working directory — file tools are restricted to paths under this directory */
    cwd: string;
    /** Optional hooks configuration from buildBugFixHooksConfig() */
    hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}
/** Tools that perform write operations (for usedWriteTools tracking) */
export declare const WRITE_TOOL_NAMES: Set<string>;
/**
 * Execute a tool by name with the given arguments.
 *
 * File tools (Read, Write, Edit, Glob) enforce path restriction within cwd.
 * All tools run PreToolUse hooks before execution if hooks are configured.
 * Bash runs with cwd set but is not path-restricted (hooks handle safety).
 */
export declare function executeTool(name: string, args: Record<string, unknown>, options: ToolExecutorOptions): Promise<ToolResult>;
