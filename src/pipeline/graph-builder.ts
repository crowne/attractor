/**
 * Pipeline Graph Builder
 *
 * Converts a parsed DotGraph into a PipelineGraph with
 * typed nodes, edges, and validated structure.
 */

import type { DotGraph, DotNode, DotEdge } from "./dot-parser.js";
import {
  type PipelineGraph,
  type PipelineNode,
  type PipelineEdge,
  NodeShape,
} from "./types.js";

// ── Shape mapping ──────────────────────────────────────────────────────

const SHAPE_MAP: Record<string, NodeShape> = {
  box: NodeShape.BOX,
  rect: NodeShape.BOX,
  rectangle: NodeShape.BOX,
  ellipse: NodeShape.ELLIPSE,
  oval: NodeShape.ELLIPSE,
  circle: NodeShape.ELLIPSE,
  diamond: NodeShape.DIAMOND,
  hexagon: NodeShape.HEXAGON,
  component: NodeShape.COMPONENT,
  tripleoctagon: NodeShape.TRIPLEOCTAGON,
  doublecircle: NodeShape.DOUBLECIRCLE,
  plain: NodeShape.PLAIN,
  plaintext: NodeShape.PLAIN,
  note: NodeShape.NOTE,
};

function resolveShape(attrs: Record<string, string>): NodeShape {
  const shape = attrs["shape"]?.toLowerCase();
  if (shape && shape in SHAPE_MAP) {
    return SHAPE_MAP[shape] ?? NodeShape.BOX;
  }
  return NodeShape.BOX; // default
}

// ── Parse accelerator key from edge label ──────────────────────────────

function parseAccelerator(label?: string): string | undefined {
  if (!label) return undefined;
  // Match patterns like "(y) Yes" or "[y]" or "y:"
  const match = label.match(/^\((\w)\)|^\[(\w)\]|^(\w):/);
  if (match) {
    return match[1] ?? match[2] ?? match[3];
  }
  return undefined;
}

// ── Build Pipeline Graph ───────────────────────────────────────────────

export function buildPipelineGraph(dot: DotGraph): PipelineGraph {
  const nodes = new Map<string, PipelineNode>();
  const edges: PipelineEdge[] = [];

  // Process nodes
  for (const dotNode of dot.nodes) {
    const node = buildNode(dotNode);
    nodes.set(node.id, node);
  }

  // Also process subgraph nodes
  for (const sub of dot.subgraphs) {
    for (const dotNode of sub.nodes) {
      const node = buildNode(dotNode);
      nodes.set(node.id, node);
    }
    for (const dotEdge of sub.edges) {
      edges.push(buildEdge(dotEdge));
    }
  }

  // Process edges
  for (const dotEdge of dot.edges) {
    edges.push(buildEdge(dotEdge));
  }

  // Find start node: look for shape=ellipse or id containing "start"
  let startNode = "";
  for (const [id, node] of nodes) {
    if (node.shape === NodeShape.ELLIPSE) {
      startNode = id;
      break;
    }
  }
  if (!startNode) {
    // Fallback: find node with no incoming edges
    const hasIncoming = new Set(edges.map((e) => e.to));
    for (const id of nodes.keys()) {
      if (!hasIncoming.has(id)) {
        startNode = id;
        break;
      }
    }
  }
  if (!startNode && nodes.size > 0) {
    startNode = nodes.keys().next().value!;
  }

  // Find terminal nodes: doublecircle or no outgoing edges
  const terminalNodes: string[] = [];
  const hasOutgoing = new Set(edges.map((e) => e.from));
  for (const [id, node] of nodes) {
    if (
      node.shape === NodeShape.DOUBLECIRCLE ||
      !hasOutgoing.has(id)
    ) {
      terminalNodes.push(id);
    }
  }

  return {
    id: dot.id ?? "pipeline",
    nodes,
    edges,
    attrs: dot.graph_attrs,
    start_node: startNode,
    terminal_nodes: terminalNodes,
  };
}

function buildNode(dotNode: DotNode): PipelineNode {
  const attrs = dotNode.attrs;
  const shape = resolveShape(attrs);
  const classes = (attrs["class"] ?? "")
    .split(/\s+/)
    .filter(Boolean);

  return {
    id: dotNode.id,
    label: attrs["label"] ?? dotNode.id,
    shape,
    type: attrs["type"],
    handler: attrs["handler"],
    attrs,
    classes,
    model: attrs["model"],
    prompt: attrs["prompt"],
    goal: attrs["goal"],
    max_retries: attrs["max_retries"]
      ? parseInt(attrs["max_retries"], 10)
      : undefined,
  };
}

function buildEdge(dotEdge: DotEdge): PipelineEdge {
  const label = dotEdge.attrs["label"];
  return {
    from: dotEdge.from,
    to: dotEdge.to,
    label,
    condition: dotEdge.attrs["condition"],
    priority: dotEdge.attrs["priority"]
      ? parseInt(dotEdge.attrs["priority"], 10)
      : undefined,
    accelerator: parseAccelerator(label),
    attrs: dotEdge.attrs,
  };
}
