/**
 * Local tool executor for the agent loop.
 *
 * Implements the 6 tools (Read, Write, Edit, Glob, Grep, Bash) using
 * Node.js built-ins and child processes. Enforces path restrictions
 * for file tools and integrates with the SDK hook system for safety.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, exec } from "node:child_process";
/** Tools that operate on file paths and need path restriction */
const PATH_RESTRICTED_TOOLS = new Set(["Read", "Write", "Edit", "Glob"]);
/** Tools that perform write operations (for usedWriteTools tracking) */
export const WRITE_TOOL_NAMES = new Set(["Write", "Edit"]);
/**
 * Resolve a file path to absolute and check it is within the allowed cwd.
 * Returns the resolved absolute path or throws a descriptive error.
 */
function resolveAndValidatePath(filePath, cwd) {
    const resolved = path.resolve(cwd, filePath);
    const normalizedCwd = path.resolve(cwd);
    // The resolved path must start with the cwd (plus separator or exact match)
    if (resolved !== normalizedCwd && !resolved.startsWith(normalizedCwd + path.sep)) {
        throw new Error("Path outside allowed directory");
    }
    return resolved;
}
/**
 * Run PreToolUse hooks and return whether the tool call should be blocked.
 *
 * Bridges between the local tool executor format and the Claude Agent SDK
 * HookCallbackMatcher format. Constructs a PreToolUseHookInput and calls
 * each matching hook callback.
 *
 * @returns null if allowed, or a deny reason string if blocked
 */
async function runPreToolHooks(toolName, toolInput, hooks, cwd) {
    const preToolHooks = hooks.PreToolUse;
    if (!preToolHooks || preToolHooks.length === 0)
        return null;
    // Construct the SDK-compatible hook input
    const hookInput = {
        session_id: "local-agent",
        transcript_path: "",
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: `local-${Date.now()}`,
    };
    const hookOptions = { signal: new AbortController().signal };
    for (const matcher of preToolHooks) {
        // Check if this hook's matcher regex matches the tool name
        if (!matcher.matcher)
            continue;
        const matcherRegex = new RegExp(matcher.matcher);
        if (!matcherRegex.test(toolName))
            continue;
        for (const callback of matcher.hooks) {
            const result = await callback(hookInput, hookInput.tool_use_id, hookOptions);
            // Check for deny decision
            if (result &&
                typeof result === "object" &&
                "hookSpecificOutput" in result) {
                const output = result.hookSpecificOutput;
                if (output.permissionDecision === "deny") {
                    const reason = typeof output.permissionDecisionReason === "string"
                        ? output.permissionDecisionReason
                        : "Blocked by hook";
                    return reason;
                }
            }
        }
    }
    return null;
}
/**
 * Execute a tool by name with the given arguments.
 *
 * File tools (Read, Write, Edit, Glob) enforce path restriction within cwd.
 * All tools run PreToolUse hooks before execution if hooks are configured.
 * Bash runs with cwd set but is not path-restricted (hooks handle safety).
 */
export async function executeTool(name, args, options) {
    // Run PreToolUse hooks first
    if (options.hooks) {
        const denyReason = await runPreToolHooks(name, args, options.hooks, options.cwd);
        if (denyReason) {
            return { success: false, output: `Blocked by hook: ${denyReason}` };
        }
    }
    try {
        switch (name) {
            case "Read":
                return executeRead(args, options);
            case "Write":
                return executeWrite(args, options);
            case "Edit":
                return executeEdit(args, options);
            case "Glob":
                return executeGlob(args, options);
            case "Grep":
                return executeGrep(args, options);
            case "Bash":
                return await executeBash(args, options);
            default:
                return { success: false, output: `Unknown tool: ${name}` };
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: message };
    }
}
/** Read tool: read file contents */
function executeRead(args, options) {
    const filePath = args.file_path;
    if (!filePath)
        return { success: false, output: "Missing required parameter: file_path" };
    const resolved = resolveAndValidatePath(filePath, options.cwd);
    if (!fs.existsSync(resolved)) {
        return { success: false, output: `File not found: ${resolved}` };
    }
    const content = fs.readFileSync(resolved, "utf-8");
    const lines = content.split("\n");
    const offset = typeof args.offset === "number" ? args.offset : 0;
    const limit = typeof args.limit === "number" ? args.limit : lines.length;
    const sliced = lines.slice(offset, offset + limit);
    return { success: true, output: sliced.join("\n") };
}
/** Write tool: write content to file, creating directories as needed */
function executeWrite(args, options) {
    const filePath = args.file_path;
    const content = args.content;
    if (!filePath)
        return { success: false, output: "Missing required parameter: file_path" };
    if (content === undefined || content === null) {
        return { success: false, output: "Missing required parameter: content" };
    }
    const resolved = resolveAndValidatePath(filePath, options.cwd);
    // Create parent directories as needed
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, content, "utf-8");
    return { success: true, output: "File written" };
}
/** Edit tool: exact string replacement in a file */
function executeEdit(args, options) {
    const filePath = args.file_path;
    const oldString = args.old_string;
    const newString = args.new_string;
    if (!filePath)
        return { success: false, output: "Missing required parameter: file_path" };
    if (oldString === undefined)
        return { success: false, output: "Missing required parameter: old_string" };
    if (newString === undefined)
        return { success: false, output: "Missing required parameter: new_string" };
    const resolved = resolveAndValidatePath(filePath, options.cwd);
    if (!fs.existsSync(resolved)) {
        return { success: false, output: `File not found: ${resolved}` };
    }
    const content = fs.readFileSync(resolved, "utf-8");
    if (!content.includes(oldString)) {
        return { success: false, output: "old_string not found in file" };
    }
    const updated = content.replace(oldString, newString);
    fs.writeFileSync(resolved, updated, "utf-8");
    return { success: true, output: "Edit applied" };
}
/** Glob tool: find files matching a pattern */
function executeGlob(args, options) {
    const pattern = args.pattern;
    if (!pattern)
        return { success: false, output: "Missing required parameter: pattern" };
    const searchPath = args.path;
    const baseDir = searchPath
        ? resolveAndValidatePath(searchPath, options.cwd)
        : options.cwd;
    try {
        // Use find for simple glob matching, or ls-based approach
        // For robustness, use a shell glob via bash
        const cmd = `find ${JSON.stringify(baseDir)} -name ${JSON.stringify(pattern)} -type f 2>/dev/null | sort`;
        const result = execSync(cmd, {
            cwd: options.cwd,
            encoding: "utf-8",
            timeout: 10000,
        }).trim();
        return { success: true, output: result || "(no matches)" };
    }
    catch {
        return { success: true, output: "(no matches)" };
    }
}
/** Grep tool: search file contents with ripgrep */
function executeGrep(args, options) {
    const pattern = args.pattern;
    if (!pattern)
        return { success: false, output: "Missing required parameter: pattern" };
    const searchPath = args.path ?? options.cwd;
    const include = args.include;
    try {
        const rgArgs = ["-n", "--no-heading"];
        if (include) {
            rgArgs.push("--glob", include);
        }
        rgArgs.push(JSON.stringify(pattern), JSON.stringify(searchPath));
        const cmd = `rg ${rgArgs.join(" ")} 2>/dev/null`;
        const result = execSync(cmd, {
            cwd: options.cwd,
            encoding: "utf-8",
            timeout: 15000,
        }).trim();
        return { success: true, output: result || "(no matches)" };
    }
    catch (err) {
        // rg exits with code 1 when no matches found — that is not an error
        if (err && typeof err === "object" && "status" in err && err.status === 1) {
            return { success: true, output: "(no matches)" };
        }
        // rg not available — fall back to grep
        try {
            const grepArgs = ["-rn"];
            if (include) {
                grepArgs.push("--include", include);
            }
            grepArgs.push(JSON.stringify(pattern), JSON.stringify(searchPath));
            const cmd = `grep ${grepArgs.join(" ")} 2>/dev/null`;
            const result = execSync(cmd, {
                cwd: options.cwd,
                encoding: "utf-8",
                timeout: 15000,
            }).trim();
            return { success: true, output: result || "(no matches)" };
        }
        catch {
            return { success: true, output: "(no matches)" };
        }
    }
}
/** Bash tool: execute a command with configurable timeout */
function executeBash(args, options) {
    const command = args.command;
    if (!command)
        return Promise.resolve({ success: false, output: "Missing required parameter: command" });
    const timeout = typeof args.timeout === "number" ? args.timeout : 30000;
    return new Promise((resolve) => {
        const child = exec(command, {
            cwd: options.cwd,
            timeout,
            maxBuffer: 10 * 1024 * 1024, // 10 MB
        }, (error, stdout, stderr) => {
            if (error) {
                if (error.killed || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
                    resolve({ success: false, output: `Command timed out after ${timeout}ms` });
                    return;
                }
                // Command failed but produced output
                const output = (stdout + stderr).trim();
                resolve({
                    success: false,
                    output: output || error.message,
                });
                return;
            }
            const output = (stdout + stderr).trim();
            resolve({ success: true, output: stdout });
        });
        // Ensure the child process is killed on timeout
        // (exec timeout should handle this, but be explicit)
        if (child.pid) {
            setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                }
                catch {
                    // Process may have already exited
                }
            }, timeout + 500);
        }
    });
}
