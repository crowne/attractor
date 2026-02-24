/**
 * Loop Detection
 *
 * Detects when the agent is stuck repeating similar actions.
 * Uses Jaccard similarity on recent tool call sequences.
 */

import type { Turn, TurnKind, ToolCall } from "./types.js";

export interface LoopDetectionResult {
  is_loop: boolean;
  similarity: number;
  pattern_description?: string;
}

/**
 * Check if the recent turns show a repeating pattern.
 */
export function detectLoop(
  history: Turn[],
  windowSize: number,
  threshold: number
): LoopDetectionResult {
  // Collect recent assistant turns with tool calls
  const recentAssistant = history
    .filter(
      (t): t is Extract<Turn, { kind: typeof TurnKind.ASSISTANT }> =>
        t.kind === ("assistant" as any)
    )
    .slice(-windowSize * 2);

  if (recentAssistant.length < windowSize) {
    return { is_loop: false, similarity: 0 };
  }

  // Split into two halves
  const midpoint = Math.floor(recentAssistant.length / 2);
  const firstHalf = recentAssistant.slice(0, midpoint);
  const secondHalf = recentAssistant.slice(midpoint);

  // Create fingerprints from tool calls
  const firstFingerprints = fingerprint(firstHalf);
  const secondFingerprints = fingerprint(secondHalf);

  // Calculate Jaccard similarity
  const similarity = jaccardSimilarity(firstFingerprints, secondFingerprints);

  if (similarity >= threshold) {
    return {
      is_loop: true,
      similarity,
      pattern_description: describePattern(secondHalf),
    };
  }

  return { is_loop: false, similarity };
}

/**
 * Create a set of fingerprints from tool calls in turns.
 */
function fingerprint(turns: any[]): Set<string> {
  const prints = new Set<string>();
  for (const turn of turns) {
    if (turn.tool_calls) {
      for (const tc of turn.tool_calls) {
        // Fingerprint = tool name + sorted argument keys
        const argKeys = Object.keys(tc.arguments || {}).sort().join(",");
        prints.add(`${tc.name}(${argKeys})`);

        // Also add specific arg values for file paths
        if (tc.arguments?.file_path) {
          prints.add(`${tc.name}:${tc.arguments.file_path}`);
        }
        if (tc.arguments?.command) {
          prints.add(`shell:${tc.arguments.command}`);
        }
      }
    }
  }
  return prints;
}

/**
 * Jaccard similarity between two sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Describe the detected pattern for logging.
 */
function describePattern(turns: any[]): string {
  const toolNames = new Set<string>();
  for (const turn of turns) {
    if (turn.tool_calls) {
      for (const tc of turn.tool_calls) {
        toolNames.add(tc.name);
      }
    }
  }

  return `Repeated tool calls: ${[...toolNames].join(", ")} over ${turns.length} turns`;
}
