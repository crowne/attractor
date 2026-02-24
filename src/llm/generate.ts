/**
 * High-level API: generate(), stream(), generate_object()
 * Wraps Client with tool execution loops, retries, and structured output.
 */

import { Client, getDefaultClient } from "./client.js";
import {
  type LLMRequest,
  type LLMResponse,
  type LLMError,
  type StreamEvent,
  type Usage,
  type FinishReason,
  type Tool,
  type ToolChoice,
  type ToolDefinition,
  type ResponseFormat,
  type Message,
  type ToolCallData,
  type TimeoutConfig,
  StreamEventType,
  ContentKind,
  Role,
  addUsage,
  emptyUsage,
  toolResultMessage,
  messageText,
  messageToolCalls,
  messageReasoning,
  NoObjectGeneratedError,
  RateLimitError,
} from "./types.js";

// ── Step Result ────────────────────────────────────────────────────────

export interface StepResult {
  response: LLMResponse;
  tool_calls: ToolCallData[];
  tool_results: Array<{ tool_call_id: string; content: string; is_error: boolean }>;
  usage: Usage;
}

// ── Generate Result ────────────────────────────────────────────────────

export interface GenerateResult {
  text: string;
  reasoning?: string;
  tool_calls: ToolCallData[];
  tool_results: Array<{ tool_call_id: string; content: string; is_error: boolean }>;
  finish_reason: FinishReason;
  usage: Usage;
  total_usage: Usage;
  steps: StepResult[];
  response: LLMResponse;
  output?: unknown;
}

// ── Stream Result ──────────────────────────────────────────────────────

export class StreamResult implements AsyncIterable<StreamEvent> {
  private events: StreamEvent[] = [];
  private _response?: LLMResponse;
  private _text = "";
  private iter: AsyncIterable<StreamEvent>;

  constructor(iter: AsyncIterable<StreamEvent>) {
    this.iter = iter;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    for await (const event of this.iter) {
      this.events.push(event);
      if (event.type === StreamEventType.TEXT_DELTA && event.delta) {
        this._text += event.delta;
      }
      if (event.type === StreamEventType.FINISH && event.response) {
        this._response = event.response;
      }
      yield event;
    }
  }

  get textStream(): AsyncIterable<string> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of self) {
          if (event.type === StreamEventType.TEXT_DELTA && event.delta) {
            yield event.delta;
          }
        }
      },
    };
  }

  response(): LLMResponse | undefined {
    return this._response;
  }
}

// ── Stop Condition ─────────────────────────────────────────────────────

export type StopCondition = (step: StepResult) => boolean;

// ── Generate Options ───────────────────────────────────────────────────

export interface GenerateOptions {
  model: string;
  prompt?: string;
  messages?: Message[];
  system?: string;
  tools?: Tool[];
  tool_choice?: ToolChoice | string;
  max_tool_rounds?: number;
  stop_when?: StopCondition;
  response_format?: ResponseFormat;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop_sequences?: string[];
  reasoning_effort?: string;
  provider?: string;
  provider_options?: Record<string, unknown>;
  max_retries?: number;
  timeout?: number | TimeoutConfig;
  abort_signal?: AbortSignal;
  client?: Client;
}

// ── Main API Functions ─────────────────────────────────────────────────

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const client = options.client ?? getDefaultClient();
  const maxRounds = options.max_tool_rounds ?? 1;
  const maxRetries = options.max_retries ?? 2;

  if (options.prompt && options.messages) {
    throw new Error("Cannot provide both 'prompt' and 'messages'");
  }

  // Build initial messages
  let messages: Message[] = [];
  if (options.system) {
    messages.push({
      role: Role.SYSTEM,
      content: [{ kind: ContentKind.TEXT, text: options.system }],
    });
  }
  if (options.prompt) {
    messages.push({
      role: Role.USER,
      content: [{ kind: ContentKind.TEXT, text: options.prompt }],
    });
  } else if (options.messages) {
    messages = [...messages, ...options.messages];
  }

  // Tool definitions (without execute handlers)
  const toolDefs: ToolDefinition[] | undefined = options.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  // Tool executor map
  const toolExecutors = new Map<string, Tool["execute"]>();
  if (options.tools) {
    for (const tool of options.tools) {
      if (tool.execute) {
        toolExecutors.set(tool.name, tool.execute);
      }
    }
  }

  const steps: StepResult[] = [];
  let totalUsage = emptyUsage();
  let round = 0;

  while (true) {
    // Build request
    const request: LLMRequest = {
      model: options.model,
      messages: [...messages],
      provider: options.provider,
      tools: toolDefs,
      tool_choice:
        typeof options.tool_choice === "string"
          ? { mode: options.tool_choice as ToolChoice["mode"] }
          : options.tool_choice,
      response_format: options.response_format,
      temperature: options.temperature,
      top_p: options.top_p,
      max_tokens: options.max_tokens,
      stop_sequences: options.stop_sequences,
      reasoning_effort: options.reasoning_effort,
      provider_options: options.provider_options,
    };

    // Call LLM with retry
    let response: LLMResponse | undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        response = await client.complete(request);
        break;
      } catch (err) {
        lastError = err as Error;
        if (attempt < maxRetries && isRetryable(err as Error)) {
          const delay = Math.min(
            1000 * Math.pow(2, attempt) * (0.5 + Math.random()),
            60000
          );
          await sleep(delay);
          continue;
        }
        throw err;
      }
    }

    if (!response) {
      throw lastError ?? new Error("No response received");
    }

    // Extract tool calls
    const toolCalls = messageToolCalls(response.message);

    // Build step result
    const step: StepResult = {
      response,
      tool_calls: toolCalls,
      tool_results: [],
      usage: response.usage,
    };

    totalUsage = addUsage(totalUsage, response.usage);

    // If no tool calls or no executors, we're done
    if (
      toolCalls.length === 0 ||
      toolExecutors.size === 0 ||
      round >= maxRounds
    ) {
      steps.push(step);
      break;
    }

    // Execute tools
    messages.push(response.message);

    for (const tc of toolCalls) {
      const executor = toolExecutors.get(tc.name);
      let result: string;
      let isError = false;

      if (executor) {
        try {
          const args =
            typeof tc.arguments === "string"
              ? JSON.parse(tc.arguments)
              : tc.arguments;
          result = await executor(args as Record<string, unknown>);
        } catch (err) {
          result = `Error: ${(err as Error).message}`;
          isError = true;
        }
      } else {
        result = `Unknown tool: ${tc.name}`;
        isError = true;
      }

      step.tool_results.push({
        tool_call_id: tc.id,
        content: result,
        is_error: isError,
      });

      messages.push(toolResultMessage(tc.id, result, isError));
    }

    steps.push(step);

    // Check stop condition
    if (options.stop_when && options.stop_when(step)) {
      break;
    }

    round++;
  }

  const lastStep = steps[steps.length - 1]!;
  const lastResponse = lastStep.response;

  return {
    text: messageText(lastResponse.message),
    reasoning: messageReasoning(lastResponse.message),
    tool_calls: lastStep.tool_calls,
    tool_results: lastStep.tool_results,
    finish_reason: lastResponse.finish_reason,
    usage: lastResponse.usage,
    total_usage: totalUsage,
    steps,
    response: lastResponse,
  };
}

export function stream(options: GenerateOptions): StreamResult {
  const client = options.client ?? getDefaultClient();

  if (options.prompt && options.messages) {
    throw new Error("Cannot provide both 'prompt' and 'messages'");
  }

  const messages: Message[] = [];
  if (options.system) {
    messages.push({
      role: Role.SYSTEM,
      content: [{ kind: ContentKind.TEXT, text: options.system }],
    });
  }
  if (options.prompt) {
    messages.push({
      role: Role.USER,
      content: [{ kind: ContentKind.TEXT, text: options.prompt }],
    });
  } else if (options.messages) {
    messages.push(...options.messages);
  }

  const toolDefs: ToolDefinition[] | undefined = options.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const request: LLMRequest = {
    model: options.model,
    messages,
    provider: options.provider,
    tools: toolDefs,
    tool_choice:
      typeof options.tool_choice === "string"
        ? { mode: options.tool_choice as ToolChoice["mode"] }
        : options.tool_choice,
    response_format: options.response_format,
    temperature: options.temperature,
    top_p: options.top_p,
    max_tokens: options.max_tokens,
    stop_sequences: options.stop_sequences,
    reasoning_effort: options.reasoning_effort,
    provider_options: options.provider_options,
  };

  return new StreamResult(client.stream(request));
}

export async function generate_object(
  options: GenerateOptions & { schema: Record<string, unknown> }
): Promise<GenerateResult> {
  const result = await generate({
    ...options,
    response_format: {
      type: "json_schema",
      json_schema: options.schema,
      strict: true,
    },
  });

  // Parse the output
  try {
    result.output = JSON.parse(result.text);
  } catch {
    throw new NoObjectGeneratedError(
      `Failed to parse structured output: ${result.text.substring(0, 200)}`
    );
  }

  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────

function isRetryable(error: Error): boolean {
  if (error instanceof RateLimitError) return true;
  if ("status_code" in error) {
    const status = (error as { status_code?: number }).status_code;
    if (status && status >= 500) return true;
    if (status === 429) return true;
  }
  if (error.message.includes("ECONNRESET")) return true;
  if (error.message.includes("ETIMEDOUT")) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
