/**
 * Verbose Logger — pretty-prints PipelineEvent streams to the console.
 *
 * Usage:
 * ```ts
 * import { Attractor, createVerboseLogger } from "attractor";
 *
 * const attractor = await Attractor.create({
 *   dotFile: "./pipeline.dot",
 *   provider: "ollama",
 *   model: "qwen3-coder:30b",
 *   onEvent: createVerboseLogger(),
 * });
 * ```
 */

import type { PipelineEvent } from "./types.js";
import { PipelineEventKind } from "./types.js";

// ── Colour helpers (ANSI 256) ──────────────────────────────────────────

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const WHITE = "\x1b[37m";

function ts(): string {
  return DIM + new Date().toISOString().slice(11, 23) + RESET;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ── Logger Factory ─────────────────────────────────────────────────────

export interface VerboseLoggerOptions {
  /** Show agent-level events (LLM requests, tool calls, etc.) */
  showAgentEvents?: boolean;
  /** Show full tool call arguments (can be very verbose) */
  showToolArgs?: boolean;
  /** Custom prefix for all log lines */
  prefix?: string;
}

/**
 * Create a verbose event logger suitable for passing to `onEvent`.
 *
 * Returns a `(event: PipelineEvent) => void` function.
 */
export function createVerboseLogger(
  opts: VerboseLoggerOptions = {}
): (event: PipelineEvent) => void {
  const showAgent = opts.showAgentEvents ?? true;
  const showToolArgs = opts.showToolArgs ?? false;
  const prefix = opts.prefix ?? "pipeline";

  const tag = `${DIM}[${prefix}]${RESET}`;

  return (event: PipelineEvent) => {
    const t = ts();
    const nodeTag = event.node_id
      ? `${CYAN}${event.node_id}${RESET}`
      : "";

    switch (event.kind) {
      // ── Pipeline lifecycle ─────────────────────────────────────────
      case PipelineEventKind.RUN_START:
        console.log(
          `${t} ${tag} ${BOLD}${GREEN}RUN_START${RESET}`
        );
        break;

      case PipelineEventKind.RUN_END:
        console.log(
          `${t} ${tag} ${BOLD}${GREEN}RUN_END${RESET}  state=${event.data.state}  nodes=${event.data.nodes_executed}` +
            (Array.isArray(event.data.errors) && event.data.errors.length > 0
              ? `  ${RED}errors=${event.data.errors.length}${RESET}`
              : "")
        );
        break;

      // ── Node lifecycle ─────────────────────────────────────────────
      case PipelineEventKind.NODE_ENTER:
        console.log(
          `${t} ${tag} ${BOLD}${BLUE}NODE_ENTER${RESET}  → ${nodeTag}  ${DIM}(${event.data.shape}: "${event.data.label}")${RESET}`
        );
        break;

      case PipelineEventKind.NODE_EXIT:
        console.log(
          `${t} ${tag} ${BLUE}NODE_EXIT${RESET}   → ${nodeTag}  outcome=${WHITE}${event.data.outcome}${RESET}  ${DIM}(${event.data.duration_ms}ms)${RESET}`
        );
        break;

      case PipelineEventKind.NODE_RETRY: {
        console.log(
          `${t} ${tag} ${YELLOW}NODE_RETRY${RESET}  → ${nodeTag}  attempt=${event.data.retry}/${event.data.max_retries}  ${DIM}${event.data.error}${RESET}`
        );
        break;
      }

      // ── Edge selection ─────────────────────────────────────────────
      case PipelineEventKind.EDGE_SELECT:
        console.log(
          `${t} ${tag} ${MAGENTA}EDGE${RESET}        ${CYAN}${event.data.from}${RESET} → ${CYAN}${event.data.to}${RESET}  ${DIM}(outcome=${event.data.outcome})${RESET}`
        );
        break;

      // ── Goal gates ─────────────────────────────────────────────────
      case PipelineEventKind.GOAL_GATE_CHECK:
        console.log(
          `${t} ${tag} ${YELLOW}GOAL_CHECK${RESET}  → ${nodeTag}  goal="${event.data.goal}"`
        );
        break;

      case PipelineEventKind.GOAL_GATE_FAIL:
        console.log(
          `${t} ${tag} ${RED}GOAL_FAIL${RESET}   → ${nodeTag}  goal="${event.data.goal}"`
        );
        break;

      // ── Human-in-the-loop ──────────────────────────────────────────
      case PipelineEventKind.HUMAN_WAIT:
        console.log(
          `${t} ${tag} ${YELLOW}HUMAN_WAIT${RESET}  → ${nodeTag}`
        );
        break;

      case PipelineEventKind.HUMAN_RESPONSE:
        console.log(
          `${t} ${tag} ${GREEN}HUMAN_RESP${RESET}  → ${nodeTag}  answer="${event.data.answer}"`
        );
        break;

      // ── Errors ─────────────────────────────────────────────────────
      case PipelineEventKind.ERROR:
        console.log(
          `${t} ${tag} ${RED}ERROR${RESET}       → ${nodeTag}  ${event.data.message}`
        );
        break;

      // ── Agent events (forwarded from session) ──────────────────────
      case PipelineEventKind.AGENT_EVENT: {
        if (!showAgent) break;

        const agentKind = String(event.data.agent_event_kind ?? "");

        switch (agentKind) {
          case "turn_start":
            console.log(
              `${t} ${tag}   ${DIM}AGENT${RESET} ${WHITE}turn_start${RESET}  → ${nodeTag}  turn=${event.data.turn_number}`
            );
            break;

          case "llm_request":
            console.log(
              `${t} ${tag}   ${DIM}AGENT${RESET} ${CYAN}llm_request${RESET} → ${nodeTag}  model=${event.data.model}  messages=${event.data.message_count}`
            );
            break;

          case "llm_response":
            console.log(
              `${t} ${tag}   ${DIM}AGENT${RESET} ${GREEN}llm_response${RESET} → ${nodeTag}  finish=${event.data.finish_reason}  usage=${JSON.stringify(event.data.usage ?? {})}`
            );
            break;

          case "llm_error":
            console.log(
              `${t} ${tag}   ${DIM}AGENT${RESET} ${RED}llm_error${RESET}   → ${nodeTag}  ${event.data.error}`
            );
            break;

          case "tool_call":
            console.log(
              `${t} ${tag}   ${DIM}AGENT${RESET} ${MAGENTA}tool_call${RESET}   → ${nodeTag}  ${event.data.tool_name}` +
                (showToolArgs && event.data.args
                  ? `  args=${JSON.stringify(event.data.args)}`
                  : "")
            );
            break;

          case "tool_result":
            console.log(
              `${t} ${tag}   ${DIM}AGENT${RESET} ${GREEN}tool_result${RESET} → ${nodeTag}  length=${event.data.output_length}`
            );
            break;

          case "tool_error":
            console.log(
              `${t} ${tag}   ${DIM}AGENT${RESET} ${RED}tool_error${RESET}  → ${nodeTag}  ${event.data.error}`
            );
            break;

          case "loop_detected":
            console.log(
              `${t} ${tag}   ${DIM}AGENT${RESET} ${YELLOW}loop_detected${RESET} → ${nodeTag}`
            );
            break;

          case "steering_injected":
            console.log(
              `${t} ${tag}   ${DIM}AGENT${RESET} ${YELLOW}steering${RESET}    → ${nodeTag}`
            );
            break;

          case "state_change":
            // Usually noisy — skip unless explicitly verbose
            break;

          default:
            console.log(
              `${t} ${tag}   ${DIM}AGENT${RESET} ${DIM}${agentKind}${RESET} → ${nodeTag}`
            );
        }
        break;
      }

      default:
        console.log(
          `${t} ${tag} ${DIM}${event.kind}${RESET}  ${nodeTag}  ${JSON.stringify(event.data)}`
        );
    }
  };
}
