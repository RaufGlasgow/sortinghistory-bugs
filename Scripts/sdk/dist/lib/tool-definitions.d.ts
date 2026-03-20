/**
 * OpenAI function calling tool definitions for the local agent loop.
 *
 * Mirrors the 6 tools used by the Claude Agent SDK pipeline (BUG_FIX_TOOLS
 * in config.ts): Read, Write, Edit, Glob, Grep, Bash.
 *
 * Each tool is defined in OpenAI's function calling format with JSON Schema
 * parameters so that any OpenAI-compatible model server (including MLX)
 * can generate structured tool calls.
 */
/** OpenAI function calling tool definition */
export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required: string[];
        };
    };
}
/**
 * Get tool definitions in OpenAI function calling format.
 *
 * @param toolNames - Optional list of tool names to include. If omitted, all 6 tools are returned.
 * @returns Array of OpenAI tool definitions
 */
export declare function getToolDefinitions(toolNames?: string[]): ToolDefinition[];
