/**
 * Pipeline Execution Engine
 *
 * Lifecycle: PARSE → VALIDATE → INITIALIZE → EXECUTE → FINALIZE
 *
 * The engine traverses the graph from start_node, executes handlers,
 * selects edges using a 5-step priority system, and manages context.
 */

import { parseDot } from "./dot-parser.js";
import { buildPipelineGraph } from "./graph-builder.js";
import {
  validatePipeline,
  hasErrors,
  formatDiagnostics,
} from "./validator.js";
import type {
  PipelineGraph,
  PipelineContext,
  NodeResult,
  PipelineEvent,
  BackoffConfig,
  PipelineEdge,
} from "./types.js";
import {
  RunState,
  PipelineEventKind,
  DEFAULT_BACKOFF,
  NodeShape,
} from "./types.js";
import { evaluateCondition } from "./conditions.js";
import {
  parseStylesheet,
  computeNodeStyle,
  type StyleRule,
  type ComputedStyle,
} from "./stylesheet.js";
import { getHandler, type CodergenBackend } from "./handlers.js";
import type { Interviewer } from "./human.js";
import { AutoApproveInterviewer } from "./human.js";

// ── Pipeline Run Config ────────────────────────────────────────────────

export interface PipelineRunConfig {
  /** The DOT source */
  dot_source: string;
  /** Model stylesheet source (optional) */
  stylesheet_source?: string;
  /** Codergen backend (LLM executor) */
  codergen: CodergenBackend;
  /** Human-in-the-loop interviewer */
  interviewer?: Interviewer;
  /** Initial context variables */
  initial_variables?: Record<string, unknown>;
  /** Backoff configuration for retries */
  backoff?: Partial<BackoffConfig>;
  /** Event listener */
  on_event?: (event: PipelineEvent) => void;
  /** Max total nodes to execute (circuit breaker) */
  max_node_executions?: number;
  /** Whether to abort on first error */
  abort_on_error?: boolean;
}

// ── Pipeline Run Result ────────────────────────────────────────────────

export interface PipelineRunResult {
  state: RunState;
  context: PipelineContext;
  graph: PipelineGraph;
  results: NodeResult[];
  duration_ms: number;
  errors: string[];
}

// ── Engine ─────────────────────────────────────────────────────────────

export async function runPipeline(
  config: PipelineRunConfig
): Promise<PipelineRunResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  const backoff: BackoffConfig = {
    ...DEFAULT_BACKOFF,
    ...config.backoff,
  };
  const maxExecutions = config.max_node_executions ?? 1000;
  const abortOnError = config.abort_on_error ?? false;
  const interviewer = config.interviewer ?? new AutoApproveInterviewer();

  const emit = (
    kind: PipelineEventKind,
    data: Record<string, unknown>,
    nodeId?: string
  ) => {
    if (config.on_event) {
      config.on_event({
        kind,
        pipeline_id: "",
        node_id: nodeId,
        timestamp: Date.now(),
        data,
      });
    }
  };

  // ── Phase 1: PARSE ──

  let graph: PipelineGraph;
  try {
    const dotAst = parseDot(config.dot_source);
    graph = buildPipelineGraph(dotAst);
  } catch (err: any) {
    return {
      state: RunState.FAILED,
      context: createEmptyContext(),
      graph: {
        id: "",
        nodes: new Map(),
        edges: [],
        attrs: {},
        start_node: "",
        terminal_nodes: [],
      },
      results: [],
      duration_ms: Date.now() - startTime,
      errors: [`Parse error: ${err.message}`],
    };
  }

  emit(PipelineEventKind.RUN_START, { graph_id: graph.id });

  // ── Phase 2: VALIDATE ──

  const diagnostics = validatePipeline(graph);
  if (hasErrors(diagnostics)) {
    return {
      state: RunState.FAILED,
      context: createEmptyContext(),
      graph,
      results: [],
      duration_ms: Date.now() - startTime,
      errors: [`Validation failed:\n${formatDiagnostics(diagnostics)}`],
    };
  }

  // ── Phase 3: INITIALIZE ──

  const context: PipelineContext = {
    variables: new Map(
      Object.entries(config.initial_variables ?? {})
    ),
    outcome: "",
    preferred_label: "",
    results: [],
    metadata: {},
  };

  // Parse stylesheet
  let styleRules: StyleRule[] = [];
  if (config.stylesheet_source) {
    try {
      styleRules = parseStylesheet(config.stylesheet_source);
    } catch (err: any) {
      errors.push(`Stylesheet parse error: ${err.message}`);
    }
  }

  // ── Phase 4: EXECUTE ──

  let currentNodeId = graph.start_node;
  let executionCount = 0;

  // Track parallel execution
  const parallelBranches = new Map<string, string[]>(); // fan-in node -> pending branches

  while (executionCount < maxExecutions) {
    const node = graph.nodes.get(currentNodeId);
    if (!node) {
      errors.push(`Node '${currentNodeId}' not found`);
      break;
    }

    // Check if this is a terminal node
    if (graph.terminal_nodes.includes(currentNodeId)) {
      emit(PipelineEventKind.NODE_ENTER, {
        node_id: node.id,
        shape: node.shape,
        label: node.label,
      }, node.id);

      // Execute terminal handler
      const handler = getHandler(node.shape);
      if (handler) {
        const style = computeNodeStyle(node.id, node.classes, styleRules);
        const outEdges = graph.edges
          .filter((e) => e.from === node.id)
          .map((e) => ({ to: e.to, label: e.label }));

        const result = await handler({
          node,
          context,
          style,
          interviewer,
          codergen: config.codergen,
          emit: (kind, data) => emit(kind, data, node.id),
          getOutgoingEdges: () => outEdges,
        });

        context.results.push(result);
      }
      break;
    }

    // Get handler for node shape
    const handler = getHandler(node.shape);
    if (!handler) {
      const errMsg = `No handler for shape '${node.shape}' on node '${node.id}'`;
      errors.push(errMsg);
      emit(PipelineEventKind.ERROR, { message: errMsg }, node.id);
      if (abortOnError) break;
      // Try to continue to next node via first edge
      const nextEdge = graph.edges.find((e) => e.from === currentNodeId);
      if (!nextEdge) break;
      currentNodeId = nextEdge.to;
      executionCount++;
      continue;
    }

    emit(PipelineEventKind.NODE_ENTER, {
      node_id: node.id,
      shape: node.shape,
      label: node.label,
    }, node.id);

    // Compute style
    const style = computeNodeStyle(node.id, node.classes, styleRules);

    // Get outgoing edges for the handler
    const outEdges = graph.edges
      .filter((e) => e.from === node.id)
      .map((e) => ({ to: e.to, label: e.label }));

    // Execute with retry
    let result: NodeResult | undefined;
    let retries = 0;
    const maxRetries = node.max_retries ?? backoff.max_retries;

    while (retries <= maxRetries) {
      try {
        result = await handler({
          node,
          context,
          style,
          interviewer,
          codergen: config.codergen,
          emit: (kind, data) => emit(kind, data, node.id),
          getOutgoingEdges: () => outEdges,
        });
        break;
      } catch (err: any) {
        retries++;
        if (retries > maxRetries) {
          result = {
            node_id: node.id,
            outcome: "error",
            label: node.label,
            output: "",
            duration_ms: 0,
            retries,
            error: err.message,
          };
          const retryErr = `Node '${node.id}' failed after ${retries} retries: ${err.message}`;
          errors.push(retryErr);
          emit(PipelineEventKind.ERROR, { message: retryErr }, node.id);
          if (abortOnError) break;
        } else {
          emit(PipelineEventKind.NODE_RETRY, {
            retry: retries,
            max_retries: maxRetries,
            error: err.message,
          }, node.id);

          // Exponential backoff
          const delay = Math.min(
            backoff.initial_delay_ms * Math.pow(backoff.multiplier, retries - 1),
            backoff.max_delay_ms
          );
          await sleep(delay);
        }
      }
    }

    if (!result) break;

    // Update context
    context.outcome = result.outcome;
    context.preferred_label = result.label;
    context.results.push(result);
    result.retries = retries;
    executionCount++;

    emit(
      PipelineEventKind.NODE_EXIT,
      {
        outcome: result.outcome,
        duration_ms: result.duration_ms,
        output: result.output,
      },
      node.id
    );

    // Handle abort on error
    if (result.error && abortOnError) break;

    // Handle parallel fan-out
    if (node.shape === NodeShape.COMPONENT) {
      // Execute all branches in parallel
      const branches = graph.edges.filter((e) => e.from === node.id);

      // Find the fan-in node (tripleoctagon downstream)
      const fanInNode = findFanInNode(graph, node.id);

      if (branches.length > 0) {
        const branchResults = await Promise.all(
          branches.map(async (edge) => {
            // Execute each branch sequentially until fan-in
            return executeBranch(
              graph,
              edge.to,
              fanInNode,
              context,
              styleRules,
              config,
              interviewer,
              emit
            );
          })
        );

        // Merge branch results
        for (const br of branchResults) {
          context.results.push(...br);
        }

        // Continue from fan-in node
        if (fanInNode) {
          currentNodeId = fanInNode;
          continue;
        }
      }

      break; // No branches to take
    }

    // ── Edge Selection (5-step priority) ──
    const nextNodeId = selectEdge(graph, node.id, context);

    if (!nextNodeId) {
      // No edge to follow — stuck
      const edgeErr = `No matching outgoing edge from node '${node.id}' with outcome '${context.outcome}'`;
      errors.push(edgeErr);
      emit(PipelineEventKind.ERROR, { message: edgeErr }, node.id);
      break;
    }

    emit(
      PipelineEventKind.EDGE_SELECT,
      {
        from: node.id,
        to: nextNodeId,
        outcome: context.outcome,
      },
      node.id
    );

    currentNodeId = nextNodeId;
  }

  if (executionCount >= maxExecutions) {
    errors.push(`Circuit breaker: exceeded ${maxExecutions} node executions`);
  }

  // ── Phase 5: FINALIZE ──

  const finalState =
    errors.length > 0 ? RunState.COMPLETED : RunState.COMPLETED;

  emit(PipelineEventKind.RUN_END, {
    state: finalState,
    nodes_executed: executionCount,
    errors,
  });

  return {
    state: errors.some((e) => e.includes("Parse error") || e.includes("Validation"))
      ? RunState.FAILED
      : RunState.COMPLETED,
    context,
    graph,
    results: context.results,
    duration_ms: Date.now() - startTime,
    errors,
  };
}

// ── Edge Selection ─────────────────────────────────────────────────────

/**
 * 5-step edge selection priority:
 * 1. Explicit condition match
 * 2. Label matches preferred_label
 * 3. Label matches outcome
 * 4. Priority-ordered fallback
 * 5. Default/unlabeled edge
 */
function selectEdge(
  graph: PipelineGraph,
  fromNodeId: string,
  context: PipelineContext
): string | undefined {
  const edges = graph.edges.filter((e) => e.from === fromNodeId);

  if (edges.length === 0) return undefined;
  if (edges.length === 1) return edges[0]!.to;

  // Step 1: Explicit condition match
  for (const edge of edges) {
    if (edge.condition) {
      if (evaluateCondition(edge.condition, context)) {
        return edge.to;
      }
    }
  }

  // Step 2: Label matches preferred_label
  if (context.preferred_label) {
    for (const edge of edges) {
      if (edge.label && labelMatches(edge.label, context.preferred_label)) {
        return edge.to;
      }
    }
  }

  // Step 3: Label matches outcome
  if (context.outcome) {
    for (const edge of edges) {
      if (edge.label && labelMatches(edge.label, context.outcome)) {
        return edge.to;
      }
    }
  }

  // Step 4: Priority ordering
  const prioritized = edges
    .filter((e) => e.priority != null)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  if (prioritized.length > 0) {
    return prioritized[0]!.to;
  }

  // Step 5: Default/unlabeled edge
  const unlabeled = edges.filter((e) => !e.label && !e.condition);
  if (unlabeled.length > 0) {
    return unlabeled[0]!.to;
  }

  // Absolute fallback: first edge
  return edges[0]!.to;
}

function labelMatches(edgeLabel: string, value: string): boolean {
  const normalized = edgeLabel.toLowerCase().trim();
  const target = value.toLowerCase().trim();

  // Exact match
  if (normalized === target) return true;

  // Contains match — e.g. edge label "Yes" matches outcome "yes"
  if (normalized.includes(target) || target.includes(normalized)) return true;

  // Accelerator strip — remove (x) prefix
  const stripped = normalized.replace(/^\([a-z]\)\s*/, "");
  if (stripped === target) return true;

  return false;
}

// ── Parallel Branch Execution ──────────────────────────────────────────

function findFanInNode(
  graph: PipelineGraph,
  fanOutNodeId: string
): string | undefined {
  // BFS to find the first tripleoctagon node downstream
  const visited = new Set<string>();
  const queue = graph.edges
    .filter((e) => e.from === fanOutNodeId)
    .map((e) => e.to);

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = graph.nodes.get(nodeId);
    if (node?.shape === NodeShape.TRIPLEOCTAGON) {
      return nodeId;
    }

    for (const edge of graph.edges) {
      if (edge.from === nodeId) {
        queue.push(edge.to);
      }
    }
  }

  return undefined;
}

async function executeBranch(
  graph: PipelineGraph,
  startNodeId: string,
  stopAtNodeId: string | undefined,
  context: PipelineContext,
  styleRules: StyleRule[],
  config: PipelineRunConfig,
  interviewer: Interviewer,
  emit: (kind: PipelineEventKind, data: Record<string, unknown>, nodeId?: string) => void
): Promise<NodeResult[]> {
  const results: NodeResult[] = [];
  let currentNodeId = startNodeId;
  let count = 0;

  while (count < 100) {
    if (currentNodeId === stopAtNodeId) break;

    const node = graph.nodes.get(currentNodeId);
    if (!node) break;

    const handler = getHandler(node.shape);
    if (!handler) break;

    const style = computeNodeStyle(node.id, node.classes, styleRules);
    const outEdges = graph.edges
      .filter((e) => e.from === node.id)
      .map((e) => ({ to: e.to, label: e.label }));

    try {
      const result = await handler({
        node,
        context: { ...context, variables: new Map(context.variables) },
        style,
        interviewer,
        codergen: config.codergen,
        emit: (kind, data) => emit(kind, data, node.id),
        getOutgoingEdges: () => outEdges,
      });

      results.push(result);
      context.outcome = result.outcome;
    } catch (err: any) {
      results.push({
        node_id: node.id,
        outcome: "error",
        label: node.label,
        output: "",
        duration_ms: 0,
        retries: 0,
        error: err.message,
      });
      break;
    }

    // Select next edge
    const next = selectEdge(graph, currentNodeId, context);
    if (!next) break;

    currentNodeId = next;
    count++;
  }

  return results;
}

// ── Helpers ────────────────────────────────────────────────────────────

function createEmptyContext(): PipelineContext {
  return {
    variables: new Map(),
    outcome: "",
    preferred_label: "",
    results: [],
    metadata: {},
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
