/**
 * Model Stylesheet
 *
 * CSS-like selectors for assigning models and parameters to pipeline nodes.
 *
 * Syntax:
 *   * { model: "claude-opus-4-20250514"; }
 *   .fast { model: "claude-sonnet-4-20250514"; temperature: 0; }
 *   #review { model: "gpt-4.1"; }
 *
 * Specificity: #id (100) > .class (10) > * (1)
 */

export interface StyleRule {
  selector: StyleSelector;
  properties: Record<string, string>;
  specificity: number;
}

export interface StyleSelector {
  type: "universal" | "class" | "id";
  value: string;
}

export interface ComputedStyle {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  [key: string]: unknown;
}

// ── Parse Stylesheet ───────────────────────────────────────────────────

export function parseStylesheet(input: string): StyleRule[] {
  const rules: StyleRule[] = [];
  // Remove comments
  const cleaned = input.replace(/\/\*.*?\*\//gs, "").replace(/\/\/.*/g, "");

  // Match rule blocks: selector { properties }
  const ruleRegex = /([^{]+)\{([^}]*)\}/g;
  let match;

  while ((match = ruleRegex.exec(cleaned)) !== null) {
    const selectorStr = match[1]!.trim();
    const propsStr = match[2]!.trim();

    const selector = parseSelector(selectorStr);
    const properties = parseProperties(propsStr);

    rules.push({
      selector,
      properties,
      specificity: computeSpecificity(selector),
    });
  }

  return rules;
}

function parseSelector(str: string): StyleSelector {
  if (str === "*") {
    return { type: "universal", value: "*" };
  }
  if (str.startsWith("#")) {
    return { type: "id", value: str.slice(1) };
  }
  if (str.startsWith(".")) {
    return { type: "class", value: str.slice(1) };
  }
  // Treat as ID
  return { type: "id", value: str };
}

function parseProperties(str: string): Record<string, string> {
  const props: Record<string, string> = {};
  const pairs = str.split(";").filter(Boolean);

  for (const pair of pairs) {
    const colonIdx = pair.indexOf(":");
    if (colonIdx === -1) continue;

    const key = pair.slice(0, colonIdx).trim();
    let value = pair.slice(colonIdx + 1).trim();

    // Remove quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    props[key] = value;
  }

  return props;
}

function computeSpecificity(selector: StyleSelector): number {
  switch (selector.type) {
    case "id":
      return 100;
    case "class":
      return 10;
    case "universal":
      return 1;
  }
}

// ── Apply Styles ───────────────────────────────────────────────────────

/**
 * Compute the effective style for a node given the stylesheet rules.
 */
export function computeNodeStyle(
  nodeId: string,
  nodeClasses: string[],
  rules: StyleRule[]
): ComputedStyle {
  // Collect matching rules sorted by specificity
  const matching: StyleRule[] = [];

  for (const rule of rules) {
    if (selectorMatches(rule.selector, nodeId, nodeClasses)) {
      matching.push(rule);
    }
  }

  // Sort by specificity (lower first, so later ones override)
  matching.sort((a, b) => a.specificity - b.specificity);

  // Merge properties
  const style: ComputedStyle = {};
  for (const rule of matching) {
    for (const [key, value] of Object.entries(rule.properties)) {
      switch (key) {
        case "model":
          style.model = value;
          break;
        case "temperature":
          style.temperature = parseFloat(value);
          break;
        case "max_tokens":
          style.max_tokens = parseInt(value, 10);
          break;
        case "reasoning_effort":
          style.reasoning_effort = value;
          break;
        default:
          style[key] = value;
      }
    }
  }

  return style;
}

function selectorMatches(
  selector: StyleSelector,
  nodeId: string,
  nodeClasses: string[]
): boolean {
  switch (selector.type) {
    case "universal":
      return true;
    case "id":
      return nodeId === selector.value;
    case "class":
      return nodeClasses.includes(selector.value);
  }
}
