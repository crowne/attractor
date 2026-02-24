/**
 * Provider Profiles
 *
 * Encapsulate provider-specific system prompt construction,
 * tool mapping, and conventions.
 */

import type { ToolDefinition } from "../llm/types.js";
import type {
  ProviderProfile,
  SystemPromptContext,
  RegisteredTool,
  ToolCall,
} from "./types.js";

// ── Base System Prompt ─────────────────────────────────────────────────

function buildBaseSystemPrompt(ctx: SystemPromptContext): string {
  const sections: string[] = [];

  sections.push(`You are an expert AI coding assistant. You help users with software engineering tasks including reading, writing, debugging, and explaining code.

You have access to a set of tools that allow you to interact with the user's codebase and development environment. Use these tools to gather context, make changes, and verify your work.`);

  sections.push(`## Environment
- Working directory: ${ctx.cwd}
- Platform: ${ctx.platform}
- OS: ${ctx.os_version}
- Date: ${ctx.date}`);

  sections.push(`## Available Tools
${ctx.tool_names.map((t) => `- ${t}`).join("\n")}`);

  sections.push(`## Guidelines
- Read files before editing them to understand context
- Make targeted, minimal edits
- Verify your changes compile/pass tests when possible
- Explain your reasoning when asked
- If uncertain, read more context before acting
- Do not guess at file contents — read them
- Use grep and glob to search the codebase efficiently`);

  if (ctx.project_docs.length > 0) {
    sections.push(`## Project Instructions\n${ctx.project_docs.join("\n\n---\n\n")}`);
  }

  if (ctx.user_system_prompt) {
    sections.push(`## User Instructions\n${ctx.user_system_prompt}`);
  }

  return sections.join("\n\n");
}

// ── Anthropic Profile ──────────────────────────────────────────────────

export class AnthropicProfile implements ProviderProfile {
  provider = "anthropic";
  model: string;

  constructor(model = "claude-opus-4-20250514") {
    this.model = model;
  }

  buildSystemPrompt(ctx: SystemPromptContext): string {
    const base = buildBaseSystemPrompt(ctx);
    return (
      base +
      `\n\n## Provider Notes
- When editing files, use the edit_file tool with old_string and new_string
- Include sufficient context in old_string to uniquely identify the edit location
- For creating new files, use write_file or edit_file without old_string`
    );
  }

  mapTools(tools: RegisteredTool[]): ToolDefinition[] {
    // Anthropic uses tools directly as defined
    return tools.map((t) => t.definition);
  }

  normalizeToolCalls(toolCalls: ToolCall[]): ToolCall[] {
    return toolCalls;
  }
}

// ── OpenAI Profile ─────────────────────────────────────────────────────

export class OpenAIProfile implements ProviderProfile {
  provider = "openai";
  model: string;

  constructor(model = "gpt-4.1") {
    this.model = model;
  }

  buildSystemPrompt(ctx: SystemPromptContext): string {
    const base = buildBaseSystemPrompt(ctx);
    return (
      base +
      `\n\n## Provider Notes
- Use the edit_file tool for modifying existing files
- Use write_file for creating new files
- Shell commands run via the shell tool`
    );
  }

  mapTools(tools: RegisteredTool[]): ToolDefinition[] {
    // OpenAI uses 'function' type wrapping, but we handle that in the adapter
    return tools.map((t) => t.definition);
  }

  normalizeToolCalls(toolCalls: ToolCall[]): ToolCall[] {
    // OpenAI sometimes returns stringified arguments
    return toolCalls.map((tc) => {
      if (typeof tc.arguments === "string") {
        try {
          return { ...tc, arguments: JSON.parse(tc.arguments as any) };
        } catch {
          return tc;
        }
      }
      return tc;
    });
  }
}

// ── Gemini Profile ─────────────────────────────────────────────────────

export class GeminiProfile implements ProviderProfile {
  provider = "gemini";
  model: string;

  constructor(model = "gemini-2.5-pro") {
    this.model = model;
  }

  buildSystemPrompt(ctx: SystemPromptContext): string {
    const base = buildBaseSystemPrompt(ctx);
    return (
      base +
      `\n\n## Provider Notes
- When editing files, use the edit_file tool
- Multi-step tasks may require multiple tool calls
- Shell output may be truncated for long outputs`
    );
  }

  mapTools(tools: RegisteredTool[]): ToolDefinition[] {
    return tools.map((t) => t.definition);
  }

  normalizeToolCalls(toolCalls: ToolCall[]): ToolCall[] {
    return toolCalls;
  }
}

// ── Ollama Profile ─────────────────────────────────────────────────────

export class OllamaProfile implements ProviderProfile {
  provider = "ollama";
  model: string;

  constructor(model = "qwen3-coder:30b") {
    this.model = model;
  }

  buildSystemPrompt(ctx: SystemPromptContext): string {
    const base = buildBaseSystemPrompt(ctx);
    return (
      base +
      `\n\n## Provider Notes
- You are running as a local model via Ollama
- Use the edit_file tool for modifying existing files
- Use write_file for creating new files
- Be precise with tool arguments — validate file paths before editing
- If a tool call fails, read the error and retry with corrected arguments`
    );
  }

  mapTools(tools: RegisteredTool[]): ToolDefinition[] {
    return tools.map((t) => t.definition);
  }

  normalizeToolCalls(toolCalls: ToolCall[]): ToolCall[] {
    // Local models may return stringified arguments
    return toolCalls.map((tc) => {
      if (typeof tc.arguments === "string") {
        try {
          return { ...tc, arguments: JSON.parse(tc.arguments as any) };
        } catch {
          return tc;
        }
      }
      return tc;
    });
  }
}

// ── Profile Factory ────────────────────────────────────────────────────

export function createProfile(provider: string, model?: string): ProviderProfile {
  switch (provider) {
    case "anthropic":
      return new AnthropicProfile(model);
    case "openai":
      return new OpenAIProfile(model);
    case "gemini":
      return new GeminiProfile(model);
    case "ollama":
      return new OllamaProfile(model);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── Project Doc Discovery ──────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";

const PROJECT_DOC_NAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "COPILOT.md",
  "INSTRUCTIONS.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
];

export function discoverProjectDocs(workingDir: string): string[] {
  const docs: string[] = [];

  for (const name of PROJECT_DOC_NAMES) {
    const fullPath = path.join(workingDir, name);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        docs.push(`### ${name}\n\n${content}`);
      } catch {
        // Skip unreadable files
      }
    }
  }

  return docs;
}
