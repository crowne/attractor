/**
 * Coding Agent Loop – Core Types
 *
 * Session, Turn, EventKind, Config, State
 */

import type { Message, ToolDefinition, LLMResponse, Usage } from "../llm/types.js";
import type { ExecutionEnvironment } from "./execution-env.js";
import type { Client } from "../llm/client.js";

// ── Session state ──────────────────────────────────────────────────────

export enum SessionState {
  IDLE = "idle",
  RUNNING = "running",
  TOOL_EXECUTION = "tool_execution",
  WAITING_INPUT = "waiting_input",
  COMPLETED = "completed",
  ERROR = "error",
  CANCELLED = "cancelled",
}

// ── Turn types ─────────────────────────────────────────────────────────

export enum TurnKind {
  USER = "user",
  ASSISTANT = "assistant",
  TOOL_RESULTS = "tool_results",
  SYSTEM = "system",
  STEERING = "steering",
}

export interface UserTurn {
  kind: TurnKind.USER;
  message: Message;
  timestamp: number;
}

export interface AssistantTurn {
  kind: TurnKind.ASSISTANT;
  message: Message;
  response: LLMResponse;
  tool_calls: ToolCall[];
  timestamp: number;
}

export interface ToolResultsTurn {
  kind: TurnKind.TOOL_RESULTS;
  results: ToolResult[];
  timestamp: number;
}

export interface SystemTurn {
  kind: TurnKind.SYSTEM;
  message: Message;
  timestamp: number;
}

export interface SteeringTurn {
  kind: TurnKind.STEERING;
  message: Message;
  timestamp: number;
}

export type Turn =
  | UserTurn
  | AssistantTurn
  | ToolResultsTurn
  | SystemTurn
  | SteeringTurn;

// ── Tool Calls/Results ─────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  tool_name: string;
  output: string;
  is_error: boolean;
}

// ── Tool Handler ───────────────────────────────────────────────────────

export type ToolHandler = (
  args: Record<string, unknown>,
  env: ExecutionEnvironment
) => Promise<string>;

export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

// ── Events ─────────────────────────────────────────────────────────────

export enum EventKind {
  // Session lifecycle
  SESSION_START = "session_start",
  SESSION_END = "session_end",

  // Turn events
  TURN_START = "turn_start",
  TURN_END = "turn_end",

  // LLM events
  LLM_REQUEST = "llm_request",
  LLM_RESPONSE = "llm_response",
  LLM_STREAM_CHUNK = "llm_stream_chunk",
  LLM_ERROR = "llm_error",

  // Tool events
  TOOL_CALL = "tool_call",
  TOOL_RESULT = "tool_result",
  TOOL_ERROR = "tool_error",

  // Steering
  STEERING_INJECTED = "steering_injected",
  FOLLOWUP_QUEUED = "followup_queued",

  // Loop detection
  LOOP_DETECTED = "loop_detected",

  // State changes
  STATE_CHANGE = "state_change",
}

export interface SessionEvent {
  kind: EventKind;
  session_id: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export type EventListener = (event: SessionEvent) => void;

export class EventEmitter {
  private listeners = new Map<EventKind, EventListener[]>();
  private wildcardListeners: EventListener[] = [];

  on(kind: EventKind, listener: EventListener): () => void {
    const list = this.listeners.get(kind) ?? [];
    list.push(listener);
    this.listeners.set(kind, list);
    return () => {
      const idx = list.indexOf(listener);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  onAny(listener: EventListener): () => void {
    this.wildcardListeners.push(listener);
    return () => {
      const idx = this.wildcardListeners.indexOf(listener);
      if (idx >= 0) this.wildcardListeners.splice(idx, 1);
    };
  }

  emit(event: SessionEvent): void {
    const listeners = this.listeners.get(event.kind) ?? [];
    for (const l of listeners) {
      try {
        l(event);
      } catch {
        // Don't let listener errors break the loop
      }
    }
    for (const l of this.wildcardListeners) {
      try {
        l(event);
      } catch {
        // Don't let listener errors break the loop
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
    this.wildcardListeners = [];
  }
}

// ── Session Config ─────────────────────────────────────────────────────

export interface SessionConfig {
  /** Maximum consecutive LLM turns without user input */
  max_turns: number;
  /** Maximum consecutive tool calls in a single turn */
  max_tool_calls_per_turn: number;
  /** Timeout for individual tool execution (ms) */
  tool_timeout_ms: number;
  /** Timeout for LLM response (ms) */
  llm_timeout_ms: number;
  /** Enable loop detection */
  loop_detection: boolean;
  /** Loop detection window size */
  loop_window: number;
  /** Loop similarity threshold (0-1) */
  loop_threshold: number;
  /** Whether streaming is enabled */
  streaming: boolean;
  /** Max output chars for tool results */
  max_tool_output_chars: number;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  max_turns: 200,
  max_tool_calls_per_turn: 50,
  tool_timeout_ms: 120_000,
  llm_timeout_ms: 300_000,
  loop_detection: true,
  loop_window: 6,
  loop_threshold: 0.85,
  streaming: true,
  max_tool_output_chars: 50_000,
};

// ── Provider Profile ───────────────────────────────────────────────────

export interface ProviderProfile {
  /** Provider name (anthropic, openai, gemini) */
  provider: string;
  /** Model to use */
  model: string;
  /** Build the system prompt given context */
  buildSystemPrompt(context: SystemPromptContext): string;
  /** Map core tools to provider-specific tools */
  mapTools(tools: RegisteredTool[]): ToolDefinition[];
  /** Provider-specific post-processing of tool calls */
  normalizeToolCalls(toolCalls: ToolCall[]): ToolCall[];
}

export interface SystemPromptContext {
  /** Working directory */
  cwd: string;
  /** Platform info */
  platform: string;
  /** OS version */
  os_version: string;
  /** Available tool names */
  tool_names: string[];
  /** Project document content (AGENTS.md etc) */
  project_docs: string[];
  /** User-provided system prompt override */
  user_system_prompt?: string;
  /** Current date */
  date: string;
}

// ── Output Truncation ──────────────────────────────────────────────────

export interface TruncationConfig {
  /** Max characters for the output */
  max_chars: number;
  /** Head portion ratio (0-1) */
  head_ratio: number;
  /** Max lines after char truncation */
  max_lines?: number;
}

export const TRUNCATION_LIMITS: Record<string, TruncationConfig> = {
  read_file: { max_chars: 50_000, head_ratio: 0.8 },
  shell: { max_chars: 30_000, head_ratio: 0.6 },
  grep: { max_chars: 20_000, head_ratio: 0.8 },
  list_dir: { max_chars: 10_000, head_ratio: 0.8 },
  default: { max_chars: 30_000, head_ratio: 0.7 },
};

// ── Session ────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  provider_profile: ProviderProfile;
  execution_env: ExecutionEnvironment;
  history: Turn[];
  events: EventEmitter;
  config: SessionConfig;
  state: SessionState;
  llm_client: Client;
  steering_queue: Message[];
  followup_queue: Message[];
  total_usage: Usage;
  tools: Map<string, RegisteredTool>;
}
