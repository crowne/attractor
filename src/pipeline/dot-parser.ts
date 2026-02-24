/**
 * DOT Parser
 *
 * Parses a subset of the Graphviz DOT language used by Attractor pipelines.
 * Supports: digraph, node declarations, edges (->), chained edges,
 * attributes ([key=value]), subgraphs, comments (//, /* *​/).
 *
 * BNF (simplified):
 *   graph     → "digraph" ID? "{" stmt_list "}"
 *   stmt_list → (stmt ";"?)*
 *   stmt      → node_stmt | edge_stmt | attr_stmt | subgraph
 *   node_stmt → ID attr_list?
 *   edge_stmt → ID ("->" ID)+ attr_list?
 *   attr_list → "[" (ID "=" ID ("," | ";")?)* "]"
 *   subgraph  → "subgraph" ID? "{" stmt_list "}"
 *   attr_stmt → ("graph" | "node" | "edge") attr_list
 */

// ── AST Types ──────────────────────────────────────────────────────────

export interface DotGraph {
  type: "digraph";
  id?: string;
  nodes: DotNode[];
  edges: DotEdge[];
  subgraphs: DotSubgraph[];
  graph_attrs: Record<string, string>;
  node_defaults: Record<string, string>;
  edge_defaults: Record<string, string>;
}

export interface DotNode {
  id: string;
  attrs: Record<string, string>;
}

export interface DotEdge {
  from: string;
  to: string;
  attrs: Record<string, string>;
}

export interface DotSubgraph {
  id?: string;
  nodes: DotNode[];
  edges: DotEdge[];
  attrs: Record<string, string>;
}

// ── Token Types ────────────────────────────────────────────────────────

enum TokenType {
  DIGRAPH = "digraph",
  SUBGRAPH = "subgraph",
  GRAPH = "graph",
  NODE = "node",
  EDGE = "edge",
  LBRACE = "{",
  RBRACE = "}",
  LBRACKET = "[",
  RBRACKET = "]",
  EQUALS = "=",
  ARROW = "->",
  SEMICOLON = ";",
  COMMA = ",",
  ID = "id",
  STRING = "string",
  EOF = "eof",
}

interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

// ── Lexer ──────────────────────────────────────────────────────────────

class Lexer {
  private pos = 0;
  private line = 1;
  private col = 1;
  private tokens: Token[] = [];

  constructor(private input: string) {}

  tokenize(): Token[] {
    while (this.pos < this.input.length) {
      this.skipWhitespaceAndComments();
      if (this.pos >= this.input.length) break;

      const ch = this.input[this.pos];

      // Single-char tokens
      if (ch === "{") {
        this.tokens.push(this.makeToken(TokenType.LBRACE, "{"));
        this.advance();
        continue;
      }
      if (ch === "}") {
        this.tokens.push(this.makeToken(TokenType.RBRACE, "}"));
        this.advance();
        continue;
      }
      if (ch === "[") {
        this.tokens.push(this.makeToken(TokenType.LBRACKET, "["));
        this.advance();
        continue;
      }
      if (ch === "]") {
        this.tokens.push(this.makeToken(TokenType.RBRACKET, "]"));
        this.advance();
        continue;
      }
      if (ch === "=") {
        this.tokens.push(this.makeToken(TokenType.EQUALS, "="));
        this.advance();
        continue;
      }
      if (ch === ";") {
        this.tokens.push(this.makeToken(TokenType.SEMICOLON, ";"));
        this.advance();
        continue;
      }
      if (ch === ",") {
        this.tokens.push(this.makeToken(TokenType.COMMA, ","));
        this.advance();
        continue;
      }

      // Arrow ->
      if (ch === "-" && this.peek(1) === ">") {
        this.tokens.push(this.makeToken(TokenType.ARROW, "->"));
        this.advance();
        this.advance();
        continue;
      }

      // Quoted string
      if (ch === '"') {
        this.tokens.push(this.readString());
        continue;
      }

      // ID or keyword
      if (this.isIdStart(ch!)) {
        this.tokens.push(this.readId());
        continue;
      }

      // Number (treat as ID)
      if (this.isDigit(ch!) || (ch === "-" && this.isDigit(this.peek(1) ?? ""))) {
        this.tokens.push(this.readNumber());
        continue;
      }

      // Unknown character — skip
      this.advance();
    }

    this.tokens.push(this.makeToken(TokenType.EOF, ""));
    return this.tokens;
  }

  private makeToken(type: TokenType, value: string): Token {
    return { type, value, line: this.line, col: this.col };
  }

  private advance(): void {
    if (this.input[this.pos] === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    this.pos++;
  }

  private peek(offset = 0): string | undefined {
    return this.input[this.pos + offset];
  }

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];

      // Whitespace
      if (/\s/.test(ch!)) {
        this.advance();
        continue;
      }

      // Line comment //
      if (ch === "/" && this.peek(1) === "/") {
        while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
          this.advance();
        }
        continue;
      }

      // Block comment /* ... */
      if (ch === "/" && this.peek(1) === "*") {
        this.advance(); // /
        this.advance(); // *
        while (this.pos < this.input.length) {
          if (this.input[this.pos] === "*" && this.peek(1) === "/") {
            this.advance(); // *
            this.advance(); // /
            break;
          }
          this.advance();
        }
        continue;
      }

      // # line comment (common in some DOT dialects)
      if (ch === "#") {
        while (this.pos < this.input.length && this.input[this.pos] !== "\n") {
          this.advance();
        }
        continue;
      }

      break;
    }
  }

  private readString(): Token {
    const startLine = this.line;
    const startCol = this.col;
    this.advance(); // opening quote

    let value = "";
    while (this.pos < this.input.length && this.input[this.pos] !== '"') {
      if (this.input[this.pos] === "\\") {
        this.advance();
        const escaped = this.input[this.pos];
        switch (escaped) {
          case "n":
            value += "\n";
            break;
          case "t":
            value += "\t";
            break;
          case "\\":
            value += "\\";
            break;
          case '"':
            value += '"';
            break;
          default:
            value += escaped;
        }
      } else {
        value += this.input[this.pos];
      }
      this.advance();
    }

    if (this.pos < this.input.length) {
      this.advance(); // closing quote
    }

    return { type: TokenType.STRING, value, line: startLine, col: startCol };
  }

  private readId(): Token {
    const startLine = this.line;
    const startCol = this.col;
    let value = "";

    while (
      this.pos < this.input.length &&
      this.isIdChar(this.input[this.pos]!)
    ) {
      value += this.input[this.pos];
      this.advance();
    }

    // Check keywords
    const type = this.keywordType(value);
    return { type, value, line: startLine, col: startCol };
  }

  private readNumber(): Token {
    const startLine = this.line;
    const startCol = this.col;
    let value = "";

    if (this.input[this.pos] === "-") {
      value += "-";
      this.advance();
    }

    while (
      this.pos < this.input.length &&
      (this.isDigit(this.input[this.pos]!) || this.input[this.pos] === ".")
    ) {
      value += this.input[this.pos];
      this.advance();
    }

    return { type: TokenType.ID, value, line: startLine, col: startCol };
  }

  private isIdStart(ch: string): boolean {
    return /[a-zA-Z_]/.test(ch);
  }

  private isIdChar(ch: string): boolean {
    return /[a-zA-Z0-9_]/.test(ch);
  }

  private isDigit(ch: string): boolean {
    return /[0-9]/.test(ch);
  }

  private keywordType(value: string): TokenType {
    switch (value.toLowerCase()) {
      case "digraph":
        return TokenType.DIGRAPH;
      case "subgraph":
        return TokenType.SUBGRAPH;
      case "graph":
        return TokenType.GRAPH;
      case "node":
        return TokenType.NODE;
      case "edge":
        return TokenType.EDGE;
      default:
        return TokenType.ID;
    }
  }
}

// ── Parser ─────────────────────────────────────────────────────────────

export class DotParseError extends Error {
  constructor(
    message: string,
    public line: number,
    public col: number
  ) {
    super(`DOT parse error at ${line}:${col}: ${message}`);
    this.name = "DotParseError";
  }
}

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): DotGraph {
    return this.parseGraph();
  }

  private parseGraph(): DotGraph {
    this.expect(TokenType.DIGRAPH);
    let id: string | undefined;
    if (this.check(TokenType.ID) || this.check(TokenType.STRING)) {
      id = this.current().value;
      this.advance();
    }
    this.expect(TokenType.LBRACE);

    const graph: DotGraph = {
      type: "digraph",
      id,
      nodes: [],
      edges: [],
      subgraphs: [],
      graph_attrs: {},
      node_defaults: {},
      edge_defaults: {},
    };

    this.parseStmtList(graph);
    this.expect(TokenType.RBRACE);

    return graph;
  }

  private parseStmtList(graph: DotGraph): void {
    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
      this.parseStmt(graph);
      this.optional(TokenType.SEMICOLON);
    }
  }

  private parseStmt(graph: DotGraph): void {
    // Attribute statement: graph/node/edge [...]
    if (this.check(TokenType.GRAPH)) {
      this.advance();
      const attrs = this.parseAttrList();
      Object.assign(graph.graph_attrs, attrs);
      return;
    }
    if (this.check(TokenType.NODE)) {
      this.advance();
      const attrs = this.parseAttrList();
      Object.assign(graph.node_defaults, attrs);
      return;
    }
    if (this.check(TokenType.EDGE)) {
      this.advance();
      const attrs = this.parseAttrList();
      Object.assign(graph.edge_defaults, attrs);
      return;
    }

    // Subgraph
    if (this.check(TokenType.SUBGRAPH)) {
      graph.subgraphs.push(this.parseSubgraph());
      return;
    }

    // Node or edge statement
    if (this.check(TokenType.ID) || this.check(TokenType.STRING)) {
      const id = this.current().value;
      this.advance();

      // Edge statement: id -> id -> ... [attrs]
      if (this.check(TokenType.ARROW)) {
        const nodeIds = [id];
        while (this.check(TokenType.ARROW)) {
          this.advance();
          if (
            !this.check(TokenType.ID) &&
            !this.check(TokenType.STRING)
          ) {
            this.error("Expected node ID after '->'");
          }
          nodeIds.push(this.current().value);
          this.advance();
        }

        const attrs = this.check(TokenType.LBRACKET)
          ? this.parseAttrList()
          : {};

        // Create edges for chain
        for (let i = 0; i < nodeIds.length - 1; i++) {
          graph.edges.push({
            from: nodeIds[i]!,
            to: nodeIds[i + 1]!,
            attrs: { ...graph.edge_defaults, ...attrs },
          });

          // Auto-declare nodes
          this.ensureNode(graph, nodeIds[i]!);
          this.ensureNode(graph, nodeIds[i + 1]!);
        }
        return;
      }

      // Node declaration: id [attrs]
      const attrs = this.check(TokenType.LBRACKET)
        ? this.parseAttrList()
        : {};

      const existing = graph.nodes.find((n) => n.id === id);
      if (existing) {
        Object.assign(existing.attrs, attrs);
      } else {
        graph.nodes.push({
          id,
          attrs: { ...graph.node_defaults, ...attrs },
        });
      }
      return;
    }

    // Skip unknown tokens
    this.advance();
  }

  private parseSubgraph(): DotSubgraph {
    this.expect(TokenType.SUBGRAPH);
    let id: string | undefined;
    if (this.check(TokenType.ID) || this.check(TokenType.STRING)) {
      id = this.current().value;
      this.advance();
    }
    this.expect(TokenType.LBRACE);

    const subgraph: DotSubgraph = {
      id,
      nodes: [],
      edges: [],
      attrs: {},
    };

    // Parse subgraph body as a temporary graph
    const tempGraph: DotGraph = {
      type: "digraph",
      nodes: [],
      edges: [],
      subgraphs: [],
      graph_attrs: {},
      node_defaults: {},
      edge_defaults: {},
    };

    while (!this.check(TokenType.RBRACE) && !this.check(TokenType.EOF)) {
      this.parseStmt(tempGraph);
      this.optional(TokenType.SEMICOLON);
    }

    this.expect(TokenType.RBRACE);

    subgraph.nodes = tempGraph.nodes;
    subgraph.edges = tempGraph.edges;
    subgraph.attrs = tempGraph.graph_attrs;

    return subgraph;
  }

  private parseAttrList(): Record<string, string> {
    const attrs: Record<string, string> = {};

    if (!this.check(TokenType.LBRACKET)) return attrs;
    this.advance();

    while (!this.check(TokenType.RBRACKET) && !this.check(TokenType.EOF)) {
      // Read key
      if (
        !this.check(TokenType.ID) &&
        !this.check(TokenType.STRING)
      ) {
        break;
      }
      const key = this.current().value;
      this.advance();

      this.expect(TokenType.EQUALS);

      // Read value
      if (
        !this.check(TokenType.ID) &&
        !this.check(TokenType.STRING) &&
        !this.check(TokenType.NODE) &&
        !this.check(TokenType.EDGE) &&
        !this.check(TokenType.GRAPH)
      ) {
        this.error("Expected attribute value");
      }
      const value = this.current().value;
      this.advance();

      attrs[key] = value;

      // Optional comma or semicolon separator
      this.optional(TokenType.COMMA);
      this.optional(TokenType.SEMICOLON);
    }

    this.expect(TokenType.RBRACKET);
    return attrs;
  }

  private ensureNode(graph: DotGraph, id: string): void {
    if (!graph.nodes.find((n) => n.id === id)) {
      graph.nodes.push({
        id,
        attrs: { ...graph.node_defaults },
      });
    }
  }

  // ── Token helpers ──

  private current(): Token {
    return this.tokens[this.pos] ?? {
      type: TokenType.EOF,
      value: "",
      line: 0,
      col: 0,
    };
  }

  private check(type: TokenType): boolean {
    return this.current().type === type;
  }

  private advance(): Token {
    const tok = this.current();
    this.pos++;
    return tok;
  }

  private expect(type: TokenType): Token {
    if (!this.check(type)) {
      const tok = this.current();
      this.error(`Expected '${type}', got '${tok.type}' (${tok.value})`);
    }
    return this.advance();
  }

  private optional(type: TokenType): boolean {
    if (this.check(type)) {
      this.advance();
      return true;
    }
    return false;
  }

  private error(message: string): never {
    const tok = this.current();
    throw new DotParseError(message, tok.line, tok.col);
  }
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Parse a DOT language string into a DotGraph AST.
 */
export function parseDot(input: string): DotGraph {
  const lexer = new Lexer(input);
  const tokens = lexer.tokenize();
  const parser = new Parser(tokens);
  return parser.parse();
}
