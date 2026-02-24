/**
 * Gemini Provider Adapter
 * Uses the native Gemini API (/v1beta/...generateContent).
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
  type RateLimitInfo,
  Role,
  ContentKind,
  StreamEventType,
  LLMError,
  AuthenticationError,
  RateLimitError,
  NotFoundError,
} from "../types.js";
import { randomUUID } from "node:crypto";

export interface GeminiConfig {
  api_key: string;
  base_url?: string;
  default_headers?: Record<string, string>;
  timeout?: number;
}

export class GeminiAdapter implements ProviderAdapter {
  readonly name = "gemini";
  private config: GeminiConfig;
  private baseUrl: string;

  constructor(config: GeminiConfig) {
    this.config = config;
    this.baseUrl = (
      config.base_url ?? "https://generativelanguage.googleapis.com"
    ).replace(/\/$/, "");
  }

  async initialize(): Promise<void> {
    if (!this.config.api_key) {
      throw new LLMError("Gemini API key is required", "gemini");
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildRequestBody(request);
    const url = `${this.baseUrl}/v1beta/models/${request.model}:generateContent?key=${this.config.api_key}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.config.default_headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout ?? 120000),
    });

    if (!resp.ok) {
      await this.handleError(resp);
    }

    const raw = (await resp.json()) as Record<string, unknown>;
    return this.parseResponse(raw, request.model, resp.headers);
  }

  async *stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(request);
    const url = `${this.baseUrl}/v1beta/models/${request.model}:streamGenerateContent?alt=sse&key=${this.config.api_key}`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.config.default_headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout ?? 120000),
    });

    if (!resp.ok) {
      await this.handleError(resp);
    }

    if (!resp.body) return;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let emittedStart = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (!data) continue;

            let chunk: Record<string, unknown>;
            try {
              chunk = JSON.parse(data) as Record<string, unknown>;
            } catch {
              continue;
            }

            if (!emittedStart) {
              emittedStart = true;
              yield { type: StreamEventType.STREAM_START };
            }

            const candidates = chunk.candidates as
              | Record<string, unknown>[]
              | undefined;
            if (candidates && candidates.length > 0) {
              const candidate = candidates[0]!;
              const content = candidate.content as
                | Record<string, unknown>
                | undefined;

              if (content?.parts) {
                const parts = content.parts as Record<string, unknown>[];
                for (const part of parts) {
                  if (part.text) {
                    yield {
                      type: StreamEventType.TEXT_DELTA,
                      delta: part.text as string,
                    };
                  } else if (part.functionCall) {
                    const fc = part.functionCall as Record<string, unknown>;
                    yield {
                      type: StreamEventType.TOOL_CALL_START,
                      tool_call: {
                        id: `call_${randomUUID()}`,
                        name: fc.name as string,
                        arguments: fc.args as Record<string, unknown>,
                      },
                    };
                    yield { type: StreamEventType.TOOL_CALL_END };
                  } else if (part.thought) {
                    yield {
                      type: StreamEventType.REASONING_DELTA,
                      delta: part.thought as string,
                    };
                  }
                }
              }

              // Check finish reason
              const finishReason = candidate!.finishReason as
                | string
                | undefined;
              if (finishReason) {
                const usageMeta = chunk.usageMetadata as
                  | Record<string, number>
                  | undefined;
                const usage: Usage = {
                  input_tokens: usageMeta?.promptTokenCount ?? 0,
                  output_tokens: usageMeta?.candidatesTokenCount ?? 0,
                  total_tokens: usageMeta?.totalTokenCount ?? 0,
                  reasoning_tokens: usageMeta?.thoughtsTokenCount,
                  cache_read_tokens: usageMeta?.cachedContentTokenCount,
                };

                yield {
                  type: StreamEventType.FINISH,
                  finish_reason: this.mapFinishReason(finishReason, false),
                  usage,
                };
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  supportsToolChoice(mode: string): boolean {
    return ["auto", "none", "required"].includes(mode);
  }

  // ── Private helpers ────────────────────────────────────────────────

  private buildRequestBody(
    request: LLMRequest
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {};

    // System instruction
    const systemText = this.extractSystem(request.messages);
    if (systemText) {
      body.systemInstruction = {
        parts: [{ text: systemText }],
      };
    }

    // Contents (conversation)
    body.contents = this.translateContents(request.messages);

    // Generation config
    const genConfig: Record<string, unknown> = {};
    if (request.temperature != null) genConfig.temperature = request.temperature;
    if (request.top_p != null) genConfig.topP = request.top_p;
    if (request.max_tokens != null)
      genConfig.maxOutputTokens = request.max_tokens;
    if (request.stop_sequences)
      genConfig.stopSequences = request.stop_sequences;

    // Response format
    if (request.response_format) {
      if (request.response_format.type === "json") {
        genConfig.responseMimeType = "application/json";
      } else if (request.response_format.type === "json_schema") {
        genConfig.responseMimeType = "application/json";
        genConfig.responseSchema = request.response_format.json_schema;
      }
    }

    // Reasoning effort -> thinkingConfig
    if (request.reasoning_effort) {
      const budgetMap: Record<string, number> = {
        low: 1024,
        medium: 4096,
        high: 16384,
      };
      genConfig.thinkingConfig = {
        thinkingBudget: budgetMap[request.reasoning_effort] ?? 4096,
      };
    }

    if (Object.keys(genConfig).length > 0) {
      body.generationConfig = genConfig;
    }

    // Tools
    if (request.tools && request.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    // Tool choice
    if (request.tool_choice) {
      const tc =
        typeof request.tool_choice === "string"
          ? { mode: request.tool_choice }
          : request.tool_choice;
      const modeMap: Record<string, string> = {
        auto: "AUTO",
        none: "NONE",
        required: "ANY",
      };
      body.toolConfig = {
        functionCallingConfig: {
          mode: modeMap[tc.mode] ?? "AUTO",
        },
      };
    }

    // Provider-specific options
    const provOpts = request.provider_options?.gemini as
      | Record<string, unknown>
      | undefined;
    if (provOpts) {
      if (provOpts.safetySettings) body.safetySettings = provOpts.safetySettings;
    }

    return body;
  }

  private extractSystem(messages: Message[]): string | undefined {
    const parts: string[] = [];
    for (const msg of messages) {
      if (msg.role === Role.SYSTEM || msg.role === Role.DEVELOPER) {
        const text = msg.content
          .filter((p) => p.kind === ContentKind.TEXT)
          .map((p) => p.text ?? "")
          .join("");
        if (text) parts.push(text);
      }
    }
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  private translateContents(
    messages: Message[]
  ): Record<string, unknown>[] {
    const contents: Record<string, unknown>[] = [];

    for (const msg of messages) {
      if (msg.role === Role.SYSTEM || msg.role === Role.DEVELOPER) continue;

      const role = msg.role === Role.ASSISTANT ? "model" : "user";
      const parts: Record<string, unknown>[] = [];

      for (const p of msg.content) {
        switch (p.kind) {
          case ContentKind.TEXT:
            parts.push({ text: p.text ?? "" });
            break;
          case ContentKind.IMAGE:
            if (p.image?.base64) {
              parts.push({
                inlineData: {
                  mimeType: p.image.media_type ?? "image/png",
                  data: p.image.base64,
                },
              });
            }
            break;
          case ContentKind.TOOL_CALL:
            if (p.tool_call) {
              parts.push({
                functionCall: {
                  name: p.tool_call.name,
                  args: p.tool_call.arguments,
                },
              });
            }
            break;
          case ContentKind.TOOL_RESULT:
            if (p.tool_result) {
              parts.push({
                functionResponse: {
                  name: msg.name ?? "function",
                  response: { result: p.tool_result.content },
                },
              });
            }
            break;
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    return contents;
  }

  private parseResponse(
    raw: Record<string, unknown>,
    model: string,
    headers: Headers
  ): LLMResponse {
    const candidates = raw.candidates as Record<string, unknown>[] | undefined;
    const parts: ContentPart[] = [];
    let hasToolCalls = false;
    let finishReasonStr = "STOP";

    if (candidates && candidates.length > 0) {
      const candidate = candidates[0]!;
      finishReasonStr =
        (candidate.finishReason as string) ?? "STOP";
      const content = candidate.content as
        | Record<string, unknown>
        | undefined;

      if (content?.parts) {
        const rawParts = content.parts as Record<string, unknown>[];
        for (const rp of rawParts) {
          if (rp.text) {
            parts.push({ kind: ContentKind.TEXT, text: rp.text as string });
          } else if (rp.functionCall) {
            hasToolCalls = true;
            const fc = rp.functionCall as Record<string, unknown>;
            parts.push({
              kind: ContentKind.TOOL_CALL,
              tool_call: {
                id: `call_${randomUUID()}`,
                name: fc.name as string,
                arguments: (fc.args as Record<string, unknown>) ?? {},
              },
            });
          } else if (rp.thought) {
            parts.push({
              kind: ContentKind.THINKING,
              thinking: { text: rp.thought as string },
            });
          }
        }
      }
    }

    const usageMeta = raw.usageMetadata as
      | Record<string, number>
      | undefined;
    const usage: Usage = {
      input_tokens: usageMeta?.promptTokenCount ?? 0,
      output_tokens: usageMeta?.candidatesTokenCount ?? 0,
      total_tokens: usageMeta?.totalTokenCount ?? 0,
      reasoning_tokens: usageMeta?.thoughtsTokenCount,
      cache_read_tokens: usageMeta?.cachedContentTokenCount,
      raw: usageMeta as Record<string, unknown>,
    };

    return {
      id: (raw.responseId as string) ?? `gemini-${randomUUID()}`,
      model,
      provider: "gemini",
      message: { role: Role.ASSISTANT, content: parts },
      finish_reason: this.mapFinishReason(finishReasonStr, hasToolCalls),
      usage,
      raw,
      rate_limit: this.parseRateLimit(headers),
    };
  }

  private mapFinishReason(
    reason: string,
    hasToolCalls: boolean
  ): FinishReason {
    if (hasToolCalls) return { reason: "tool_calls", raw: reason };

    const mapping: Record<string, FinishReason["reason"]> = {
      STOP: "stop",
      MAX_TOKENS: "length",
      SAFETY: "content_filter",
      RECITATION: "content_filter",
    };
    return {
      reason: mapping[reason] ?? "other",
      raw: reason,
    };
  }

  private parseRateLimit(headers: Headers): RateLimitInfo | undefined {
    const remaining = headers.get("x-ratelimit-remaining-requests");
    if (!remaining) return undefined;
    return {
      requests_remaining: parseInt(remaining, 10) || undefined,
    };
  }

  private async handleError(resp: Response): Promise<never> {
    let body: Record<string, unknown> = {};
    try {
      body = (await resp.json()) as Record<string, unknown>;
    } catch {
      // ignore
    }

    const error = body.error as Record<string, unknown> | undefined;
    const message =
      (error?.message as string) ?? `Gemini API error: ${resp.status}`;

    if (resp.status === 401 || resp.status === 403) {
      throw new AuthenticationError(message, "gemini");
    }
    if (resp.status === 429) {
      throw new RateLimitError(message, "gemini");
    }
    if (resp.status === 404) {
      throw new NotFoundError(message, "gemini");
    }
    throw new LLMError(message, "gemini", resp.status, body);
  }
}
