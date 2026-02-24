/**
 * OpenAI Provider Adapter
 * Uses the native Responses API (/v1/responses).
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

export interface OpenAIConfig {
  api_key: string;
  base_url?: string;
  org_id?: string;
  project_id?: string;
  default_headers?: Record<string, string>;
  timeout?: number;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = "openai";
  private config: OpenAIConfig;
  private baseUrl: string;

  constructor(config: OpenAIConfig) {
    this.config = config;
    this.baseUrl = (config.base_url ?? "https://api.openai.com").replace(
      /\/$/,
      ""
    );
  }

  async initialize(): Promise<void> {
    if (!this.config.api_key) {
      throw new LLMError("OpenAI API key is required", "openai");
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildRequestBody(request);
    const headers = this.buildHeaders();

    const url = `${this.baseUrl}/v1/responses`;
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout ?? 120000),
    });

    if (!resp.ok) {
      await this.handleError(resp);
    }

    const raw = (await resp.json()) as Record<string, unknown>;
    return this.parseResponse(raw, resp.headers);
  }

  async *stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(request);
    body.stream = true;
    const headers = this.buildHeaders();

    const url = `${this.baseUrl}/v1/responses`;
    const resp = await fetch(url, {
      method: "POST",
      headers,
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
            if (data === "[DONE]") {
              continue;
            }

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(data) as Record<string, unknown>;
            } catch {
              continue;
            }

            const eventType = event.type as string;

            if (eventType === "response.created") {
              yield {
                type: StreamEventType.STREAM_START,
              };
            } else if (eventType === "response.output_item.added") {
              const item = event.item as Record<string, unknown>;
              if (item?.type === "function_call") {
                yield {
                  type: StreamEventType.TOOL_CALL_START,
                  tool_call: {
                    id: item.call_id as string,
                    name: item.name as string,
                  },
                };
              }
            } else if (eventType === "response.output_text.delta") {
              yield {
                type: StreamEventType.TEXT_DELTA,
                delta: event.delta as string,
              };
            } else if (
              eventType === "response.function_call_arguments.delta"
            ) {
              yield {
                type: StreamEventType.TOOL_CALL_DELTA,
                delta: event.delta as string,
              };
            } else if (
              eventType === "response.function_call_arguments.done"
            ) {
              yield {
                type: StreamEventType.TOOL_CALL_END,
              };
            } else if (eventType === "response.completed") {
              const response = event.response as Record<string, unknown>;
              if (response) {
                const parsed = this.parseResponse(response, new Headers());
                yield {
                  type: StreamEventType.FINISH,
                  response: parsed,
                  usage: parsed.usage,
                  finish_reason: parsed.finish_reason,
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
    return ["auto", "none", "required", "named"].includes(mode);
  }

  // ── Private helpers ────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.api_key}`,
      ...this.config.default_headers,
    };

    if (this.config.org_id) {
      headers["OpenAI-Organization"] = this.config.org_id;
    }
    if (this.config.project_id) {
      headers["OpenAI-Project"] = this.config.project_id;
    }

    return headers;
  }

  private buildRequestBody(
    request: LLMRequest
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
    };

    // Extract system/developer messages into instructions
    const instructions = this.extractInstructions(request.messages);
    if (instructions) {
      body.instructions = instructions;
    }

    // Build input array (non-system messages)
    body.input = this.buildInput(request.messages);

    // Tools
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));
    }

    // Tool choice
    if (request.tool_choice) {
      const tc =
        typeof request.tool_choice === "string"
          ? { mode: request.tool_choice }
          : request.tool_choice;
      if (tc.mode === "named" && "tool_name" in tc && tc.tool_name) {
        body.tool_choice = { type: "function", name: tc.tool_name };
      } else {
        body.tool_choice = tc.mode;
      }
    }

    // Optional parameters
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.top_p != null) body.top_p = request.top_p;
    if (request.max_tokens != null) body.max_output_tokens = request.max_tokens;

    // Reasoning effort
    if (request.reasoning_effort) {
      body.reasoning = { effort: request.reasoning_effort };
    }

    // Response format
    if (request.response_format) {
      if (request.response_format.type === "json_schema") {
        body.text = {
          format: {
            type: "json_schema",
            ...request.response_format.json_schema,
            strict: request.response_format.strict ?? false,
          },
        };
      } else if (request.response_format.type === "json") {
        body.text = { format: { type: "json_object" } };
      }
    }

    // Provider-specific options
    const provOpts = request.provider_options?.openai as
      | Record<string, unknown>
      | undefined;
    if (provOpts) {
      Object.assign(body, provOpts);
    }

    return body;
  }

  private extractInstructions(messages: Message[]): string | undefined {
    const systemParts: string[] = [];
    for (const msg of messages) {
      if (msg.role === Role.SYSTEM || msg.role === Role.DEVELOPER) {
        const text = msg.content
          .filter((p) => p.kind === ContentKind.TEXT)
          .map((p) => p.text ?? "")
          .join("");
        if (text) systemParts.push(text);
      }
    }
    return systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  }

  private buildInput(
    messages: Message[]
  ): Record<string, unknown>[] {
    const input: Record<string, unknown>[] = [];

    for (const msg of messages) {
      if (msg.role === Role.SYSTEM || msg.role === Role.DEVELOPER) continue;

      if (msg.role === Role.TOOL) {
        // Tool results are top-level items in Responses API
        for (const part of msg.content) {
          if (part.kind === ContentKind.TOOL_RESULT && part.tool_result) {
            input.push({
              type: "function_call_output",
              call_id: part.tool_result.tool_call_id,
              output: part.tool_result.content,
            });
          }
        }
        continue;
      }

      if (msg.role === Role.ASSISTANT) {
        // Assistant messages with tool calls
        for (const part of msg.content) {
          if (part.kind === ContentKind.TEXT && part.text) {
            input.push({
              type: "message",
              role: "assistant",
              content: part.text,
            });
          } else if (part.kind === ContentKind.TOOL_CALL && part.tool_call) {
            input.push({
              type: "function_call",
              call_id: part.tool_call.id,
              name: part.tool_call.name,
              arguments:
                typeof part.tool_call.arguments === "string"
                  ? part.tool_call.arguments
                  : JSON.stringify(part.tool_call.arguments),
            });
          }
        }
        continue;
      }

      // User messages
      const textParts = msg.content
        .filter((p) => p.kind === ContentKind.TEXT)
        .map((p) => p.text ?? "")
        .join("");

      if (textParts) {
        input.push({
          type: "message",
          role: "user",
          content: textParts,
        });
      }

      // Image parts
      for (const part of msg.content) {
        if (part.kind === ContentKind.IMAGE && part.image) {
          if (part.image.base64) {
            input.push({
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: `data:${part.image.media_type ?? "image/png"};base64,${part.image.base64}`,
                },
              ],
            });
          } else if (part.image.url) {
            input.push({
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: part.image.url,
                },
              ],
            });
          }
        }
      }
    }

    return input;
  }

  private parseResponse(
    raw: Record<string, unknown>,
    headers: Headers
  ): LLMResponse {
    const output = raw.output as Record<string, unknown>[] | undefined;
    const parts: ContentPart[] = [];
    let hasToolCalls = false;

    if (output) {
      for (const item of output) {
        if (item.type === "message") {
          const content = item.content as
            | Record<string, unknown>[]
            | undefined;
          if (content) {
            for (const c of content) {
              if (c.type === "output_text") {
                parts.push({
                  kind: ContentKind.TEXT,
                  text: c.text as string,
                });
              }
            }
          }
        } else if (item.type === "function_call") {
          hasToolCalls = true;
          let args: Record<string, unknown> | string;
          try {
            args = JSON.parse(
              item.arguments as string
            ) as Record<string, unknown>;
          } catch {
            args = item.arguments as string;
          }
          parts.push({
            kind: ContentKind.TOOL_CALL,
            tool_call: {
              id: item.call_id as string,
              name: item.name as string,
              arguments: args,
            },
          });
        }
      }
    }

    const rawUsage = raw.usage as Record<string, unknown> | undefined;
    const usage: Usage = {
      input_tokens: (rawUsage?.input_tokens as number) ?? 0,
      output_tokens: (rawUsage?.output_tokens as number) ?? 0,
      total_tokens: (rawUsage?.total_tokens as number) ?? 0,
      raw: rawUsage,
    };

    // Extract reasoning tokens
    const completionDetails = rawUsage?.output_tokens_details as
      | Record<string, unknown>
      | undefined;
    if (completionDetails?.reasoning_tokens) {
      usage.reasoning_tokens = completionDetails.reasoning_tokens as number;
    }

    // Cache tokens
    const promptDetails = rawUsage?.input_tokens_details as
      | Record<string, unknown>
      | undefined;
    if (promptDetails?.cached_tokens) {
      usage.cache_read_tokens = promptDetails.cached_tokens as number;
    }

    const status = raw.status as string;
    let finishReason: FinishReason;
    if (hasToolCalls) {
      finishReason = { reason: "tool_calls", raw: status };
    } else if (status === "completed") {
      finishReason = { reason: "stop", raw: status };
    } else if (status === "incomplete") {
      finishReason = { reason: "length", raw: status };
    } else {
      finishReason = { reason: "other", raw: status };
    }

    return {
      id: raw.id as string,
      model: raw.model as string,
      provider: "openai",
      message: { role: Role.ASSISTANT, content: parts },
      finish_reason: finishReason,
      usage,
      raw,
      rate_limit: this.parseRateLimit(headers),
    };
  }

  private parseRateLimit(headers: Headers): RateLimitInfo | undefined {
    const remaining = headers.get("x-ratelimit-remaining-requests");
    if (!remaining) return undefined;
    return {
      requests_remaining: parseInt(remaining, 10) || undefined,
      requests_limit:
        parseInt(headers.get("x-ratelimit-limit-requests") ?? "", 10) ||
        undefined,
      tokens_remaining:
        parseInt(headers.get("x-ratelimit-remaining-tokens") ?? "", 10) ||
        undefined,
      tokens_limit:
        parseInt(headers.get("x-ratelimit-limit-tokens") ?? "", 10) ||
        undefined,
    };
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
      `OpenAI API error: ${resp.status}`;
    const retryAfter = parseInt(
      resp.headers.get("retry-after") ?? "",
      10
    );

    if (resp.status === 401) {
      throw new AuthenticationError(message, "openai");
    }
    if (resp.status === 429) {
      throw new RateLimitError(
        message,
        "openai",
        isNaN(retryAfter) ? undefined : retryAfter
      );
    }
    if (resp.status === 404) {
      throw new NotFoundError(message, "openai");
    }
    throw new LLMError(message, "openai", resp.status, body);
  }
}
