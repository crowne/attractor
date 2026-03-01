# Attractor

A DOT-defined pipeline runner for multi-stage AI coding workflows.

Implements three integrated layers:

1. **Unified LLM Client** — Multi-provider SDK supporting Anthropic, OpenAI, Gemini, and Ollama (local models)
2. **Coding Agent Loop** — Agentic tool-use loop with file editing, shell access, and search
3. **Pipeline Engine** — DAG-based workflow orchestration using Graphviz DOT syntax

Based on the [Attractor specification](https://github.com/strongdm/attractor).

## Quick Start

```bash
bun install
bun run build
```

### Run a Pipeline

```typescript
import { Attractor } from "attractor";

const attractor = await Attractor.create({
  dotSource: `
    digraph pipeline {
      start [shape=ellipse, label="Start"]
      implement [shape=box, label="Implement feature", prompt="Add a hello world endpoint"]
      review [shape=diamond, label="Review"]
      done [shape=doublecircle, label="Done"]

      start -> implement -> review
      review -> implement [label="needs_work"]
      review -> done [label="approved"]
    }
  `,
  provider: "anthropic",
  model: "claude-opus-4-20250514",
});

const result = await attractor.run();
console.log(result.state, result.results.length, "nodes executed");
```

### Run a Single Agent Session

```typescript
import { Attractor } from "attractor";

const attractor = await Attractor.create({
  dotSource: "digraph { start [shape=ellipse] }",
  provider: "anthropic",
});

const response = await attractor.runAgent("Create a REST API with Express.js");
console.log(response);
```

### Use the LLM Client Directly

```typescript
import { Client, generate } from "attractor";

const client = Client.fromEnv(); // reads ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
const result = await generate({
  model: "claude-opus-4-20250514",
  prompt: "Explain monads in one paragraph",
  client,
});
console.log(result.text);
```

### Use a Local Model via Ollama

With [Ollama](https://ollama.com) running locally:

```typescript
import { Client } from "attractor";
import { userMessage } from "attractor";

// Auto-detected when Ollama is running (falls back to localhost:11434)
const client = Client.fromEnv();
const response = await client.complete({
  model: "qwen3-coder:30b",
  provider: "ollama",
  messages: [userMessage("Hello!")],
});
console.log(response.message);
```

Or with explicit configuration:

```typescript
import { Client } from "attractor";
import { OllamaAdapter } from "attractor";
import { userMessage } from "attractor";

const client = new Client({
  providers: {
    ollama: new OllamaAdapter({
      base_url: "http://localhost:11434",
      default_model: "qwen3-coder:30b",
    }),
  },
});

const response = await client.complete({
  model: "qwen3-coder:30b",
  provider: "ollama",
  messages: [userMessage("Refactor this function to use async/await")],
  tools: [/* your tool definitions */],
});
```

Run a full agent session with a local model:

```typescript
import { Attractor } from "attractor";

const attractor = await Attractor.create({
  dotSource: "digraph { start [shape=ellipse] }",
  provider: "ollama",
  model: "qwen3-coder:30b",
});

const response = await attractor.runAgent("Add input validation to the user form");
console.log(response);
```

## Architecture

```
┌─────────────────────────────────────────────┐
│            Pipeline Engine (L3)             │
│  DOT parser → Graph → Validator → Engine    │
│  Node handlers, stylesheet, conditions      │
├─────────────────────────────────────────────┤
│           Coding Agent Loop (L2)            │
│  Session → LLM call → Tool exec → Loop     │
│  Provider profiles, steering, loop detect   │
├─────────────────────────────────────────────┤
│          Unified LLM Client (L1)            │
│  Anthropic · OpenAI · Gemini · Ollama        │
│  Streaming, retries, middleware, catalog    │
└─────────────────────────────────────────────┘
```

## Pipeline DOT Syntax

Nodes are typed by shape:

| Shape | Meaning | Handler |
|-------|---------|---------|
| `ellipse` | Start node | Pass-through |
| `box` | LLM/codergen task | Runs agent session |
| `diamond` | Conditional branch | Evaluates outcome |
| `hexagon` | Wait for human | Prompts user |
| `component` | Parallel fan-out | Runs branches concurrently |
| `tripleoctagon` | Fan-in / join | Waits for all branches |
| `doublecircle` | Exit / terminal | Ends pipeline |
| `plain` | Tool invocation | Runs specific tool |

### Edge Selection (5-step priority)

1. Explicit condition match (`condition` attribute)
2. Label matches `preferred_label`
3. Label matches `outcome`
4. Priority ordering (`priority` attribute)
5. Default/unlabeled edge

### Model Stylesheet

```css
* { model: "claude-sonnet-4-20250514"; temperature: 0; }
.fast { model: "claude-haiku-4-20250514"; }
#review { model: "claude-opus-4-20250514"; reasoning_effort: "high"; }
```

## Environment Variables

| Variable | Provider | Required |
|----------|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | Yes |
| `OPENAI_API_KEY` | OpenAI (GPT) | Yes |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Google (Gemini) | Yes |
| `OLLAMA_HOST` or `OLLAMA_BASE_URL` | Ollama server URL (default: `http://localhost:11434`) | No |
| `OLLAMA_API_KEY` | Ollama auth (for remote/proxied instances) | No |
| `OLLAMA_MODEL` | Default Ollama model name | No |

Ollama is registered automatically when `OLLAMA_HOST`/`OLLAMA_BASE_URL` is set, or as a local fallback when no cloud provider keys are configured.

## Project Structure

```
src/
├── llm/                  # Layer 1: Unified LLM Client
│   ├── types.ts          # Data model (Message, Request, Response, etc.)
│   ├── catalog.ts        # Model catalog
│   ├── adapter.ts        # Provider adapter interface
│   ├── providers/        # Provider implementations
│   │   ├── anthropic.ts  # Anthropic Messages API
│   │   ├── openai.ts     # OpenAI Responses API
│   │   ├── gemini.ts     # Google Gemini API
│   │   └── ollama.ts     # Ollama (local models, Chat Completions API)
│   ├── client.ts         # Client with routing & middleware
│   └── generate.ts       # High-level API (generate, stream, generate_object)
├── agent/                # Layer 2: Coding Agent Loop
│   ├── types.ts          # Session, Turn, Event types
│   ├── session.ts        # Core agentic loop
│   ├── execution-env.ts  # Execution environment abstraction
│   ├── tools.ts          # Core tools (read/write/edit/shell/grep/glob)
│   ├── profiles.ts       # Provider-specific profiles
│   ├── loop-detection.ts # Loop detection via Jaccard similarity
│   └── truncation.ts     # Output truncation
├── pipeline/             # Layer 3: Pipeline Engine
│   ├── dot-parser.ts     # DOT language parser
│   ├── types.ts          # Graph model types
│   ├── graph-builder.ts  # DOT AST → PipelineGraph
│   ├── validator.ts      # Graph validation & linting
│   ├── engine.ts         # Execution engine
│   ├── handlers.ts       # Node handlers (codergen, conditional, etc.)
│   ├── conditions.ts     # Condition expression evaluator
│   ├── stylesheet.ts     # CSS-like model stylesheet
│   └── human.ts          # Human-in-the-loop system
└── index.ts              # Entry point & public API
```

## License

Apache-2.0
