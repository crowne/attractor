/**
 * Output Truncation
 *
 * Two-pass truncation:
 * 1. Character-level: head/tail split with omission marker
 * 2. Line-level: further reduction if still too large
 */

import { TRUNCATION_LIMITS, type TruncationConfig } from "./types.js";

const OMISSION_MARKER =
  "\n\n... [output truncated: {omitted} characters omitted] ...\n\n";

/**
 * Truncate tool output to fit within limits.
 */
export function truncateOutput(
  output: string,
  toolName: string
): string {
  const config =
    TRUNCATION_LIMITS[toolName] ?? TRUNCATION_LIMITS["default"]!;

  if (output.length <= config!.max_chars) {
    return output;
  }

  // Pass 1: character-level truncation
  let result = charTruncate(output, config!);

  // Pass 2: line-level truncation (if configured)
  if (config!.max_lines) {
    result = lineTruncate(result, config!.max_lines);
  }

  return result;
}

function charTruncate(output: string, config: TruncationConfig): string {
  const headSize = Math.floor(config.max_chars * config.head_ratio);
  const tailSize = config.max_chars - headSize;
  const omitted = output.length - headSize - tailSize;

  const marker = OMISSION_MARKER.replace("{omitted}", String(omitted));

  return output.slice(0, headSize) + marker + output.slice(-tailSize);
}

function lineTruncate(output: string, maxLines: number): string {
  const lines = output.split("\n");
  if (lines.length <= maxLines) {
    return output;
  }

  const headLines = Math.floor(maxLines * 0.7);
  const tailLines = maxLines - headLines;
  const omitted = lines.length - headLines - tailLines;

  return [
    ...lines.slice(0, headLines),
    `\n... [${omitted} lines omitted] ...\n`,
    ...lines.slice(-tailLines),
  ].join("\n");
}
