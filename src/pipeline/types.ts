/**
 * Pipeline Graph Model & Types
 *
 * The runtime representation of a parsed Attractor pipeline.
 */

// ── Node shapes → handler mapping ──────────────────────────────────────

export enum NodeShape {
  /** Default rectangle — codergen / LLM task */
  BOX = "box",
  /** Ellipse — start node */
  ELLIPSE = "ellipse",
  /** Diamond — conditional branch */
  DIAMOND = "diamond",
  /** Hexagon — wait-for-human */
  HEXAGON = "hexagon",
  /** Component — parallel fan-out */
  COMPONENT = "component",
  /** Triple-octagon — fan-in / join */
  TRIPLEOCTAGON = "tripleoctagon",
  /** Double-circle — exit / terminal */
  DOUBLECIRCLE = "doublecircle",
  /** Plain — tool invocation */
  PLAIN = "plain",
  /** Note — annotation (ignored) */
  NOTE = "note",
}

// ── Graph Node ─────────────────────────────────────────────────────────

export interface PipelineNode {
  id: string;
  label: string;
  shape: NodeShape;
  /** Type hint from type attribute */
  type?: string;
  /** Handler name override */
  handler?: string;
  /** Raw DOT attributes */
  attrs: Record<string, string>;
  /** CSS classes from class attribute */
  classes: string[];
  /** Model override from model attribute */
  model?: string;
  /** Prompt text or template */
  prompt?: string;
  /** Goal gate text */
  goal?: string;
  /** Max retries for this node */
  max_retries?: number;
}

// ── Graph Edge ─────────────────────────────────────────────────────────

export interface PipelineEdge {
  from: string;
  to: string;
  label?: string;
  /** Condition expression for conditional edges */
  condition?: string;
  /** Priority for edge selection (lower = higher priority) */
  priority?: number;
  /** Accelerator key (e.g. "y" for yes) */
  accelerator?: string;
  /** Raw DOT attributes */
  attrs: Record<string, string>;
}

// ── Pipeline Graph ─────────────────────────────────────────────────────

export interface PipelineGraph {
  id: string;
  nodes: Map<string, PipelineNode>;
  edges: PipelineEdge[];
  /** Graph-level attributes */
  attrs: Record<string, string>;
  /** Start node ID */
  start_node: string;
  /** Terminal node IDs */
  terminal_nodes: string[];
}

// ── Pipeline Context (shared state) ────────────────────────────────────

export interface PipelineContext {
  /** Variables shared across nodes */
  variables: Map<string, unknown>;
  /** Outcome of the most recent node */
  outcome: string;
  /** Outcome label for display */
  preferred_label: string;
  /** Node execution results log */
  results: NodeResult[];
  /** Current model (may be overridden by stylesheet) */
  current_model?: string;
  /** Pipeline-level metadata */
  metadata: Record<string, unknown>;
}

export interface NodeResult {
  node_id: string;
  outcome: string;
  label: string;
  output: string;
  duration_ms: number;
  retries: number;
  error?: string;
}

// ── Execution State ────────────────────────────────────────────────────

export enum RunState {
  PARSE = "parse",
  VALIDATE = "validate",
  INITIALIZE = "initialize",
  EXECUTE = "execute",
  FINALIZE = "finalize",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export interface RunStatus {
  state: RunState;
  current_node?: string;
  nodes_executed: number;
  nodes_total: number;
  start_time: number;
  elapsed_ms: number;
  errors: string[];
}

// ── Pipeline Events ────────────────────────────────────────────────────

export enum PipelineEventKind {
  RUN_START = "run_start",
  RUN_END = "run_end",
  NODE_ENTER = "node_enter",
  NODE_EXIT = "node_exit",
  NODE_RETRY = "node_retry",
  EDGE_SELECT = "edge_select",
  GOAL_GATE_CHECK = "goal_gate_check",
  GOAL_GATE_FAIL = "goal_gate_fail",
  HUMAN_WAIT = "human_wait",
  HUMAN_RESPONSE = "human_response",
  CONTEXT_UPDATE = "context_update",
  ERROR = "error",
  AGENT_EVENT = "agent_event",
}

export interface PipelineEvent {
  kind: PipelineEventKind;
  pipeline_id: string;
  node_id?: string;
  timestamp: number;
  data: Record<string, unknown>;
}

// ── Backoff Config ─────────────────────────────────────────────────────

export interface BackoffConfig {
  initial_delay_ms: number;
  max_delay_ms: number;
  multiplier: number;
  max_retries: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  initial_delay_ms: 1000,
  max_delay_ms: 30000,
  multiplier: 2,
  max_retries: 3,
};
