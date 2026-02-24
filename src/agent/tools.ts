/**
 * Core Agent Tools
 *
 * Implements the standard tool set: read_file, write_file, edit_file,
 * shell, grep, glob, list_dir
 */

import type { ToolDefinition } from "../llm/types.js";
import type { RegisteredTool, ToolHandler } from "./types.js";
import type { ExecutionEnvironment } from "./execution-env.js";
import { truncateOutput } from "./truncation.js";

// ── Tool Definitions ───────────────────────────────────────────────────

const READ_FILE_DEF: ToolDefinition = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns line-numbered output. " +
    "Use offset and limit to read specific sections.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file to read (relative to working directory)",
      },
      offset: {
        type: "number",
        description: "Starting line number (1-based, default: 1)",
      },
      limit: {
        type: "number",
        description: "Number of lines to read (default: all)",
      },
    },
    required: ["file_path"],
  },
};

const WRITE_FILE_DEF: ToolDefinition = {
  name: "write_file",
  description:
    "Create a new file or overwrite an existing file with the given content.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file to write (relative to working directory)",
      },
      content: {
        type: "string",
        description: "The content to write to the file",
      },
    },
    required: ["file_path", "content"],
  },
};

const EDIT_FILE_DEF: ToolDefinition = {
  name: "edit_file",
  description:
    "Make targeted edits to a file. Provide old_string to find and new_string " +
    "to replace it. For new files, omit old_string. For deletions, set new_string " +
    "to empty string. Include enough context in old_string to uniquely identify " +
    "the location.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to the file to edit",
      },
      old_string: {
        type: "string",
        description: "The exact text to find and replace. Must be unique in the file.",
      },
      new_string: {
        type: "string",
        description: "The replacement text",
      },
    },
    required: ["file_path", "new_string"],
  },
};

const SHELL_DEF: ToolDefinition = {
  name: "shell",
  description:
    "Execute a shell command. Returns stdout, stderr and exit code. " +
    "Commands run in the working directory by default. Use for building, testing, " +
    "installing dependencies, git operations, etc.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute",
      },
      timeout_ms: {
        type: "number",
        description: "Timeout in milliseconds (default: 10000)",
      },
      working_dir: {
        type: "string",
        description: "Working directory for the command (relative to project root)",
      },
    },
    required: ["command"],
  },
};

const GREP_DEF: ToolDefinition = {
  name: "grep",
  description:
    "Search for a pattern in files. Returns matching lines with file paths " +
    "and line numbers. Uses regex patterns.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
      path: {
        type: "string",
        description: "File or directory to search in (default: current directory)",
      },
      case_insensitive: {
        type: "boolean",
        description: "Whether to ignore case (default: false)",
      },
      glob_filter: {
        type: "string",
        description: "File extension filter, e.g. '*.ts'",
      },
    },
    required: ["pattern"],
  },
};

const GLOB_DEF: ToolDefinition = {
  name: "glob",
  description:
    "Find files matching a glob pattern. Returns matching file paths " +
    "sorted by modification time (newest first).",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match, e.g. '**/*.ts', 'src/**/*.test.ts'",
      },
      base_path: {
        type: "string",
        description: "Base directory for the search (default: working directory)",
      },
    },
    required: ["pattern"],
  },
};

const LIST_DIR_DEF: ToolDefinition = {
  name: "list_dir",
  description:
    "List the contents of a directory. Returns names, types (file/dir) and sizes.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list (default: current directory)",
      },
      depth: {
        type: "number",
        description: "Recursion depth (default: 1)",
      },
    },
    required: [],
  },
};

// ── Tool Handlers ──────────────────────────────────────────────────────

const readFileHandler: ToolHandler = async (args, env) => {
  const filePath = args.file_path as string;
  const offset = args.offset as number | undefined;
  const limit = args.limit as number | undefined;

  try {
    const content = await env.readFile(filePath, offset, limit);
    return truncateOutput(content, "read_file");
  } catch (err: any) {
    throw new Error(`Failed to read file '${filePath}': ${err.message}`);
  }
};

const writeFileHandler: ToolHandler = async (args, env) => {
  const filePath = args.file_path as string;
  const content = args.content as string;

  try {
    await env.writeFile(filePath, content);
    const lineCount = content.split("\n").length;
    return `Successfully wrote ${lineCount} lines to ${filePath}`;
  } catch (err: any) {
    throw new Error(`Failed to write file '${filePath}': ${err.message}`);
  }
};

const editFileHandler: ToolHandler = async (args, env) => {
  const filePath = args.file_path as string;
  const oldString = args.old_string as string | undefined;
  const newString = args.new_string as string;

  try {
    if (!oldString) {
      // Create new file
      await env.writeFile(filePath, newString);
      return `Created new file ${filePath}`;
    }

    // Read existing
    const exists = await env.fileExists(filePath);
    if (!exists) {
      throw new Error(`File '${filePath}' does not exist`);
    }

    // Read raw content (no line numbers)
    const rawContent = await env.readFile(filePath);
    // Strip line numbers to get raw
    const lines = rawContent.split("\n");
    const rawLines = lines.map((l) => {
      const match = l.match(/^\s*\d+\s*\|\s?(.*)/);
      return match ? match[1] : l;
    });
    const content = rawLines.join("\n");

    // Find and replace
    const idx = content.indexOf(oldString);
    if (idx === -1) {
      throw new Error(
        `old_string not found in ${filePath}. Make sure it matches exactly.`
      );
    }

    // Check uniqueness
    const secondIdx = content.indexOf(oldString, idx + 1);
    if (secondIdx !== -1) {
      throw new Error(
        `old_string matches multiple locations in ${filePath}. Add more context to make it unique.`
      );
    }

    const newContent =
      content.slice(0, idx) + newString + content.slice(idx + oldString.length);

    await env.writeFile(filePath, newContent);

    // Show a snippet around the edit
    const editLine = content.slice(0, idx).split("\n").length;
    const snippet = newContent
      .split("\n")
      .slice(Math.max(0, editLine - 3), editLine + newString.split("\n").length + 2)
      .map((l, i) => `${String(editLine - 2 + i).padStart(4)} | ${l}`)
      .join("\n");

    return `Applied edit to ${filePath}:\n${snippet}`;
  } catch (err: any) {
    throw new Error(`Edit failed: ${err.message}`);
  }
};

const shellHandler: ToolHandler = async (args, env) => {
  const command = args.command as string;
  const timeoutMs = (args.timeout_ms as number) ?? 10000;
  const workingDir = args.working_dir as string | undefined;

  const result = await env.execCommand(command, timeoutMs, workingDir);

  let output = "";
  if (result.stdout) {
    output += `STDOUT:\n${result.stdout}\n`;
  }
  if (result.stderr) {
    output += `STDERR:\n${result.stderr}\n`;
  }
  output += `EXIT CODE: ${result.exit_code}`;

  if (result.timed_out) {
    output += ` (TIMED OUT after ${timeoutMs}ms)`;
  }

  return truncateOutput(output, "shell");
};

const grepHandler: ToolHandler = async (args, env) => {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) ?? ".";
  const caseInsensitive = (args.case_insensitive as boolean) ?? false;
  const globFilter = args.glob_filter as string | undefined;

  try {
    const result = await env.grep(pattern, searchPath, {
      case_insensitive: caseInsensitive,
      glob_filter: globFilter,
    });

    if (!result) {
      return "No matches found.";
    }

    return truncateOutput(result, "grep");
  } catch (err: any) {
    throw new Error(`Grep failed: ${err.message}`);
  }
};

const globHandler: ToolHandler = async (args, env) => {
  const pattern = args.pattern as string;
  const basePath = args.base_path as string | undefined;

  try {
    const files = await env.globFiles(pattern, basePath);

    if (files.length === 0) {
      return "No files matched the pattern.";
    }

    return truncateOutput(files.join("\n"), "default");
  } catch (err: any) {
    throw new Error(`Glob failed: ${err.message}`);
  }
};

const listDirHandler: ToolHandler = async (args, env) => {
  const dirPath = (args.path as string) ?? ".";
  const depth = (args.depth as number) ?? 1;

  try {
    const entries = await env.listDirectory(dirPath, depth);

    if (entries.length === 0) {
      return "Directory is empty.";
    }

    const lines = entries.map((e) => {
      const type = e.is_dir ? "dir " : "file";
      const size = e.size != null ? ` (${formatSize(e.size)})` : "";
      return `${type}  ${e.name}${size}`;
    });

    return truncateOutput(lines.join("\n"), "list_dir");
  } catch (err: any) {
    throw new Error(`List directory failed: ${err.message}`);
  }
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Register All Core Tools ────────────────────────────────────────────

export function getCoreTools(): RegisteredTool[] {
  return [
    { definition: READ_FILE_DEF, handler: readFileHandler },
    { definition: WRITE_FILE_DEF, handler: writeFileHandler },
    { definition: EDIT_FILE_DEF, handler: editFileHandler },
    { definition: SHELL_DEF, handler: shellHandler },
    { definition: GREP_DEF, handler: grepHandler },
    { definition: GLOB_DEF, handler: globHandler },
    { definition: LIST_DIR_DEF, handler: listDirHandler },
  ];
}
