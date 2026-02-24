/**
 * Unified LLM Client - Core Data Model
 * Language-agnostic types for multi-provider LLM communication.
 */

// ── Roles ──────────────────────────────────────────────────────────────

export enum Role {
  SYSTEM = "system",
  USER = "user",
  ASSISTANT = "assistant",
  TOOL = "tool",
  DEVELOPER = "developer",
}

// ── Content Kinds ──────────────────────────────────────────────────────

export enum ContentKind {
  TEXT = "text",
  IMAGE = "image",
  AUDIO = "audio",
  DOCUMENT = "document",
  TOOL_CALL = "tool_call",
  TOOL_RESULT = "tool_result",
  THINKING = "thinking",
  REDACTED_THINKING = "redacted_thinking",
}

// ── Content Data Records ───────────────────────────────────────────────

export interface ImageData {
  url?: string;
  base64?: string;
  media_type?: string;
  detail?: "auto" | "low" | "high";
}

export interface AudioData {
  url?: string;
  data?: string;
  media_type?: string;
}

export interface DocumentData {
  url?: string;
  base64?: string;
  media_type?: string;
  name?: string;
}

export interface ToolCallData {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
  type?: string;
}

export interface ToolResultData {
  tool_call_id: string;
  content: string;
  is_error?: boolean;
}

export interface ThinkingData {
  text: string;
  signature?: string;
  redacted?: boolean;
}

// ── Content Part ───────────────────────────────────────────────────────

export interface ContentPart {
  kind: ContentKind | string;
  text?: string;
  image?: ImageData;
  audio?: AudioData;
  document?: DocumentData;
  tool_call?: ToolCallData;
  tool_result?: ToolResultData;
  thinking?: ThinkingData;
}

// ── Message ────────────────────────────────────────────────────────────

export interface Message {
  role: Role;
  content: ContentPart[];
  name?: string;
  tool_call_id?: string;
}

export function textMessage(role: Role, text: string): Message {
  return { role, content: [{ kind: ContentKind.TEXT, text }] };
}

export function userMessage(text: string): Message {
  return textMessage(Role.USER, text);
}

export function assistantMessage(text: string): Message {
  return textMessage(Role.ASSISTANT, text);
}

export function systemMessage(text: string): Message {
  return textMessage(Role.SYSTEM, text);
}

export function toolResultMessage(
  toolCallId: string,
  content: string,
  isError = false
): Message {
  return {
    role: Role.TOOL,
    content: [
      {
        kind: ContentKind.TOOL_RESULT,
        tool_result: {
          tool_call_id: toolCallId,
          content,
          is_error: isError,
        },
      },
    ],
    tool_call_id: toolCallId,
  };
}

/** Extract concatenated text from a message */
export function messageText(msg: Message): string {
  return msg.content
    .filter((p) => p.kind === ContentKind.TEXT)
    .map((p) => p.text ?? "")
    .join("");
}

/** Extract tool calls from a message */
export function messageToolCalls(msg: Message): ToolCallData[] {
  return msg.content
    .filter((p) => p.kind === ContentKind.TOOL_CALL && p.tool_call)
    .map((p) => p.tool_call!);
}

/** Extract reasoning text from a message */
export function messageReasoning(msg: Message): string | undefined {
  const parts = msg.content.filter(
    (p) => p.kind === ContentKind.THINKING && p.thinking
  );
  if (parts.length === 0) return undefined;
  return parts.map((p) => p.thinking!.text).join("");
}

// ── Tool Definition ────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Tool extends ToolDefinition {
  execute?: (
    args: Record<string, unknown>,
    context?: unknown
  ) => Promise<string>;
}

// ── Tool Choice ────────────────────────────────────────────────────────

export interface ToolChoice {
  mode: "auto" | "none" | "required" | "named";
  tool_name?: string;
}

// ── Response Format ────────────────────────────────────────────────────

export interface ResponseFormat {
  type: "text" | "json" | "json_schema";
  json_schema?: Record<string, unknown>;
  strict?: boolean;
}

// ── Request ────────────────────────────────────────────────────────────

export interface LLMRequest {
  model: string;
  messages: Message[];
  provider?: string;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice | string;
  response_format?: ResponseFormat;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop_sequences?: string[];
  reasoning_effort?: string;
  metadata?: Record<string, string>;
  provider_options?: Record<string, unknown>;
}

// ── Finish Reason ──────────────────────────────────────────────────────

export interface FinishReason {
  reason: "stop" | "length" | "tool_calls" | "content_filter" | "error" | "other";
  raw?: string;
}

// ── Usage ──────────────────────────────────────────────────────────────

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  raw?: Record<string, unknown>;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    reasoning_tokens:
      a.reasoning_tokens != null || b.reasoning_tokens != null
        ? (a.reasoning_tokens ?? 0) + (b.reasoning_tokens ?? 0)
        : undefined,
    cache_read_tokens:
      a.cache_read_tokens != null || b.cache_read_tokens != null
        ? (a.cache_read_tokens ?? 0) + (b.cache_read_tokens ?? 0)
        : undefined,
    cache_write_tokens:
      a.cache_write_tokens != null || b.cache_write_tokens != null
        ? (a.cache_write_tokens ?? 0) + (b.cache_write_tokens ?? 0)
        : undefined,
  };
}

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

// ── Warning ────────────────────────────────────────────────────────────

export interface Warning {
  message: string;
  code?: string;
}

// ── Rate Limit Info ────────────────────────────────────────────────────

export interface RateLimitInfo {
  requests_remaining?: number;
  requests_limit?: number;
  tokens_remaining?: number;
  tokens_limit?: number;
  reset_at?: Date;
}

// ── Response ───────────────────────────────────────────────────────────

export interface LLMResponse {
  id: string;
  model: string;
  provider: string;
  message: Message;
  finish_reason: FinishReason;
  usage: Usage;
  raw?: Record<string, unknown>;
  warnings?: Warning[];
  rate_limit?: RateLimitInfo;
}

// ── Stream Events ──────────────────────────────────────────────────────

export enum StreamEventType {
  STREAM_START = "stream_start",
  TEXT_DELTA = "text_delta",
  TEXT_END = "text_end",
  REASONING_DELTA = "reasoning_delta",
  REASONING_END = "reasoning_end",
  TOOL_CALL_START = "tool_call_start",
  TOOL_CALL_DELTA = "tool_call_delta",
  TOOL_CALL_END = "tool_call_end",
  FINISH = "finish",
  ERROR = "error",
}

export interface StreamEvent {
  type: StreamEventType;
  delta?: string;
  tool_call?: Partial<ToolCallData>;
  response?: LLMResponse;
  usage?: Usage;
  finish_reason?: FinishReason;
  error?: Error;
}

// ── Timeout Config ─────────────────────────────────────────────────────

export interface TimeoutConfig {
  total?: number;
  per_step?: number;
}

export interface AdapterTimeout {
  connect: number;
  request: number;
  stream_read: number;
}

// ── Retry Policy ───────────────────────────────────────────────────────

export interface RetryPolicy {
  max_retries: number;
  base_delay: number;
  max_delay: number;
  backoff_multiplier: number;
  jitter: boolean;
  on_retry?: (error: Error, attempt: number, delay: number) => void;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_retries: 2,
  base_delay: 1.0,
  max_delay: 60.0,
  backoff_multiplier: 2.0,
  jitter: true,
};

// ── Model Catalog ──────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  provider: string;
  display_name: string;
  context_window: number;
  max_output?: number;
  supports_tools: boolean;
  supports_vision: boolean;
  supports_reasoning: boolean;
  input_cost_per_million?: number;
  output_cost_per_million?: number;
  aliases?: string[];
}

// ── Errors ─────────────────────────────────────────────────────────────

export class LLMError extends Error {
  constructor(
    message: string,
    public provider?: string,
    public status_code?: number,
    public raw?: unknown,
    public retry_after?: number
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export class AuthenticationError extends LLMError {
  constructor(message: string, provider?: string) {
    super(message, provider, 401);
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends LLMError {
  constructor(message: string, provider?: string, retry_after?: number) {
    super(message, provider, 429, undefined, retry_after);
    this.name = "RateLimitError";
  }
}

export class NotFoundError extends LLMError {
  constructor(message: string, provider?: string) {
    super(message, provider, 404);
    this.name = "NotFoundError";
  }
}

export class ContentFilterError extends LLMError {
  constructor(message: string, provider?: string) {
    super(message, provider);
    this.name = "ContentFilterError";
  }
}

export class ConfigurationError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class NoObjectGeneratedError extends LLMError {
  constructor(message: string) {
    super(message);
    this.name = "NoObjectGeneratedError";
  }
}
