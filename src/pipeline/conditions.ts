/**
 * Condition Expression Evaluator
 *
 * Evaluates edge conditions against the pipeline context.
 *
 * Supported:
 *   outcome = "success"
 *   outcome != "failure"
 *   preferred_label = "Yes"
 *   context.variable = "value"
 *   expr && expr
 *   expr || expr
 *   (expr)
 */

import type { PipelineContext } from "./types.js";

export function evaluateCondition(
  condition: string,
  context: PipelineContext
): boolean {
  const trimmed = condition.trim();
  if (!trimmed) return true;

  try {
    return evalExpr(trimmed, context);
  } catch {
    // If evaluation fails, treat as false
    return false;
  }
}

function evalExpr(expr: string, ctx: PipelineContext): boolean {
  const trimmed = expr.trim();

  // Handle OR (lowest precedence)
  const orParts = splitTopLevel(trimmed, "||");
  if (orParts.length > 1) {
    return orParts.some((part) => evalExpr(part, ctx));
  }

  // Handle AND
  const andParts = splitTopLevel(trimmed, "&&");
  if (andParts.length > 1) {
    return andParts.every((part) => evalExpr(part, ctx));
  }

  // Handle NOT
  if (trimmed.startsWith("!")) {
    return !evalExpr(trimmed.slice(1), ctx);
  }

  // Handle parentheses
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return evalExpr(trimmed.slice(1, -1), ctx);
  }

  // Handle comparison: var op value
  const neqMatch = trimmed.match(/^(.+?)\s*!=\s*(.+)$/);
  if (neqMatch) {
    const left = resolveValue(neqMatch[1]!.trim(), ctx);
    const right = resolveValue(neqMatch[2]!.trim(), ctx);
    return left !== right;
  }

  const eqMatch = trimmed.match(/^(.+?)\s*=\s*(.+)$/);
  if (eqMatch) {
    const left = resolveValue(eqMatch[1]!.trim(), ctx);
    const right = resolveValue(eqMatch[2]!.trim(), ctx);
    return left === right;
  }

  // Truthy check
  const val = resolveValue(trimmed, ctx);
  return Boolean(val);
}

function resolveValue(expr: string, ctx: PipelineContext): unknown {
  const trimmed = expr.trim();

  // String literal
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return parseFloat(trimmed);
  }

  // Boolean literals
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Built-in variables
  if (trimmed === "outcome") return ctx.outcome;
  if (trimmed === "preferred_label") return ctx.preferred_label;

  // Context variables: context.key or context.key.subkey
  if (trimmed.startsWith("context.")) {
    const path = trimmed.slice("context.".length).split(".");
    let value: unknown = Object.fromEntries(ctx.variables);
    for (const segment of path) {
      if (value == null || typeof value !== "object") return undefined;
      value = (value as Record<string, unknown>)[segment];
    }
    return value;
  }

  // Try as variable name
  if (ctx.variables.has(trimmed)) {
    return ctx.variables.get(trimmed);
  }

  // Return as string
  return trimmed;
}

/**
 * Split expression at top-level operator (respecting parentheses).
 */
function splitTopLevel(expr: string, operator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let i = 0;

  while (i < expr.length) {
    if (expr[i] === "(") depth++;
    if (expr[i] === ")") depth--;

    if (
      depth === 0 &&
      expr.slice(i, i + operator.length) === operator
    ) {
      parts.push(current);
      current = "";
      i += operator.length;
      continue;
    }

    current += expr[i];
    i++;
  }

  parts.push(current);
  return parts;
}
