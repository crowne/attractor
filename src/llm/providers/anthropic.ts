/**
 * Anthropic Provider Adapter
 * Uses the native Messages API (/v1/messages).
 */

import type { ProviderAdapter } from "../adapter.js";
import {
  type LLMRequest,
  type LLMResponse,
  type StreamEvent,
  type Message,
  type ContentPart,
  type ToolCallData,
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

export interface AnthropicConfig {
  api_key: string;
  base_url?: string;
  default_headers?: Record<string, string>;
  timeout?: number;
  anthropic_version?: string;
  beta_features?: string[];
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";
  private config: AnthropicConfig;
  private baseUrl: string;

  constructor(config: AnthropicConfig) {
    this.config = config;
    this.baseUrl = (config.base_url ?? "https://api.anthropic.com").replace(
      /\/$/,
      ""
    );
  }

  async initialize(): Promise<void> {
    if (!this.config.api_key) {
      throw new LLMError("Anthropic API key is required", "anthropic");
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const body = this.buildRequestBody(request);
    const headers = this.buildHeaders(request);

    const url = `${this.baseUrl}/v1/messages`;
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
    const headers = this.buildHeaders(request);

    const url = `${this.baseUrl}/v1/messages`;
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
    let responseId = "";
    let model = request.model;
    let currentToolCall: Partial<ToolCallData> | null = null;
    let currentToolArgs = "";
    let accText = "";
    let accReasoning = "";
    const usage: Usage = {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    };

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
            if (data === "[DONE]") continue;

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(data) as Record<string, unknown>;
            } catch {
              continue;
            }

            const eventType = event.type as string;

            if (eventType === "message_start") {
              const msg = event.message as Record<string, unknown>;
              responseId = (msg.id as string) ?? "";
              model = (msg.model as string) ?? model;
              const u = msg.usage as Record<string, number> | undefined;
              if (u) {
                usage.input_tokens = u.input_tokens ?? 0;
              }
              yield {
                type: StreamEventType.STREAM_START,
                response: {
                  id: responseId,
                  model,
                  provider: "anthropic",
                  message: { role: Role.ASSISTANT, content: [] },
                  finish_reason: { reason: "other" },
                  usage: { ...usage },
                },
              };
            } else if (eventType === "content_block_start") {
              const block = event.content_block as Record<string, unknown>;
              const blockType = block.type as string;
              if (blockType === "tool_use") {
                currentToolCall = {
                  id: block.id as string,
                  name: block.name as string,
                  arguments: {},
                };
                currentToolArgs = "";
                yield {
                  type: StreamEventType.TOOL_CALL_START,
                  tool_call: { ...currentToolCall },
                };
              } else if (blockType === "thinking") {
                // start of thinking block
              }
            } else if (eventType === "content_block_delta") {
              const delta = event.delta as Record<string, unknown>;
              const deltaType = delta.type as string;
              if (deltaType === "text_delta") {
                const text = delta.text as string;
                accText += text;
                yield { type: StreamEventType.TEXT_DELTA, delta: text };
              } else if (deltaType === "input_json_delta") {
                const partial = delta.partial_json as string;
                currentToolArgs += partial;
                yield {
                  type: StreamEventType.TOOL_CALL_DELTA,
                  tool_call: currentToolCall
                    ? { ...currentToolCall }
                    : undefined,
                  delta: partial,
                };
              } else if (deltaType === "thinking_delta") {
                const text = delta.thinking as string;
                accReasoning += text;
                yield {
                  type: StreamEventType.REASONING_DELTA,
                  delta: text,
                };
              }
            } else if (eventType === "content_block_stop") {
              if (currentToolCall) {
                try {
                  currentToolCall.arguments = JSON.parse(
                    currentToolArgs || "{}"
                  ) as Record<string, unknown>;
                } catch {
                  currentToolCall.arguments = currentToolArgs;
                }
                yield {
                  type: StreamEventType.TOOL_CALL_END,
                  tool_call: currentToolCall as ToolCallData,
                };
                currentToolCall = null;
                currentToolArgs = "";
              }
            } else if (eventType === "message_delta") {
              const delta = event.delta as Record<string, unknown>;
              const u = event.usage as Record<string, number> | undefined;
              if (u) {
                usage.output_tokens = u.output_tokens ?? 0;
                usage.total_tokens =
                  usage.input_tokens + usage.output_tokens;
              }
              const stopReason = delta.stop_reason as string | undefined;
              if (stopReason) {
                const fr = this.mapFinishReason(stopReason);
                yield { type: StreamEventType.FINISH, finish_reason: fr, usage };
              }
            } else if (eventType === "message_stop") {
              // End of stream
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

  private buildHeaders(request: LLMRequest): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.config.api_key,
      "anthropic-version": this.config.anthropic_version ?? "2023-06-01",
      ...this.config.default_headers,
    };

    // Add beta features
    const betas = [
      ...(this.config.beta_features ?? []),
    ];
    const provOpts = request.provider_options?.anthropic as
      | Record<string, unknown>
      | undefined;
    if (provOpts?.beta_features) {
      betas.push(...(provOpts.beta_features as string[]));
    }
    if (betas.length > 0) {
      headers["anthropic-beta"] = betas.join(",");
    }

    return headers;
  }

  private buildRequestBody(
    request: LLMRequest
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.max_tokens ?? 4096,
    };

    // Separate system messages from conversation
    const { system, messages } = this.separateSystemMessages(request.messages);
    if (system) {
      body.system = system;
    }
    body.messages = this.translateMessages(messages);

    // Tools
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    // Tool choice
    if (request.tool_choice) {
      const tc =
        typeof request.tool_choice === "string"
          ? { mode: request.tool_choice }
          : request.tool_choice;
      if (tc.mode === "none") {
        // Omit tools entirely for "none"
        delete body.tools;
      } else if (tc.mode === "required") {
        body.tool_choice = { type: "any" };
      } else if (tc.mode === "named" && "tool_name" in tc && tc.tool_name) {
        body.tool_choice = { type: "tool", name: tc.tool_name };
      } else {
        body.tool_choice = { type: "auto" };
      }
    }

    // Optional parameters
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.top_p != null) body.top_p = request.top_p;
    if (request.stop_sequences) body.stop_sequences = request.stop_sequences;

    // Provider-specific options
    const provOpts = request.provider_options?.anthropic as
      | Record<string, unknown>
      | undefined;
    if (provOpts) {
      if (provOpts.thinking) body.thinking = provOpts.thinking;
    }

    // Reasoning effort mapping
    if (request.reasoning_effort) {
      // Map to thinking budget if not already set
      if (!body.thinking) {
        const budgetMap: Record<string, number> = {
          low: 2000,
          medium: 5000,
          high: 10000,
        };
        const budget = budgetMap[request.reasoning_effort];
        if (budget) {
          body.thinking = { type: "enabled", budget_tokens: budget };
        }
      }
    }

    return body;
  }

  private separateSystemMessages(
    messages: Message[]
  ): { system: string | undefined; messages: Message[] } {
    const systemParts: string[] = [];
    const rest: Message[] = [];

    for (const msg of messages) {
      if (msg.role === Role.SYSTEM || msg.role === Role.DEVELOPER) {
        const text = msg.content
          .filter((p) => p.kind === ContentKind.TEXT)
          .map((p) => p.text ?? "")
          .join("");
        if (text) systemParts.push(text);
      } else {
        rest.push(msg);
      }
    }

    // Merge consecutive same-role messages (Anthropic requires alternation)
    const merged = this.mergeConsecutiveMessages(rest);

    return {
      system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
      messages: merged,
    };
  }

  private mergeConsecutiveMessages(messages: Message[]): Message[] {
    const result: Message[] = [];

    for (const msg of messages) {
      const last = result[result.length - 1];
      if (last && last.role === msg.role) {
        last.content = [...last.content, ...msg.content];
      } else {
        result.push({ ...msg, content: [...msg.content] });
      }
    }

    // Ensure tool results are in user messages
    return result.map((msg) => {
      if (msg.role === Role.TOOL) {
        return { ...msg, role: Role.USER };
      }
      return msg;
    });
  }

  private translateMessages(
    messages: Message[]
  ): Record<string, unknown>[] {
    return messages.map((msg) => ({
      role: msg.role === Role.TOOL ? "user" : msg.role,
      content: this.translateContent(msg),
    }));
  }

  private translateContent(
    msg: Message
  ): Record<string, unknown>[] {
    return msg.content.map((part) => {
      switch (part.kind) {
        case ContentKind.TEXT:
          return { type: "text", text: part.text ?? "" };
        case ContentKind.IMAGE:
          if (part.image?.base64) {
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: part.image.media_type ?? "image/png",
                data: part.image.base64,
              },
            };
          }
          return {
            type: "image",
            source: { type: "url", url: part.image?.url ?? "" },
          };
        case ContentKind.TOOL_CALL:
          return {
            type: "tool_use",
            id: part.tool_call?.id ?? "",
            name: part.tool_call?.name ?? "",
            input: part.tool_call?.arguments ?? {},
          };
        case ContentKind.TOOL_RESULT:
          return {
            type: "tool_result",
            tool_use_id: part.tool_result?.tool_call_id ?? "",
            content: part.tool_result?.content ?? "",
            is_error: part.tool_result?.is_error ?? false,
          };
        case ContentKind.THINKING:
          return {
            type: "thinking",
            thinking: part.thinking?.text ?? "",
            signature: part.thinking?.signature,
          };
        case ContentKind.REDACTED_THINKING:
          return {
            type: "redacted_thinking",
            data: part.thinking?.text ?? "",
          };
        default:
          return { type: "text", text: part.text ?? "" };
      }
    });
  }

  private parseResponse(
    raw: Record<string, unknown>,
    headers: Headers
  ): LLMResponse {
    const content = raw.content as Record<string, unknown>[];
    const parts: ContentPart[] = [];

    if (content) {
      for (const block of content) {
        const blockType = block.type as string;
        if (blockType === "text") {
          parts.push({ kind: ContentKind.TEXT, text: block.text as string });
        } else if (blockType === "tool_use") {
          parts.push({
            kind: ContentKind.TOOL_CALL,
            tool_call: {
              id: block.id as string,
              name: block.name as string,
              arguments: block.input as Record<string, unknown>,
            },
          });
        } else if (blockType === "thinking") {
          parts.push({
            kind: ContentKind.THINKING,
            thinking: {
              text: block.thinking as string,
              signature: block.signature as string | undefined,
            },
          });
        } else if (blockType === "redacted_thinking") {
          parts.push({
            kind: ContentKind.REDACTED_THINKING,
            thinking: {
              text: block.data as string,
              redacted: true,
            },
          });
        }
      }
    }

    const rawUsage = raw.usage as Record<string, number> | undefined;
    const usage: Usage = {
      input_tokens: rawUsage?.input_tokens ?? 0,
      output_tokens: rawUsage?.output_tokens ?? 0,
      total_tokens:
        (rawUsage?.input_tokens ?? 0) + (rawUsage?.output_tokens ?? 0),
      cache_read_tokens: rawUsage?.cache_read_input_tokens,
      cache_write_tokens: rawUsage?.cache_creation_input_tokens,
      raw: rawUsage as Record<string, unknown>,
    };

    const stopReason = raw.stop_reason as string;

    return {
      id: raw.id as string,
      model: raw.model as string,
      provider: "anthropic",
      message: { role: Role.ASSISTANT, content: parts },
      finish_reason: this.mapFinishReason(stopReason),
      usage,
      raw,
      rate_limit: this.parseRateLimit(headers),
    };
  }

  private mapFinishReason(reason: string): FinishReason {
    const mapping: Record<string, FinishReason["reason"]> = {
      end_turn: "stop",
      stop_sequence: "stop",
      max_tokens: "length",
      tool_use: "tool_calls",
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
      // ignore parse error
    }

    const message =
      ((body.error as Record<string, unknown>)?.message as string) ??
      `Anthropic API error: ${resp.status}`;
    const retryAfter = parseInt(
      resp.headers.get("retry-after") ?? "",
      10
    );

    if (resp.status === 401 || resp.status === 403) {
      throw new AuthenticationError(message, "anthropic");
    }
    if (resp.status === 429) {
      throw new RateLimitError(
        message,
        "anthropic",
        isNaN(retryAfter) ? undefined : retryAfter
      );
    }
    if (resp.status === 404) {
      throw new NotFoundError(message, "anthropic");
    }
    throw new LLMError(message, "anthropic", resp.status, body);
  }
}

import type { RateLimitInfo } from "../types.js";
