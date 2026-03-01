/**
 * Node Handlers
 *
 * Each pipeline node shape maps to a handler that knows how to execute it.
 * Handlers receive the node, context, and runtime services.
 */

import { randomUUID } from "node:crypto";

import type { PipelineNode, PipelineContext, NodeResult } from "./types.js";
import { NodeShape, PipelineEventKind } from "./types.js";
import type { Interviewer, Question, QuestionChoice } from "./human.js";
import type { ComputedStyle } from "./stylesheet.js";

// ── Handler Interface ──────────────────────────────────────────────────

export interface NodeHandlerContext {
  /** The node being executed */
  node: PipelineNode;
  /** Pipeline shared context */
  context: PipelineContext;
  /** Computed style for this node */
  style: ComputedStyle;
  /** Human interviewer (for wait-for-human nodes) */
  interviewer: Interviewer;
  /** Codergen backend (for LLM task nodes) */
  codergen: CodergenBackend;
  /** Event emitter */
  emit: (kind: PipelineEventKind, data: Record<string, unknown>) => void;
  /** Get outgoing edges */
  getOutgoingEdges: () => Array<{ to: string; label?: string }>;
}

export type NodeHandler = (
  ctx: NodeHandlerContext
) => Promise<NodeResult>;

// ── Codergen Backend ───────────────────────────────────────────────────

/**
 * Interface for LLM-backed code generation.
 * Wraps the agent loop for pipeline use.
 */
export interface CodergenBackend {
  /**
   * Execute an LLM task with the given prompt.
   * Returns the output text and outcome.
   */
  execute(opts: {
    prompt: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
    goal?: string;
    node_id: string;
  }): Promise<{
    output: string;
    outcome: string;
  }>;
}

// ── Handler Registry ───────────────────────────────────────────────────

const handlers = new Map<string, NodeHandler>();

export function registerHandler(
  shape: string,
  handler: NodeHandler
): void {
  handlers.set(shape, handler);
}

export function getHandler(shape: string): NodeHandler | undefined {
  return handlers.get(shape);
}

// ── Start Node Handler (ellipse) ───────────────────────────────────────

registerHandler(NodeShape.ELLIPSE, async (ctx) => {
  const startTime = Date.now();

  ctx.emit(PipelineEventKind.NODE_ENTER, {
    node_id: ctx.node.id,
    type: "start",
  });

  return {
    node_id: ctx.node.id,
    outcome: "success",
    label: ctx.node.label,
    output: "Pipeline started",
    duration_ms: Date.now() - startTime,
    retries: 0,
  };
});

// ── Exit Node Handler (doublecircle) ───────────────────────────────────

registerHandler(NodeShape.DOUBLECIRCLE, async (ctx) => {
  const startTime = Date.now();

  ctx.emit(PipelineEventKind.NODE_EXIT, {
    node_id: ctx.node.id,
    type: "exit",
  });

  return {
    node_id: ctx.node.id,
    outcome: "success",
    label: ctx.node.label,
    output: "Pipeline completed",
    duration_ms: Date.now() - startTime,
    retries: 0,
  };
});

// ── Codergen Handler (box/rect — LLM task) ─────────────────────────────

registerHandler(NodeShape.BOX, async (ctx) => {
  const startTime = Date.now();

  ctx.emit(PipelineEventKind.NODE_ENTER, {
    node_id: ctx.node.id,
    type: "codergen",
  });

  // Build prompt from node label/prompt/goal
  let prompt = ctx.node.prompt ?? ctx.node.label;

  // Substitute context variables in prompt
  prompt = substituteVariables(prompt, ctx.context);

  // Add goal gate if specified
  const goal = ctx.node.goal;

  try {
    const result = await ctx.codergen.execute({
      prompt,
      model: ctx.style.model ?? ctx.node.model,
      temperature: ctx.style.temperature,
      max_tokens: ctx.style.max_tokens,
      goal,
      node_id: ctx.node.id,
    });

    // Check goal gate
    if (goal) {
      ctx.emit(PipelineEventKind.GOAL_GATE_CHECK, {
        node_id: ctx.node.id,
        goal,
      });

      // Simple goal check: if the output mentions failure or error
      const goalMet = !result.outcome.includes("fail");
      if (!goalMet) {
        ctx.emit(PipelineEventKind.GOAL_GATE_FAIL, {
          node_id: ctx.node.id,
          goal,
          output: result.output,
        });
      }
    }

    return {
      node_id: ctx.node.id,
      outcome: result.outcome,
      label: ctx.node.label,
      output: result.output,
      duration_ms: Date.now() - startTime,
      retries: 0,
    };
  } catch (err: any) {
    return {
      node_id: ctx.node.id,
      outcome: "error",
      label: ctx.node.label,
      output: "",
      duration_ms: Date.now() - startTime,
      retries: 0,
      error: err.message,
    };
  }
});

// ── Conditional Handler (diamond) ──────────────────────────────────────

registerHandler(NodeShape.DIAMOND, async (ctx) => {
  const startTime = Date.now();

  ctx.emit(PipelineEventKind.NODE_ENTER, {
    node_id: ctx.node.id,
    type: "conditional",
  });

  // If the diamond node has a prompt, run it through the LLM to determine
  // the outcome (e.g. a review / gate node). Otherwise fall through with
  // the current context outcome.
  if (ctx.node.prompt) {
    let prompt = substituteVariables(ctx.node.prompt, ctx.context);

    try {
      const result = await ctx.codergen.execute({
        prompt,
        model: ctx.style.model ?? ctx.node.model,
        temperature: ctx.style.temperature,
        max_tokens: ctx.style.max_tokens,
        goal: ctx.node.goal,
        node_id: ctx.node.id,
      });

      // Parse the LLM output to extract the outcome keyword.
      // Convention: the first word of the response is the outcome label
      // (e.g. "approved", "needs_work"). Fall back to full output.
      const raw = result.output.trim();
      const firstWord = raw.split(/\s+/)[0]?.toLowerCase() ?? raw;

      return {
        node_id: ctx.node.id,
        outcome: firstWord,
        label: ctx.node.label,
        output: raw,
        duration_ms: Date.now() - startTime,
        retries: 0,
      };
    } catch (err: any) {
      return {
        node_id: ctx.node.id,
        outcome: "error",
        label: ctx.node.label,
        output: "",
        duration_ms: Date.now() - startTime,
        retries: 0,
        error: err.message,
      };
    }
  }

  // No prompt — pass through with existing outcome
  return {
    node_id: ctx.node.id,
    outcome: ctx.context.outcome,
    label: ctx.node.label,
    output: `Condition evaluated. Outcome: ${ctx.context.outcome}`,
    duration_ms: Date.now() - startTime,
    retries: 0,
  };
});

// ── Wait-for-Human Handler (hexagon) ───────────────────────────────────

registerHandler(NodeShape.HEXAGON, async (ctx) => {
  const startTime = Date.now();

  ctx.emit(PipelineEventKind.HUMAN_WAIT, {
    node_id: ctx.node.id,
  });

  // Build question from node and outgoing edges
  const outEdges = ctx.getOutgoingEdges();
  const choices: QuestionChoice[] = outEdges.map((edge) => ({
    label: edge.label ?? edge.to,
    value: edge.label ?? edge.to,
    accelerator: undefined, // extracted from label by the parser
  }));

  const question: Question = {
    id: ctx.node.id,
    text: ctx.node.label,
    choices: choices.length > 0 ? choices : undefined,
    metadata: { node_id: ctx.node.id },
  };

  const answer = await ctx.interviewer.ask(question);

  ctx.emit(PipelineEventKind.HUMAN_RESPONSE, {
    node_id: ctx.node.id,
    answer: answer.value,
  });

  // Set the outcome and preferred_label based on the answer
  ctx.context.outcome = answer.value;
  ctx.context.preferred_label = answer.value;

  return {
    node_id: ctx.node.id,
    outcome: answer.value,
    label: ctx.node.label,
    output: `Human response: ${answer.value}`,
    duration_ms: Date.now() - startTime,
    retries: 0,
  };
});

// ── Parallel Handler (component — fan-out) ─────────────────────────────

registerHandler(NodeShape.COMPONENT, async (ctx) => {
  const startTime = Date.now();

  ctx.emit(PipelineEventKind.NODE_ENTER, {
    node_id: ctx.node.id,
    type: "parallel",
  });

  // Fan-out: signal that all outgoing edges should be taken simultaneously
  // The actual parallelism is handled by the engine

  return {
    node_id: ctx.node.id,
    outcome: "fan_out",
    label: ctx.node.label,
    output: "Parallel fan-out initiated",
    duration_ms: Date.now() - startTime,
    retries: 0,
  };
});

// ── Fan-In Handler (tripleoctagon — join) ──────────────────────────────

registerHandler(NodeShape.TRIPLEOCTAGON, async (ctx) => {
  const startTime = Date.now();

  ctx.emit(PipelineEventKind.NODE_ENTER, {
    node_id: ctx.node.id,
    type: "fan_in",
  });

  // Fan-in: wait for all parallel branches to complete
  // The engine tracks branch completion

  return {
    node_id: ctx.node.id,
    outcome: "success",
    label: ctx.node.label,
    output: "All parallel branches joined",
    duration_ms: Date.now() - startTime,
    retries: 0,
  };
});

// ── Tool Handler (plain) ──────────────────────────────────────────────

registerHandler(NodeShape.PLAIN, async (ctx) => {
  const startTime = Date.now();

  ctx.emit(PipelineEventKind.NODE_ENTER, {
    node_id: ctx.node.id,
    type: "tool",
  });

  // Tool nodes run a specific tool from the node's type or handler attribute
  // Delegate to codergen with tool-specific prompt
  const toolName = ctx.node.type ?? ctx.node.handler ?? ctx.node.id;
  const prompt = ctx.node.prompt ?? `Execute tool: ${toolName}`;

  try {
    const result = await ctx.codergen.execute({
      prompt: substituteVariables(prompt, ctx.context),
      model: ctx.style.model,
      node_id: ctx.node.id,
    });

    return {
      node_id: ctx.node.id,
      outcome: result.outcome,
      label: ctx.node.label,
      output: result.output,
      duration_ms: Date.now() - startTime,
      retries: 0,
    };
  } catch (err: any) {
    return {
      node_id: ctx.node.id,
      outcome: "error",
      label: ctx.node.label,
      output: "",
      duration_ms: Date.now() - startTime,
      retries: 0,
      error: err.message,
    };
  }
});

// ── Variable Substitution ──────────────────────────────────────────────

function substituteVariables(
  template: string,
  context: PipelineContext
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (match, path) => {
    const segments = path.split(".");
    if (segments[0] === "context" || segments[0] === "ctx") {
      segments.shift();
    }

    let value: unknown = Object.fromEntries(context.variables);
    for (const seg of segments) {
      if (value == null || typeof value !== "object") return match;
      value = (value as Record<string, unknown>)[seg];
    }

    return value != null ? String(value) : match;
  });
}
