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

/** All available tool definitions keyed by name */
const TOOL_DEFS: Record<string, ToolDefinition> = {
  Read: {
    type: "function",
    function: {
      name: "Read",
      description:
        "Reads a file from the filesystem. Returns the file contents as a string. " +
        "Use offset and limit for large files.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the file to read",
          },
          offset: {
            type: "number",
            description: "Line number to start reading from (1-based). Optional.",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read. Optional.",
          },
        },
        required: ["file_path"],
      },
    },
  },

  Write: {
    type: "function",
    function: {
      name: "Write",
      description:
        "Writes content to a file, creating it if it does not exist. " +
        "Overwrites the file if it already exists. Creates parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the file to write",
          },
          content: {
            type: "string",
            description: "The content to write to the file",
          },
        },
        required: ["file_path", "content"],
      },
    },
  },

  Edit: {
    type: "function",
    function: {
      name: "Edit",
      description:
        "Performs an exact string replacement in a file. Finds old_string and replaces " +
        "it with new_string. Returns an error if old_string is not found in the file.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the file to edit",
          },
          old_string: {
            type: "string",
            description: "The exact text to find and replace",
          },
          new_string: {
            type: "string",
            description: "The replacement text",
          },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  },

  Glob: {
    type: "function",
    function: {
      name: "Glob",
      description:
        "Finds files matching a glob pattern. Returns matching file paths, one per line.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: 'Glob pattern to match (e.g. "**/*.ts", "*.json")',
          },
          path: {
            type: "string",
            description: "Directory to search in. Defaults to cwd if not specified.",
          },
        },
        required: ["pattern"],
      },
    },
  },

  Grep: {
    type: "function",
    function: {
      name: "Grep",
      description:
        "Searches file contents using a regex pattern (via ripgrep). " +
        "Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regex pattern to search for",
          },
          path: {
            type: "string",
            description: "File or directory to search in. Defaults to cwd if not specified.",
          },
          include: {
            type: "string",
            description: 'Glob pattern to filter files (e.g. "*.ts", "*.swift")',
          },
        },
        required: ["pattern"],
      },
    },
  },

  Bash: {
    type: "function",
    function: {
      name: "Bash",
      description:
        "Executes a bash command and returns stdout/stderr. " +
        "Commands run with cwd set to the working directory. " +
        "Supports a configurable timeout (default 30 seconds).",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The bash command to execute",
          },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds. Default: 30000 (30 seconds).",
          },
        },
        required: ["command"],
      },
    },
  },
};

/**
 * Get tool definitions in OpenAI function calling format.
 *
 * @param toolNames - Optional list of tool names to include. If omitted, all 6 tools are returned.
 * @returns Array of OpenAI tool definitions
 */
export function getToolDefinitions(toolNames?: string[]): ToolDefinition[] {
  if (!toolNames) {
    return Object.values(TOOL_DEFS);
  }

  const result: ToolDefinition[] = [];
  for (const name of toolNames) {
    const def = TOOL_DEFS[name];
    if (!def) {
      console.warn(`[tool-definitions] Unknown tool name: ${name}`);
      continue;
    }
    result.push(def);
  }
  return result;
}
