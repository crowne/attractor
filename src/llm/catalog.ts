/**
 * Model Catalog - Known models across providers.
 * Advisory, not restrictive -- unknown model strings pass through.
 */

import type { ModelInfo } from "./types.js";

export const MODEL_CATALOG: ModelInfo[] = [
  // ── Anthropic ─────────────────────────────────────────────────────
  {
    id: "claude-opus-4-6",
    provider: "anthropic",
    display_name: "Claude Opus 4.6",
    context_window: 200000,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["opus", "claude-opus"],
  },
  {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    display_name: "Claude Sonnet 4.5",
    context_window: 200000,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["sonnet", "claude-sonnet"],
  },

  // ── OpenAI ────────────────────────────────────────────────────────
  {
    id: "gpt-5.2",
    provider: "openai",
    display_name: "GPT-5.2",
    context_window: 1047576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["gpt5"],
  },
  {
    id: "gpt-5.2-mini",
    provider: "openai",
    display_name: "GPT-5.2 Mini",
    context_window: 1047576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["gpt5-mini"],
  },
  {
    id: "gpt-5.2-codex",
    provider: "openai",
    display_name: "GPT-5.2 Codex",
    context_window: 1047576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["codex"],
  },

  // ── Gemini ────────────────────────────────────────────────────────
  {
    id: "gemini-3-pro-preview",
    provider: "gemini",
    display_name: "Gemini 3 Pro (Preview)",
    context_window: 1048576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["gemini-pro", "gemini-3-pro"],
  },
  {
    id: "gemini-3-flash-preview",
    provider: "gemini",
    display_name: "Gemini 3 Flash (Preview)",
    context_window: 1048576,
    supports_tools: true,
    supports_vision: true,
    supports_reasoning: true,
    aliases: ["gemini-flash", "gemini-3-flash"],
  },

  // ── Ollama (local models) ─────────────────────────────────────────
  {
    id: "qwen3-coder:30b",
    provider: "ollama",
    display_name: "Qwen3 Coder 30B",
    context_window: 131072,
    supports_tools: true,
    supports_vision: false,
    supports_reasoning: true,
    aliases: ["qwen3-coder"],
  },
  {
    id: "qwen3:32b",
    provider: "ollama",
    display_name: "Qwen3 32B",
    context_window: 131072,
    supports_tools: true,
    supports_vision: false,
    supports_reasoning: true,
    aliases: ["qwen3"],
  },
  {
    id: "deepseek-coder-v2:latest",
    provider: "ollama",
    display_name: "DeepSeek Coder V2",
    context_window: 131072,
    supports_tools: true,
    supports_vision: false,
    supports_reasoning: false,
    aliases: ["deepseek-coder"],
  },
  {
    id: "llama3.3:70b",
    provider: "ollama",
    display_name: "Llama 3.3 70B",
    context_window: 131072,
    supports_tools: true,
    supports_vision: false,
    supports_reasoning: false,
    aliases: ["llama3"],
  },
  {
    id: "codellama:latest",
    provider: "ollama",
    display_name: "Code Llama",
    context_window: 16384,
    supports_tools: false,
    supports_vision: false,
    supports_reasoning: false,
    aliases: ["codellama"],
  },
];

export function getModelInfo(modelId: string): ModelInfo | undefined {
  return MODEL_CATALOG.find(
    (m) => m.id === modelId || m.aliases?.includes(modelId)
  );
}

export function listModels(provider?: string): ModelInfo[] {
  if (provider) {
    return MODEL_CATALOG.filter((m) => m.provider === provider);
  }
  return [...MODEL_CATALOG];
}

export function getLatestModel(provider: string): ModelInfo | undefined {
  const models = listModels(provider);
  return models[0];
}
