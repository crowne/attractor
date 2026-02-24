/**
 * Pipeline Validator / Linter
 *
 * Validates pipeline graph structure. Checks:
 * - start_node exists
 * - terminal_node exists
 * - reachability from start to all nodes
 * - edge targets exist
 * - condition syntax (basic)
 * - diamond nodes have >=2 outgoing edges
 * - fan-in nodes have >=2 incoming edges
 */

import type { PipelineGraph, PipelineNode, PipelineEdge } from "./types.js";
import { NodeShape } from "./types.js";

// ── Diagnostic ─────────────────────────────────────────────────────────

export enum Severity {
  ERROR = "error",
  WARNING = "warning",
  INFO = "info",
}

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  node_id?: string;
  edge?: { from: string; to: string };
}

// ── Validate ───────────────────────────────────────────────────────────

export function validatePipeline(graph: PipelineGraph): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // 1. Start node exists
  if (!graph.start_node) {
    diagnostics.push({
      severity: Severity.ERROR,
      code: "NO_START_NODE",
      message: "Pipeline has no start node. Add a node with shape=ellipse.",
    });
  } else if (!graph.nodes.has(graph.start_node)) {
    diagnostics.push({
      severity: Severity.ERROR,
      code: "START_NODE_MISSING",
      message: `Start node '${graph.start_node}' not found in graph.`,
    });
  }

  // 2. Terminal nodes exist
  if (graph.terminal_nodes.length === 0) {
    diagnostics.push({
      severity: Severity.WARNING,
      code: "NO_TERMINAL_NODE",
      message:
        "Pipeline has no terminal node. Add a node with shape=doublecircle.",
    });
  }

  // 3. Edge targets exist
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.from)) {
      diagnostics.push({
        severity: Severity.ERROR,
        code: "EDGE_SOURCE_MISSING",
        message: `Edge source '${edge.from}' not found in graph.`,
        edge: { from: edge.from, to: edge.to },
      });
    }
    if (!graph.nodes.has(edge.to)) {
      diagnostics.push({
        severity: Severity.ERROR,
        code: "EDGE_TARGET_MISSING",
        message: `Edge target '${edge.to}' not found in graph.`,
        edge: { from: edge.from, to: edge.to },
      });
    }
  }

  // 4. Reachability
  if (graph.start_node && graph.nodes.has(graph.start_node)) {
    const reachable = computeReachable(graph, graph.start_node);
    for (const [id] of graph.nodes) {
      if (!reachable.has(id)) {
        diagnostics.push({
          severity: Severity.WARNING,
          code: "UNREACHABLE_NODE",
          message: `Node '${id}' is not reachable from start node.`,
          node_id: id,
        });
      }
    }
  }

  // 5. Diamond nodes should have >=2 outgoing edges
  for (const [id, node] of graph.nodes) {
    if (node.shape === NodeShape.DIAMOND) {
      const outgoing = graph.edges.filter((e) => e.from === id);
      if (outgoing.length < 2) {
        diagnostics.push({
          severity: Severity.WARNING,
          code: "DIAMOND_FEW_EDGES",
          message: `Conditional node '${id}' should have at least 2 outgoing edges, has ${outgoing.length}.`,
          node_id: id,
        });
      }
    }
  }

  // 6. Fan-in (tripleoctagon) should have >=2 incoming edges
  for (const [id, node] of graph.nodes) {
    if (node.shape === NodeShape.TRIPLEOCTAGON) {
      const incoming = graph.edges.filter((e) => e.to === id);
      if (incoming.length < 2) {
        diagnostics.push({
          severity: Severity.WARNING,
          code: "FANIN_FEW_EDGES",
          message: `Fan-in node '${id}' should have at least 2 incoming edges, has ${incoming.length}.`,
          node_id: id,
        });
      }
    }
  }

  // 7. Condition syntax check (basic)
  for (const edge of graph.edges) {
    if (edge.condition) {
      try {
        validateConditionSyntax(edge.condition);
      } catch (err: any) {
        diagnostics.push({
          severity: Severity.ERROR,
          code: "INVALID_CONDITION",
          message: `Invalid condition on edge ${edge.from} -> ${edge.to}: ${err.message}`,
          edge: { from: edge.from, to: edge.to },
        });
      }
    }
  }

  // 8. No self-loops
  for (const edge of graph.edges) {
    if (edge.from === edge.to) {
      diagnostics.push({
        severity: Severity.WARNING,
        code: "SELF_LOOP",
        message: `Self-loop detected on node '${edge.from}'.`,
        node_id: edge.from,
      });
    }
  }

  return diagnostics;
}

// ── Reachability via BFS ───────────────────────────────────────────────

function computeReachable(
  graph: PipelineGraph,
  startNode: string
): Set<string> {
  const visited = new Set<string>();
  const queue = [startNode];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    for (const edge of graph.edges) {
      if (edge.from === current && !visited.has(edge.to)) {
        queue.push(edge.to);
      }
    }
  }

  return visited;
}

// ── Condition syntax validation ────────────────────────────────────────

function validateConditionSyntax(condition: string): void {
  // Supported operators: =, !=, &&, ||
  // Supported variables: outcome, preferred_label, context.*
  // Simple validation — just check it's not empty and has valid structure
  const trimmed = condition.trim();
  if (!trimmed) {
    throw new Error("Empty condition");
  }

  // Check for balanced parentheses
  let depth = 0;
  for (const ch of trimmed) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth < 0) throw new Error("Unbalanced parentheses");
  }
  if (depth !== 0) throw new Error("Unbalanced parentheses");

  // Check for valid comparison operators
  const hasOperator = /[=!<>]|&&|\|\|/.test(trimmed);
  const isSimpleValue = /^[a-zA-Z0-9_."']+$/.test(trimmed);
  if (!hasOperator && !isSimpleValue) {
    throw new Error(
      "Condition must contain a comparison operator or be a simple value"
    );
  }
}

/**
 * Check if any diagnostics are errors.
 */
export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === Severity.ERROR);
}

/**
 * Format diagnostics for display.
 */
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      let loc = "";
      if (d.node_id) loc = ` [node: ${d.node_id}]`;
      if (d.edge) loc = ` [edge: ${d.edge.from} -> ${d.edge.to}]`;
      return `${d.severity.toUpperCase()}: ${d.code}${loc} - ${d.message}`;
    })
    .join("\n");
}
