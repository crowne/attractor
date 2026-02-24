/**
 * Ollama Provider Adapter
 * Uses the OpenAI-compatible Chat Completions API (/v1/chat/completions).
 *
 * Ollama exposes this endpoint at http://localhost:11434/v1/chat/completions
 * for local models like qwen3-coder:30b, llama3:70b, deepseek-coder-v2, etc.
 *
 * No API key is required for local Ollama instances.
 */

import type { ProviderAdapter } from "../adapter.js";
import {
  type LLMRequest,
  type LLMResponse,
  type StreamEvent,
  type Message,
  type ContentPart,
  type Usage,
  type FinishReason,
  Role,
  ContentKind,
  StreamEventType,
  LLMError,
  AuthenticationError,
  RateLimitError,
  NotFoundError,
} from "../types.js";

export interface OllamaConfig {
  /** Base URL for the Ollama server. Defaults to http://localhost:11434 */
  base_url?: string;
  /** Optional API key (for remote Ollama instances behind auth proxies) */
  api_key?: string;
  /** Default model to use if not specified in the request */
  default_model?: string;
  /** Request timeout in milliseconds. Defaults to 300000 (5 min) for large local models */
  timeout?: number;
  /** Additional headers to include in requests */
  default_headers?: Record<string, string>;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly name = "ollama";
  private config: OllamaConfig;
  private baseUrl: string;

  constructor(config: OllamaConfig = {}) {
    this.config = config;
    this.baseUrl = (config.base_url ?? "http://localhost:11434").replace(
      /\/$/,
      ""
    );
  }

  async initialize(): Promise<void> {
    // No API key required for local Ollama.
    // Optionally, we could ping /api/tags to verify connectivity,
    // but we keep initialize() lightweight.
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildRequestBody(request, false);
    const headers = this.buildHeaders();

    const url = `${this.baseUrl}/v1/chat/completions`;
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout ?? 300000),
    });

    if (!resp.ok) {
      await this.handleError(resp);
    }

    const raw = (await resp.json()) as Record<string, unknown>;
    return this.parseResponse(raw);
  }

  async *stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(request, true);
    const headers = this.buildHeaders();

    const url = `${this.baseUrl}/v1/chat/completions`;
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout ?? 300000),
    });

    if (!resp.ok) {
      await this.handleError(resp);
    }

    if (!resp.body) return;

    yield { type: StreamEventType.STREAM_START };

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Accumulators for the final response
    let fullText = "";
    const toolCalls: Map<
      number,
      { id: string; name: string; arguments: string }
    > = new Map();
    let finishReason: string | null = null;
    let model = request.model;
    let responseId = "";
    let totalUsage: Usage | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const data = trimmed.slice(6).trim();
          if (data === "[DONE]") continue;

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          if (chunk.id) responseId = chunk.id as string;
          if (chunk.model) model = chunk.model as string;

          // Extract usage if present (some Ollama builds include it)
          if (chunk.usage) {
            const u = chunk.usage as Record<string, unknown>;
            totalUsage = {
              input_tokens: (u.prompt_tokens as number) ?? 0,
              output_tokens: (u.completion_tokens as number) ?? 0,
              total_tokens: (u.total_tokens as number) ?? 0,
            };
          }

          const choices = chunk.choices as Record<string, unknown>[] | undefined;
          if (!choices || choices.length === 0) continue;

          const choice = choices[0]!;
          const delta = choice.delta as Record<string, unknown> | undefined;

          if (choice.finish_reason) {
            finishReason = choice.finish_reason as string;
          }

          if (!delta) continue;

          // Text content
          if (delta.content) {
            const text = delta.content as string;
            fullText += text;
            yield {
              type: StreamEventType.TEXT_DELTA,
              delta: text,
            };
          }

          // Tool calls
          const deltaToolCalls = delta.tool_calls as
            | Record<string, unknown>[]
            | undefined;
          if (deltaToolCalls) {
            for (const dtc of deltaToolCalls) {
              const index = (dtc.index as number) ?? 0;
              const fn = dtc.function as Record<string, unknown> | undefined;

              if (!toolCalls.has(index)) {
                toolCalls.set(index, {
                  id: (dtc.id as string) ?? `call_${index}`,
                  name: fn?.name as string ?? "",
                  arguments: "",
                });
                yield {
                  type: StreamEventType.TOOL_CALL_START,
                  tool_call: {
                    id: (dtc.id as string) ?? `call_${index}`,
                    name: fn?.name as string,
                  },
                };
              }

              if (fn?.arguments) {
                const argChunk = fn.arguments as string;
                const tc = toolCalls.get(index)!;
                tc.arguments += argChunk;
                yield {
                  type: StreamEventType.TOOL_CALL_DELTA,
                  delta: argChunk,
                };
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit tool call end events
    for (const [, tc] of toolCalls) {
      yield {
        type: StreamEventType.TOOL_CALL_END,
        tool_call: {
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        },
      };
    }

    // Build final response
    const parts: ContentPart[] = [];
    if (fullText) {
      parts.push({ kind: ContentKind.TEXT, text: fullText });
    }
    for (const [, tc] of toolCalls) {
      let args: Record<string, unknown> | string;
      try {
        args = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        args = tc.arguments;
      }
      parts.push({
        kind: ContentKind.TOOL_CALL,
        tool_call: { id: tc.id, name: tc.name, arguments: args },
      });
    }

    const usage: Usage = totalUsage ?? {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };

    const finish = this.mapFinishReason(finishReason, toolCalls.size > 0);

    yield {
      type: StreamEventType.FINISH,
      response: {
        id: responseId || `ollama-${Date.now()}`,
        model,
        provider: "ollama",
        message: { role: Role.ASSISTANT, content: parts },
        finish_reason: finish,
        usage,
      },
      usage,
      finish_reason: finish,
    };
  }

  supportsToolChoice(mode: string): boolean {
    // Ollama supports basic tool choice modes via the OpenAI-compatible API
    return ["auto", "none"].includes(mode);
  }

  // ── Private helpers ────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.default_headers,
    };

    if (this.config.api_key) {
      headers["Authorization"] = `Bearer ${this.config.api_key}`;
    }

    return headers;
  }

  private buildRequestBody(
    request: LLMRequest,
    stream: boolean
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model || this.config.default_model,
      messages: this.buildMessages(request.messages),
      stream,
    };

    // Tools
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    // Tool choice
    if (request.tool_choice) {
      const tc =
        typeof request.tool_choice === "string"
          ? { mode: request.tool_choice }
          : request.tool_choice;
      if (tc.mode === "named" && "tool_name" in tc && tc.tool_name) {
        body.tool_choice = {
          type: "function",
          function: { name: tc.tool_name },
        };
      } else if (tc.mode === "none" || tc.mode === "auto") {
        body.tool_choice = tc.mode;
      }
    }

    // Optional parameters
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.top_p != null) body.top_p = request.top_p;
    if (request.max_tokens != null) body.max_tokens = request.max_tokens;
    if (request.stop_sequences && request.stop_sequences.length > 0) {
      body.stop = request.stop_sequences;
    }

    // Response format
    if (request.response_format) {
      if (request.response_format.type === "json_schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: request.response_format.json_schema,
        };
      } else if (request.response_format.type === "json") {
        body.response_format = { type: "json_object" };
      }
    }

    // Stream options to include usage in streaming responses
    if (stream) {
      body.stream_options = { include_usage: true };
    }

    // Provider-specific options
    const provOpts = request.provider_options?.ollama as
      | Record<string, unknown>
      | undefined;
    if (provOpts) {
      Object.assign(body, provOpts);
    }

    return body;
  }

  private buildMessages(
    messages: Message[]
  ): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];

    for (const msg of messages) {
      if (msg.role === Role.SYSTEM || msg.role === Role.DEVELOPER) {
        const text = msg.content
          .filter((p) => p.kind === ContentKind.TEXT)
          .map((p) => p.text ?? "")
          .join("");
        if (text) {
          result.push({ role: "system", content: text });
        }
        continue;
      }

      if (msg.role === Role.TOOL) {
        for (const part of msg.content) {
          if (part.kind === ContentKind.TOOL_RESULT && part.tool_result) {
            result.push({
              role: "tool",
              tool_call_id: part.tool_result.tool_call_id,
              content: part.tool_result.content,
            });
          }
        }
        continue;
      }

      if (msg.role === Role.ASSISTANT) {
        const textParts = msg.content
          .filter((p) => p.kind === ContentKind.TEXT)
          .map((p) => p.text ?? "");
        const toolCallParts = msg.content
          .filter((p) => p.kind === ContentKind.TOOL_CALL && p.tool_call);

        const assistantMsg: Record<string, unknown> = {
          role: "assistant",
        };

        if (textParts.length > 0) {
          assistantMsg.content = textParts.join("");
        }

        if (toolCallParts.length > 0) {
          assistantMsg.tool_calls = toolCallParts.map((p) => ({
            id: p.tool_call!.id,
            type: "function",
            function: {
              name: p.tool_call!.name,
              arguments:
                typeof p.tool_call!.arguments === "string"
                  ? p.tool_call!.arguments
                  : JSON.stringify(p.tool_call!.arguments),
            },
          }));
        }

        result.push(assistantMsg);
        continue;
      }

      // User messages
      const contentParts: (string | Record<string, unknown>)[] = [];

      for (const part of msg.content) {
        if (part.kind === ContentKind.TEXT && part.text) {
          contentParts.push(part.text);
        } else if (part.kind === ContentKind.IMAGE && part.image) {
          // Ollama supports vision for some models (llava, etc.)
          if (part.image.base64) {
            contentParts.push({
              type: "image_url",
              image_url: {
                url: `data:${part.image.media_type ?? "image/png"};base64,${part.image.base64}`,
              },
            });
          } else if (part.image.url) {
            contentParts.push({
              type: "image_url",
              image_url: { url: part.image.url },
            });
          }
        }
      }

      // If all parts are plain strings, just join them
      const allStrings = contentParts.every((p) => typeof p === "string");
      if (allStrings && contentParts.length > 0) {
        result.push({
          role: "user",
          content: (contentParts as string[]).join(""),
        });
      } else if (contentParts.length > 0) {
        // Mixed content - use array format
        result.push({
          role: "user",
          content: contentParts.map((p) =>
            typeof p === "string" ? { type: "text", text: p } : p
          ),
        });
      }
    }

    return result;
  }

  private parseResponse(raw: Record<string, unknown>): LLMResponse {
    const choices = raw.choices as Record<string, unknown>[] | undefined;
    const parts: ContentPart[] = [];
    let hasToolCalls = false;
    let rawFinishReason: string | null = null;

    if (choices && choices.length > 0) {
      const choice = choices[0]!;
      rawFinishReason = (choice.finish_reason as string) ?? null;
      const message = choice.message as Record<string, unknown> | undefined;

      if (message) {
        // Text content
        if (message.content) {
          parts.push({
            kind: ContentKind.TEXT,
            text: message.content as string,
          });
        }

        // Tool calls
        const toolCalls = message.tool_calls as
          | Record<string, unknown>[]
          | undefined;
        if (toolCalls && toolCalls.length > 0) {
          hasToolCalls = true;
          for (const tc of toolCalls) {
            const fn = tc.function as Record<string, unknown>;
            let args: Record<string, unknown> | string;
            try {
              args = JSON.parse(
                fn.arguments as string
              ) as Record<string, unknown>;
            } catch {
              args = fn.arguments as string;
            }
            parts.push({
              kind: ContentKind.TOOL_CALL,
              tool_call: {
                id: (tc.id as string) ?? `call_${Math.random().toString(36).slice(2, 10)}`,
                name: fn.name as string,
                arguments: args,
              },
            });
          }
        }
      }
    }

    const rawUsage = raw.usage as Record<string, unknown> | undefined;
    const usage: Usage = {
      input_tokens: (rawUsage?.prompt_tokens as number) ?? 0,
      output_tokens: (rawUsage?.completion_tokens as number) ?? 0,
      total_tokens: (rawUsage?.total_tokens as number) ?? 0,
      raw: rawUsage,
    };

    const finishReason = this.mapFinishReason(rawFinishReason, hasToolCalls);

    return {
      id: (raw.id as string) ?? `ollama-${Date.now()}`,
      model: (raw.model as string) ?? "unknown",
      provider: "ollama",
      message: { role: Role.ASSISTANT, content: parts },
      finish_reason: finishReason,
      usage,
      raw,
    };
  }

  private mapFinishReason(
    raw: string | null,
    hasToolCalls: boolean
  ): FinishReason {
    if (hasToolCalls) {
      return { reason: "tool_calls", raw: raw ?? undefined };
    }
    switch (raw) {
      case "stop":
        return { reason: "stop", raw };
      case "length":
        return { reason: "length", raw };
      case "tool_calls":
        return { reason: "tool_calls", raw };
      case "content_filter":
        return { reason: "content_filter", raw };
      default:
        return raw ? { reason: "other", raw } : { reason: "stop" };
    }
  }

  private async handleError(resp: Response): Promise<never> {
    let body: Record<string, unknown> = {};
    try {
      body = (await resp.json()) as Record<string, unknown>;
    } catch {
      // ignore
    }

    const message =
      ((body.error as Record<string, unknown>)?.message as string) ??
      (body.error as string) ??
      `Ollama API error: ${resp.status}`;

    if (resp.status === 401) {
      throw new AuthenticationError(message, "ollama");
    }
    if (resp.status === 429) {
      const retryAfter = parseInt(
        resp.headers.get("retry-after") ?? "",
        10
      );
      throw new RateLimitError(
        message,
        "ollama",
        isNaN(retryAfter) ? undefined : retryAfter
      );
    }
    if (resp.status === 404) {
      throw new NotFoundError(
        `Model not found. Ensure the model is pulled in Ollama: ${message}`,
        "ollama"
      );
    }
    throw new LLMError(message, "ollama", resp.status, body);
  }
}
