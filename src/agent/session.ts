/**
 * Coding Agent Loop – Session Manager
 *
 * Core agentic loop: user input → LLM call → tool execution → loop
 * Handles steering injection, loop detection, multi-turn execution.
 */

import { randomUUID } from "node:crypto";

import type {
  Message,
  LLMRequest,
  LLMResponse,
  ToolDefinition,
} from "../llm/types.js";
import {
  textMessage,
  Role,
  ContentKind,
  emptyUsage,
  addUsage,
} from "../llm/types.js";
import { Client } from "../llm/client.js";

import type {
  Session,
  SessionConfig,
  Turn,
  ToolCall,
  ToolResult,
  RegisteredTool,
  ProviderProfile,
} from "./types.js";
import {
  TurnKind,
  SessionState,
  EventKind,
  EventEmitter,
  DEFAULT_SESSION_CONFIG,
} from "./types.js";
import type { ExecutionEnvironment } from "./execution-env.js";
import { getCoreTools } from "./tools.js";
import { discoverProjectDocs } from "./profiles.js";
import { detectLoop } from "./loop-detection.js";
import { truncateOutput } from "./truncation.js";

// ── Session Factory ────────────────────────────────────────────────────

export interface CreateSessionOptions {
  provider_profile: ProviderProfile;
  execution_env: ExecutionEnvironment;
  llm_client: Client;
  config?: Partial<SessionConfig>;
  extra_tools?: RegisteredTool[];
  system_prompt?: string;
}

export function createSession(opts: CreateSessionOptions): Session {
  const config = { ...DEFAULT_SESSION_CONFIG, ...opts.config };
  const tools = new Map<string, RegisteredTool>();

  // Register core tools
  for (const tool of getCoreTools()) {
    tools.set(tool.definition.name, tool);
  }

  // Register extra tools
  if (opts.extra_tools) {
    for (const tool of opts.extra_tools) {
      tools.set(tool.definition.name, tool);
    }
  }

  return {
    id: randomUUID(),
    provider_profile: opts.provider_profile,
    execution_env: opts.execution_env,
    history: [],
    events: new EventEmitter(),
    config,
    state: SessionState.IDLE,
    llm_client: opts.llm_client,
    steering_queue: [],
    followup_queue: [],
    total_usage: emptyUsage(),
    tools,
  };
}

// ── Core Agent Loop ────────────────────────────────────────────────────

export interface AgentResponse {
  /** Final text response from the assistant */
  text: string;
  /** All turns executed during this interaction */
  turns: Turn[];
  /** Whether the agent completed naturally or was stopped */
  reason: "complete" | "max_turns" | "loop_detected" | "error" | "cancelled";
  /** Error if reason is "error" */
  error?: Error;
}

/**
 * Process a user message through the full agentic loop.
 */
export async function processInput(
  session: Session,
  userMessage: string
): Promise<AgentResponse> {
  const turns: Turn[] = [];

  // Emit session start if first input
  if (session.history.length === 0) {
    emitEvent(session, EventKind.SESSION_START, {});
  }

  session.state = SessionState.RUNNING;
  emitEvent(session, EventKind.STATE_CHANGE, { state: session.state });

  // Add user turn
  const userMsg = textMessage(Role.USER, userMessage);
  const userTurn: Turn = {
    kind: TurnKind.USER,
    message: userMsg,
    timestamp: Date.now(),
  };
  session.history.push(userTurn);
  turns.push(userTurn);

  let turnCount = 0;
  let lastText = "";

  try {
    while (turnCount < session.config.max_turns) {
      // Drain steering queue
      drainSteering(session, turns);

      // Build LLM request
      const request = buildLLMRequest(session);

      emitEvent(session, EventKind.TURN_START, {
        turn_number: turnCount,
      });

      emitEvent(session, EventKind.LLM_REQUEST, {
        model: request.model,
        message_count: request.messages.length,
      });

      // Call LLM
      let response: LLMResponse;
      try {
        response = await session.llm_client.complete(request);
      } catch (err: any) {
        emitEvent(session, EventKind.LLM_ERROR, {
          error: err.message,
        });
        throw err;
      }

      // Track usage
      if (response.usage) {
        session.total_usage = addUsage(session.total_usage, response.usage);
      }

      emitEvent(session, EventKind.LLM_RESPONSE, {
        finish_reason: response.finish_reason,
        usage: response.usage,
      });

      // Extract tool calls from response
      const toolCalls = extractToolCalls(response);
      const normalizedToolCalls =
        session.provider_profile.normalizeToolCalls(toolCalls);

      // Extract text content
      const textContent = extractText(response);
      if (textContent) {
        lastText = textContent;
      }

      // Create assistant turn
      const assistantTurn: Turn = {
        kind: TurnKind.ASSISTANT,
        message: response.message,
        response,
        tool_calls: normalizedToolCalls,
        timestamp: Date.now(),
      };
      session.history.push(assistantTurn);
      turns.push(assistantTurn);

      emitEvent(session, EventKind.TURN_END, {
        turn_number: turnCount,
        has_tool_calls: normalizedToolCalls.length > 0,
      });

      // If no tool calls, we're done
      if (normalizedToolCalls.length === 0) {
        session.state = SessionState.COMPLETED;
        emitEvent(session, EventKind.STATE_CHANGE, {
          state: session.state,
        });
        return { text: lastText, turns, reason: "complete" };
      }

      // Check loop detection
      if (session.config.loop_detection) {
        const loopResult = detectLoop(
          session.history,
          session.config.loop_window,
          session.config.loop_threshold
        );
        if (loopResult.is_loop) {
          emitEvent(session, EventKind.LOOP_DETECTED, {
            similarity: loopResult.similarity,
            pattern: loopResult.pattern_description,
          });

          // Inject steering to break the loop
          const loopMsg = textMessage(
            Role.USER,
            `[SYSTEM] Loop detected: you appear to be repeating the same actions ` +
              `(${loopResult.pattern_description}). Please try a different approach ` +
              `or explain what is blocking you.`
          );
          session.steering_queue.push(loopMsg);
        }
      }

      // Execute tool calls
      session.state = SessionState.TOOL_EXECUTION;
      emitEvent(session, EventKind.STATE_CHANGE, {
        state: session.state,
      });

      const results = await executeToolCalls(session, normalizedToolCalls);

      // Create tool results turn
      const toolTurn: Turn = {
        kind: TurnKind.TOOL_RESULTS,
        results,
        timestamp: Date.now(),
      };
      session.history.push(toolTurn);
      turns.push(toolTurn);

      session.state = SessionState.RUNNING;
      turnCount++;
    }

    // Max turns reached
    session.state = SessionState.COMPLETED;
    return {
      text: lastText || "Maximum turns reached.",
      turns,
      reason: "max_turns",
    };
  } catch (err: any) {
    session.state = SessionState.ERROR;
    emitEvent(session, EventKind.STATE_CHANGE, {
      state: session.state,
      error: err.message,
    });
    return {
      text: lastText || "",
      turns,
      reason: "error",
      error: err,
    };
  }
}

// ── Steering ───────────────────────────────────────────────────────────

function drainSteering(session: Session, turns: Turn[]): void {
  while (session.steering_queue.length > 0) {
    const msg = session.steering_queue.shift()!;
    const turn: Turn = {
      kind: TurnKind.STEERING,
      message: msg,
      timestamp: Date.now(),
    };
    session.history.push(turn);
    turns.push(turn);
    emitEvent(session, EventKind.STEERING_INJECTED, {
      content: msg.content,
    });
  }
}

/**
 * Inject a steering message into the session (will be picked up next loop).
 */
export function injectSteering(session: Session, message: string): void {
  const msg = textMessage(Role.USER, `[STEERING] ${message}`);
  session.steering_queue.push(msg);
}

/**
 * Queue a follow-up task for after the current task completes.
 */
export function queueFollowup(session: Session, message: string): void {
  const msg = textMessage(Role.USER, message);
  session.followup_queue.push(msg);
  emitEvent(session, EventKind.FOLLOWUP_QUEUED, { message });
}

// ── Build LLM Request ──────────────────────────────────────────────────

function buildLLMRequest(session: Session): LLMRequest {
  const profile = session.provider_profile;
  const env = session.execution_env;

  // Build system prompt
  const projectDocs = discoverProjectDocs(env.workingDirectory());
  const toolNames = [...session.tools.keys()];
  const systemPrompt = profile.buildSystemPrompt({
    cwd: env.workingDirectory(),
    platform: env.platform(),
    os_version: env.osVersion(),
    tool_names: toolNames,
    project_docs: projectDocs,
    date: new Date().toISOString().split("T")[0]!,
  });

  // Convert history to messages
  const messages = historyToMessages(session);

  // Map tools
  const toolDefs = profile.mapTools([...session.tools.values()]);

  return {
    model: profile.model,
    messages,
    tools: toolDefs,
    max_tokens: 16384,
    temperature: 0,
  };
}

function historyToMessages(session: Session): Message[] {
  const messages: Message[] = [];

  for (const turn of session.history) {
    switch (turn.kind) {
      case TurnKind.USER:
      case TurnKind.SYSTEM:
      case TurnKind.STEERING:
        messages.push(turn.message);
        break;

      case TurnKind.ASSISTANT:
        messages.push(turn.message);
        break;

      case TurnKind.TOOL_RESULTS:
        // Convert tool results to a tool result message
        messages.push({
          role: Role.USER,
          content: turn.results.map((r) => ({
            kind: ContentKind.TOOL_RESULT,
            tool_call_id: r.tool_call_id,
            content: r.output,
            is_error: r.is_error,
          })),
        });
        break;
    }
  }

  return messages;
}

// ── Tool Execution ─────────────────────────────────────────────────────

async function executeToolCalls(
  session: Session,
  toolCalls: ToolCall[]
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];

  // Limit tool calls per turn
  const limited = toolCalls.slice(0, session.config.max_tool_calls_per_turn);

  for (const tc of limited) {
    emitEvent(session, EventKind.TOOL_CALL, {
      tool_call_id: tc.id,
      tool_name: tc.name,
      arguments: tc.arguments,
    });

    const registered = session.tools.get(tc.name);

    if (!registered) {
      const result: ToolResult = {
        tool_call_id: tc.id,
        tool_name: tc.name,
        output: `Error: Unknown tool '${tc.name}'. Available tools: ${[...session.tools.keys()].join(", ")}`,
        is_error: true,
      };
      results.push(result);
      emitEvent(session, EventKind.TOOL_ERROR, {
        tool_call_id: tc.id,
        error: result.output,
      });
      continue;
    }

    try {
      // Execute with timeout
      const output = await withTimeout(
        registered.handler(tc.arguments, session.execution_env),
        session.config.tool_timeout_ms,
        `Tool '${tc.name}' timed out after ${session.config.tool_timeout_ms}ms`
      );

      const result: ToolResult = {
        tool_call_id: tc.id,
        tool_name: tc.name,
        output,
        is_error: false,
      };
      results.push(result);

      emitEvent(session, EventKind.TOOL_RESULT, {
        tool_call_id: tc.id,
        tool_name: tc.name,
        output_length: output.length,
      });
    } catch (err: any) {
      const result: ToolResult = {
        tool_call_id: tc.id,
        tool_name: tc.name,
        output: `Error: ${err.message}`,
        is_error: true,
      };
      results.push(result);

      emitEvent(session, EventKind.TOOL_ERROR, {
        tool_call_id: tc.id,
        tool_name: tc.name,
        error: err.message,
      });
    }
  }

  return results;
}

// ── Extract Tool Calls ─────────────────────────────────────────────────

function extractToolCalls(response: LLMResponse): ToolCall[] {
  const calls: ToolCall[] = [];

  if (!response.message.content) return calls;

  const content = Array.isArray(response.message.content)
    ? response.message.content
    : [response.message.content];

  for (const part of content) {
    if (typeof part === "object" && part.kind === ContentKind.TOOL_CALL) {
      calls.push({
        id: part.tool_call?.id ?? randomUUID(),
        name: part.tool_call?.name ?? "",
        arguments: (typeof part.tool_call?.arguments === 'object' ? part.tool_call?.arguments : {}) as Record<string, unknown>,
      });
    }
  }

  return calls;
}

function extractText(response: LLMResponse): string {
  if (!response.message.content) return "";

  const content = Array.isArray(response.message.content)
    ? response.message.content
    : [response.message.content];

  const textParts: string[] = [];

  for (const part of content) {
    if (typeof part === "string") {
      textParts.push(part);
    } else if (typeof part === "object" && part.kind === ContentKind.TEXT) {
      textParts.push(part.text ?? "");
    }
  }

  return textParts.join("");
}

// ── Helpers ────────────────────────────────────────────────────────────

function emitEvent(
  session: Session,
  kind: EventKind,
  data: Record<string, unknown>
): void {
  session.events.emit({
    kind,
    session_id: session.id,
    timestamp: Date.now(),
    data,
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);

    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
